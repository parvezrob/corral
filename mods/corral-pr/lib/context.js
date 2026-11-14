// Generated from lib/context.js by scripts/build.mjs. Edit the source, not this copy.
// Where the panels point: the shown space, the machine it lives on, and the
// folder its work is in now.
import { spaces, panes, focused } from "herdr";
import { sh } from "./host.js";

/**
 * @typedef {object} Here
 * @property {import("herdr").SpaceInfo | null} space
 * @property {string | null} machine  null: this computer
 * @property {string | null} cwd      the focused terminal's live folder, else the tab's, else the space's
 * @property {string} key             changes exactly when any of the above does
 */

/** @returns {Here} */
export function here() {
  const space = spaces().find((s) => s.active) ?? null;
  const f = focused();
  // A layout terminal block has no pane; its address names the machine ("vps/t7").
  const machine = f && f.pane === null && f.terminal?.includes("/") ? f.terminal.split("/")[0] : space?.machine ?? null;
  const all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  // A mod pane (a file view) has no folder: use a terminal in the same tab.
  const sibling = all.find((p) => p.tab === (pane?.tab ?? f?.tab) && p.terminal && p.cwd);
  const cwd = pane?.cwd || sibling?.cwd || f?.cwd || space?.folder || null;
  return { space, machine, cwd, key: JSON.stringify([space?.id ?? null, machine, cwd]) };
}

/** @type {Map<string, string>} "machine\0folder" -> repo top, for folders known to be in one */
const roots = new Map();

/**
 * The top of the git repo a folder is in, or null. Cached: switching between
 * terminals in one repo then costs no round trip.
 * @param {string | null} machine @param {string} cwd
 * @returns {Promise<string | null>}
 */
export async function repoRoot(machine, cwd) {
  const key = `${machine ?? ""}\0${cwd}`;
  const known = roots.get(key);
  if (known) return known;
  const r = await sh(machine, 'git -C "$1" rev-parse --show-toplevel 2>/dev/null', [cwd]).catch(() => /** @type {null} */ (null));
  const top = r?.stdout.trim() || null;
  if (top) {
    if (roots.size > 200) roots.clear();
    roots.set(key, top);
  }
  return top;
}
