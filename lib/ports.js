// Listening-port discovery on a Linux machine. Pure: no Herdr imports,
// unit-tested in Node. The script runs on the machine; the parsers run here.
import { SECTION, splitSections } from "./sh.js";

/**
 * Prints `ss -ltnpH` (listening TCP sockets with their processes), a section
 * separator, then for each listening pid: pid TAB HC_TERMINAL_ID TAB cmdline.
 * Every process started in a herdr-core terminal inherits HC_TERMINAL_ID, which
 * ties a port to the Herdr terminal (and so the space and tab) that started it.
 * Only the user's own processes are visible, which is what we want.
 * Exit 3: no `ss` on this machine.
 */
export const PORT_SCAN = String.raw`command -v ss >/dev/null 2>&1 || exit 3
out=$(ss -ltnpH 2>/dev/null)
printf '%s\n' "$out"
printf '\036\n'
printf '%s\n' "$out" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -un | while read -r pid; do
  t=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^HC_TERMINAL_ID=//p' | head -n 1)
  c=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-300)
  printf '%s\t%s\t%s\n' "$pid" "$t" "$c"
done`;

/** Programs whose own sockets are internals (an agent's local API), never dev servers. */
const AGENT_PROCESSES = new Set(["claude", "codex", "gemini", "opencode", "cursor-agent", "amp", "droid", "copilot", "kiro", "pi", "grok", "qwen", "herdr", "hc", "herdr-core"]);

/**
 * @typedef {"loopback" | "all" | "tailnet" | "other"} Scope
 * @typedef {{ name: string, pid: number }} SocketProcess
 * @typedef {{ port: number, host: string, scope: Scope, processes: SocketProcess[] }} Socket
 */

/**
 * Where a listening address can be reached from.
 * @param {string} host
 * @returns {Scope}
 */
export function scopeOf(host) {
  const h = host.toLowerCase();
  if (h === "*" || h === "0.0.0.0" || h === "::") return "all";
  if (h === "::1" || h === "localhost" || /^127\./.test(h)) return "loopback";
  const v4 = /^100\.(\d+)\./.exec(h);
  if (v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127) return "tailnet"; // 100.64.0.0/10
  if (h.startsWith("fd7a:115c:a1e0:")) return "tailnet";
  return "other";
}

/**
 * Parses `ss -ltnpH` lines, e.g.
 * LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4242,fd=23))
 * @param {string} text
 * @returns {Socket[]}
 */
export function parseSs(text) {
  /** @type {Socket[]} */
  const out = [];
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "LISTEN") continue;
    const local = cols[3];
    const colon = local.lastIndexOf(":");
    const port = Number(local.slice(colon + 1));
    if (colon < 0 || !Number.isInteger(port) || port <= 0) continue;
    // 127.0.0.1, *, [::1], 100.64.1.2%tailscale0, [fe80::1]%eth0: drop the interface, then the brackets.
    const host = local.slice(0, colon).replace(/%[^%\]]*$/, "").replace(/^\[(.*)\]$/, "$1");
    const processes = [];
    for (const m of cols.slice(5).join(" ").matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g)) processes.push({ name: m[1], pid: Number(m[2]) });
    out.push({ port, host, scope: scopeOf(host), processes });
  }
  return out;
}

/**
 * @typedef {object} Port
 * @property {number} port
 * @property {string[]} hosts           addresses it listens on
 * @property {boolean} direct           also reachable over the tailnet as is (no forward needed)
 * @property {string} forwardHost       what an ssh -L should connect to on that machine
 * @property {string | null} terminal   HC_TERMINAL_ID of the process, e.g. "t7"
 * @property {number | null} pid
 * @property {string} process           process name as ss reports it
 * @property {string} cmd               its command line (first 300 chars)
 * @property {string} app               a name for people: "Vite", "Next.js", or the program
 * @property {boolean} internal         an agent's or Herdr's own socket, or not from a Herdr terminal
 */

/**
 * Parses PORT_SCAN's output into one entry per port, sorted by port.
 * @param {string} stdout
 * @returns {Port[]}
 */
