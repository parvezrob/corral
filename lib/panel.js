// Opening and closing the workbench panel's tabs.
import { run, layout } from "herdr";
import { IDS, panelState } from "./layout.js";

/**
 * Shows one of the panel's tabs, opening the panel if it's closed.
 * @param {string} tab  a child id of the panel stack: files, changes, pr, ports
 */
export function openPanel(tab) {
  run("layout.select", { stack: IDS.stack, child: tab });
  run("layout.show", { id: IDS.panel });
}

/**
 * The tab bar's behaviour: a click on the shown tab closes the panel, any other
 * click shows that tab.
 * @param {string} tab
 */
export function togglePanel(tab) {
  const s = panelState(layout());
  if (s.open && s.active === tab) run("layout.hide", { id: IDS.panel });
  else openPanel(tab);
}

export function closePanel() {
  run("layout.hide", { id: IDS.panel });
}
