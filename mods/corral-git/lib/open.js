// Generated from lib/open.js by scripts/build.mjs. Edit the source, not this copy.
// Opening a file or a diff in the viewer pane, beside the terminal.
//
// A tab gets one viewer: the first open splits the tab's terminal to the right
// with a corral-view pane; later opens send that viewer a request through shared
// state (it re-renders on every shared change and loads anything newer than what
// it shows). Shared keys: "corral.views" maps tab id -> viewer id; "corral.view.<id>"
// holds that viewer's latest request.
import { panes, focused, shared, setShared, run, spaces } from "herdr";
import { basename } from "./paths.js";

export const VIEW_MOD = "corral-view";
const VIEWS_KEY = "corral.views";

/**
 * @typedef {object} ViewRequest
 * @property {string} path            absolute, on `machine`
 * @property {string | null} machine  null: this computer
 * @property {string | null} root     the repo or folder it belongs to (for git and short paths)
 * @property {"file" | "diff"} mode
 * @property {"staged" | "unstaged" | "untracked" | "head"} [diff]  which change a diff shows
 * @property {number} [seq]           newer requests win
 */

/** @param {string} viewId */
export function requestKey(viewId) {
  return `corral.view.${viewId}`;
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Shows a file or diff in the current tab's viewer, splitting one off to the
 * right of the terminal when the tab has none; or in a new Herdr tab.
 * @param {ViewRequest} request
 * @param {{ newTab?: boolean }} [options]
 */
export function openView(request, options = {}) {
  const seq = Date.now();
  const f = focused();
  if (options.newTab || !f?.tab) {
    run("tab.new", { mod: VIEW_MOD, name: basename(request.path), props: { ...request, viewId: newId(), seq } });
    return;
  }
  const tab = f.tab;
  const all = panes();
  const views = /** @type {Record<string, string>} */ (shared(VIEWS_KEY) ?? {});
  const viewer = all.find((p) => p.tab === tab && p.mod === VIEW_MOD);
  if (viewer && views[tab]) {
    setShared(requestKey(views[tab]), { ...request, seq });
    return;
  }
  const anchor = all.find((p) => p.pane === f.pane && p.terminal) ?? all.find((p) => p.tab === tab && p.terminal);
  const viewId = newId();
  // Forget viewers of tabs that are gone.
  const live = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
  /** @type {Record<string, string>} */
  const next = {};
  for (const [t, id] of Object.entries(views)) if (live.has(t)) next[t] = id;
  next[tab] = viewId;
  setShared(VIEWS_KEY, next);
  run("pane.split", { direction: "right", pane: anchor?.pane, mod: VIEW_MOD, props: { ...request, viewId, seq } });
}