export function parsePortScan(stdout) {
  const [ssText = "", procText = ""] = splitSections(stdout);
  /** @type {Map<number, { terminal: string | null, cmd: string }>} */
  const procs = new Map();
  for (const line of procText.split("\n")) {
    const [pid, terminal, ...cmd] = line.split("\t");
    if (!/^\d+$/.test(pid ?? "")) continue;
    procs.set(Number(pid), { terminal: terminal || null, cmd: cmd.join("\t").trim() });
  }
  /** @type {Map<number, Port>} */
  const byPort = new Map();
  for (const s of parseSs(ssText)) {
    let p = byPort.get(s.port);
    if (!p) {
      p = { port: s.port, hosts: [], direct: false, forwardHost: "127.0.0.1", terminal: null, pid: null, process: "", cmd: "", app: "", internal: true };
      byPort.set(s.port, p);
    }
    if (!p.hosts.includes(s.host)) p.hosts.push(s.host);
    if (s.scope === "all" || s.scope === "tailnet") p.direct = true;
    for (const proc of s.processes) {
      if (p.pid !== null && p.terminal) break;
      const info = procs.get(proc.pid);
      if (p.pid === null || (!p.terminal && info?.terminal)) {
        p.pid = proc.pid;
        p.process = proc.name;
        p.terminal = info?.terminal ?? null;
        p.cmd = info?.cmd ?? "";
      }
    }
  }
  for (const p of byPort.values()) {
    p.forwardHost = forwardHostFor(p.hosts);
    p.app = appName(p.cmd, p.process);
    p.internal = !p.terminal || AGENT_PROCESSES.has(p.process.toLowerCase());
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/**
 * The address an ssh tunnel should reach on the far side: IPv4 loopback when the
 * server listens there (or everywhere), else IPv6 loopback (Node's "localhost"
 * can resolve to ::1 only), else the one address it has.
 * @param {string[]} hosts
 * @returns {string}
 */
export function forwardHostFor(hosts) {
  if (hosts.some((h) => h === "0.0.0.0" || h === "*" || /^127\./.test(h))) return "127.0.0.1";
  if (hosts.some((h) => h === "::1" || h === "::")) return "::1";
  return hosts[0] ?? "127.0.0.1";
}

/** @type {[RegExp, string][]} */
const APPS = [
  [/\bvite(\.js)?\b/, "Vite"],
  [/\bnext(-server|\/dist\/| dev| start|\b.*\bdev\b)/, "Next.js"],
  [/\bstorybook\b/, "Storybook"],
  [/\bastro\b/, "Astro"],
  [/\bnuxi?\b/, "Nuxt"],
  [/\bremix\b/, "Remix"],
  [/\bsvelte-kit\b/, "SvelteKit"],
  [/\bwebpack(-dev-server| serve)\b/, "webpack"],
  [/\bwrangler\b/, "Wrangler"],
  [/\bexpo\b/, "Expo"],
  [/\bjupyter\b/, "Jupyter"],
  [/\bmkdocs\b/, "MkDocs"],
  [/\bhugo\b/, "Hugo"],
  [/\bdocusaurus\b/, "Docusaurus"],
  [/\bmanage\.py runserver\b/, "Django"],
  [/\buvicorn\b/, "Uvicorn"],
  [/\bgunicorn\b/, "Gunicorn"],
  [/\bflask\b/, "Flask"],
  [/\bhttp\.server\b/, "Python http.server"],
  [/\brails\b|\bpuma\b/, "Rails"],
  [/\bphp\b.*\s-S\s/, "PHP server"],
  [/\bcargo(-watch)? (run|watch)\b|\btrunk serve\b/, "Rust"],
  [/\bgo run\b|\bair\b/, "Go"],
  [/\bpostgres\b/, "PostgreSQL"],
  [/\bredis-server\b/, "Redis"],
];

/**
 * A name for people from a command line: the framework when it's recognisable,
 * else the program.
 * @param {string} cmd
 * @param {string} [process]
 * @returns {string}
 */
export function appName(cmd, process = "") {
  for (const [re, name] of APPS) if (re.test(cmd)) return name;
  const first = cmd.split(" ")[0] ?? "";
  const base = first.split("/").pop() || process;
  return base || "Server";
}

/** For tests and callers that print sections themselves. */
export { SECTION };
