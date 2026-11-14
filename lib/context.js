// Where the panels point: the shown space, the machine it lives on, and the
// folder its work is in now.
import { spaces, panes, focused } from "herdr";

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
