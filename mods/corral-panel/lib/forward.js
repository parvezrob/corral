// Generated from lib/forward.js by scripts/build.mjs. Edit the source, not this copy.
// Port forwards from this computer to a machine, as ssh -L tunnels that run in
// herdr-core terminals (kept alive across app restarts, found again by label).
// Pure: no Herdr imports, unit-tested in Node.

/** Label keys on a forward's terminal. */
export const LABEL = {
  /** "<machine>:<remote port>" */
  forward: "corral.forward",
  /** the port on this computer */
  local: "corral.local",
};

/**
 * The ssh command for one tunnel: this computer's 127.0.0.1:<local> to
 * <host>:<remote> as seen from the machine. BatchMode: never prompt (no one can
 * answer inside a background terminal). ExitOnForwardFailure: a busy local port
 * ends ssh at once instead of leaving a tunnel that forwards nothing.
 * @param {{ target: string, local: number, remote: number, host?: string }} f
 * @returns {string[]}
 */
export function sshArgs({ target, local, remote, host = "127.0.0.1" }) {
  const far = host.includes(":") ? `[${host}]` : host;
  return [
    "ssh", "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${local}:${far}:${remote}`,
    target,
  ];
}

/**
 * The terminal name for a forward: unique among live terminals, as hc requires,
 * because a local port can carry only one tunnel. hc names: 1-32 of a-z 0-9 - _.
 * @param {number} local
 */
export function terminalName(local) {
  return `corral-fwd-${local}`;
}

/**
 * The first port at or above `wanted` that isn't busy here, trying `span` ports.
 * Same number first, so localhost URLs, cookies and OAuth callbacks keep working.
 * @param {number} wanted
 * @param {Set<number>} busy
 * @param {number} [span]
 * @returns {number | null}
 */
export function pickLocalPort(wanted, busy, span = 20) {
  for (let p = wanted; p < wanted + span && p <= 65535; p++) if (!busy.has(p)) return p;
  return null;
}

/**
 * @typedef {object} Forward
 * @property {string} address      the tunnel's terminal
 * @property {string} machine
 * @property {number} remote
 * @property {number} local
 * @property {boolean} live
 */

/**
 * Finds our tunnels among herdr-core terminals (Herdr's terminals() list, or
 * hc's JSON): those labelled corral.forward.
 * @param {any[]} terminals
 * @returns {Forward[]}
 */
export function forwardsFrom(terminals) {
  /** @type {Forward[]} */
  const out = [];
  for (const t of terminals ?? []) {
    const spec = t?.labels?.[LABEL.forward];
    const local = Number(t?.labels?.[LABEL.local]);
    if (typeof spec !== "string" || !Number.isInteger(local)) continue;
    const at = spec.lastIndexOf(":");
    const remote = Number(spec.slice(at + 1));
    if (at <= 0 || !Number.isInteger(remote)) continue;
    out.push({ address: t.address, machine: spec.slice(0, at), remote, local, live: t.state === "live" || t.state === undefined });
  }
  return out;
}

/**
 * What auto-forward should do now, given what's listening on each machine and
 * which tunnels exist. Pure: the Ports mod acts on the answer.
 * - start: servers from Herdr terminals with no tunnel, unless stopped by hand
 * - stop: tunnels whose server is gone (the tunnel would forward to nothing)
 * - forget: "stopped by hand" marks whose server is gone, so a restart forwards again
 * @param {{
 *   listening: Map<string, import("./ports.js").Port[]>,
 *   forwards: Forward[],
 *   stopped: Set<string>,
 *   auto: boolean,
 *   pending?: Set<string>,
 * }} state  listening: machine name -> its ports (remote machines only, fully scanned)
 * @returns {{ start: { machine: string, port: import("./ports.js").Port }[], stop: Forward[], forget: string[] }}
 */
export function planForwards({ listening, forwards, stopped, auto, pending = new Set() }) {
  /** @type {{ machine: string, port: import("./ports.js").Port }[]} */
  const start = [];
  /** @type {Forward[]} */
  const stop = [];
  /** @type {string[]} */
  const forget = [];
  const tunnels = new Map(forwards.map((f) => [`${f.machine}:${f.remote}`, f]));
  for (const [machine, ports] of listening) {
    const open = new Set(ports.map((p) => p.port));
    for (const p of ports) {
      const key = `${machine}:${p.port}`;
      if (!auto || p.internal || tunnels.has(key) || stopped.has(key) || pending.has(key)) continue;
      start.push({ machine, port: p });
    }
    for (const f of forwards) if (f.machine === machine && f.live && !open.has(f.remote)) stop.push(f);
    for (const key of stopped) {
      const at = key.lastIndexOf(":");
      if (key.slice(0, at) === machine && !open.has(Number(key.slice(at + 1)))) forget.push(key);
    }
  }
  return { start, stop, forget };
}

/**
 * Ports listening on this computer, from `lsof -nP -iTCP -sTCP:LISTEN -Fn`
 * (macOS and Linux both have it): lines like "n127.0.0.1:5173" or "n*:22".
 * @param {string} stdout
 * @returns {Set<number>}
 */
export function parseLsofListen(stdout) {
  const busy = new Set();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) busy.add(port);
  }
  return busy;
}
