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
  const { dest, port } = splitTarget(target);
  return [
    "ssh", "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    ...(port ? ["-p", port] : []),
    "-L", `127.0.0.1:${local}:${far}:${remote}`,
    "--", dest,
  ];
}

/**
 * A Herdr machine target, "user@host", "host:2222" or "user@[::1]:2222", as
 * ssh's destination and port.
 * @param {string} target
 */
export function splitTarget(target) {
  const m = /^(.*?)(?::(\d+))?$/.exec(target.trim());
  let dest = m?.[1] ?? target;
  const port = m?.[2] ?? null;
  // A bare IPv6 address has colons of its own: only a bracketed one takes a port.
  if (port && dest.includes(":") && !dest.includes("]")) return { dest: target, port: null };
  dest = dest.replace(/\[([^\]]+)\]$/, "$1").replace(/@\[([^\]]+)\]$/, "@$1");
  return { dest, port };
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

/** Scans in a row a server must be missing before its tunnel goes: a dev server restarting is gone for a moment. */
export const GONE_AFTER = 3;

/**
 * What auto-forward should do now, given what's listening on each machine and
 * which tunnels exist. Pure: the Ports mod acts on the answer.
 * - start: servers from Herdr terminals with no live tunnel, unless stopped by hand
 * - stop: live tunnels whose server has been gone for GONE_AFTER scans, or whose
 *   machine has no spaces any more
 * - remove: tunnels that ended (ssh died: sleep, network); they start again
 * - forget: "stopped by hand" marks for machines that are gone
 * A server stopped by hand stays stopped across its restarts, until forwarded again.
 * @param {{
 *   listening: Map<string, import("./ports.js").Port[]>,
 *   forwards: Forward[],
 *   stopped: Set<string>,
 *   auto: boolean,
 *   pending?: Set<string>,
 *   machines?: Set<string>,
 *   missing?: Map<string, number>,
 * }} state  listening: machine -> its ports (remote machines, scanned now);
 *   machines: every machine that has spaces; missing: "machine:port" -> scans in a row its server was absent
 * @returns {{ start: { machine: string, port: import("./ports.js").Port }[], stop: Forward[], remove: Forward[], forget: string[] }}
 */
export function planForwards({ listening, forwards, stopped, auto, pending = new Set(), machines, missing = new Map() }) {
  /** @type {{ machine: string, port: import("./ports.js").Port }[]} */
  const start = [];
  const known = machines ?? new Set(listening.keys());
  const live = forwards.filter((f) => f.live);
  const remove = forwards.filter((f) => !f.live);
  const tunnels = new Set(live.map((f) => `${f.machine}:${f.remote}`));
  for (const [machine, ports] of listening) {
    for (const p of ports) {
      const key = `${machine}:${p.port}`;
      if (!auto || p.internal || tunnels.has(key) || stopped.has(key) || pending.has(key)) continue;
      start.push({ machine, port: p });
    }
  }
  const stop = live.filter((f) => !known.has(f.machine)
    || (listening.has(f.machine) && (missing.get(`${f.machine}:${f.remote}`) ?? 0) >= GONE_AFTER));
  const forget = [...stopped].filter((key) => !known.has(key.slice(0, key.lastIndexOf(":"))));
  return { start, stop, remove, forget };
}

/**
 * Counts, per tunnel, the scans in a row its server was missing.
 * @param {Map<string, number>} missing  updated in place
 * @param {Map<string, import("./ports.js").Port[]>} listening  machines scanned now
 * @param {Forward[]} forwards
 */
export function countMissing(missing, listening, forwards) {
  const seen = new Set();
  for (const f of forwards) {
    const key = `${f.machine}:${f.remote}`;
    seen.add(key);
    const ports = listening.get(f.machine);
    if (!ports) continue;
    if (ports.some((p) => p.port === f.remote)) missing.delete(key);
    else missing.set(key, (missing.get(key) ?? 0) + 1);
  }
  for (const key of [...missing.keys()]) if (!seen.has(key)) missing.delete(key);
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
