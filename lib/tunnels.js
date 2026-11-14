// Starting and stopping ssh tunnels on this computer, as herdr-core terminals.
// herdr-core keeps them running across app restarts; their labels find them again.
import { exec, hc } from "herdr";
import { hcJson, CommandError } from "./host.js";
import { sshArgs, terminalName, parseLsofListen, LABEL } from "./forward.js";

/**
 * How this computer reaches each machine: name -> ssh target, or null when the
 * machine is reached through a custom command (`hc machine add --via`), which a
 * tunnel can't use.
 * @returns {Promise<Map<string, string | null>>}
 */
export async function machineTargets() {
  const out = await hcJson(["machine", "ls"]);
  const map = new Map();
  for (const m of out?.machines ?? []) map.set(m.name, m.via ? null : m.target);
  return map;
}

/** Ports something already listens on here. @returns {Promise<Set<number>>} */
export async function localBusyPorts() {
  const r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]).catch(() => /** @type {null} */ (null));
  return r ? parseLsofListen(r.stdout) : new Set();
}

/**
 * Starts a tunnel: this computer's 127.0.0.1:<local> to <host>:<remote> on the machine.
 * @param {{ machine: string, target: string, local: number, remote: number, host: string }} t
 * @returns {Promise<string>} the tunnel terminal's address
 */
export async function startTunnel({ machine, target, local, remote, host }) {
  const r = await hc([
    "run", "--bg", "--json", "--no-parent", "--no-notify",
    "--name", terminalName(local),
    "--label", `${LABEL.forward}=${machine}:${remote}`,
    "--label", `${LABEL.local}=${local}`,
    "--", ...sshArgs({ target, local, remote, host }),
  ]);
  if (r.code !== 0) throw new CommandError("hc run ssh", r);
  const out = JSON.parse(r.stdout || "{}");
  return out.address ?? out.terminal ?? "";
}

/** Ends a tunnel and removes its terminal. @param {string} address */
export async function stopTunnel(address) {
  await hc(["kill", address]).catch(() => /** @type {null} */ (null));
  await hc(["rm", address]).catch(() => /** @type {null} */ (null));
}

/** The last lines a (failed) tunnel printed, e.g. ssh's error. @param {string} address */
export async function tunnelOutput(address) {
  const r = await hc(["read", address, "--lines", "8"]).catch(() => /** @type {null} */ (null));
  return (r?.stdout ?? "").trim().split("\n").filter(Boolean).slice(-3).join(" · ");
}
