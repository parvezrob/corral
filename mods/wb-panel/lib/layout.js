// Generated from lib/layout.js by scripts/build.mjs. Edit the source, not this copy.
// The workbench layout's node ids, and helpers to read the layout tree. Pure.

/** Node ids in layouts/workbench.json that mods address. */
export const IDS = {
  /** The right-hand column: tab strip and stack. */
  panel: "panel",
  /** The stack whose children are the panel's tabs. "files" and "changes" keep
   *  Herdr's ids, so the tab bar's own Files and Changes buttons open ours. */
  stack: "panel-body",
};

/**
 * Finds a node by id anywhere in a layout tree.
 * @param {any} node
 * @param {string} id
 * @returns {any}
 */
export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * The panel's state from a layout tree: which tabs it has, which one shows, and
 * whether the panel is open at all.
 * @param {any} root
 * @returns {{ tabs: string[], active: string | null, open: boolean }}
 */
export function panelState(root) {
  const panel = findNode(root, IDS.panel);
  const stack = findNode(root, IDS.stack);
  const tabs = (stack?.children ?? []).map((/** @type {any} */ c) => c.id).filter(Boolean);
  return { tabs, active: stack?.active ?? tabs[0] ?? null, open: Boolean(panel) && !panel.hidden };
}
