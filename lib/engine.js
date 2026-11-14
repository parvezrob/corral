// Ports and PR do work in the background (auto-forward, the status bar's PR
// chip), but Herdr starts a mod copy only the first time it shows. The status
// bar, always on screen, wakes the ones that haven't run since this launch by
// showing their tab for a moment, then puts the panel back as it was.
import { run, layout, shared, setShared } from "herdr";
import { IDS, panelState } from "./layout.js";

const BOOT_KEY = "corral.boot";
const ALIVE_KEY = "corral.alive";
/** Panel tabs that run in the background. */
export const ENGINES = ["ports", "pr"];

/** A new launch: a token engines echo once they run. Called by the status bar's init. */
export function newBoot() {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  setShared(BOOT_KEY, token);
  return token;
}

/** An engine's tick: says it runs in this launch. Writes only when it changes. @param {string} name */
export function markAlive(name) {
  const boot = shared(BOOT_KEY);
  const alive = /** @type {Record<string, unknown>} */ (shared(ALIVE_KEY) ?? {});
  if (boot && alive[name] !== boot) setShared(ALIVE_KEY, { ...alive, [name]: boot });
}

/** The engines that haven't said they run since `boot`. @param {string} boot */
export function asleep(boot) {
  const alive = /** @type {Record<string, unknown>} */ (shared(ALIVE_KEY) ?? {});
  return ENGINES.filter((n) => alive[n] !== boot);
}

/**
 * Shows each tab for a moment so its copy starts, then restores the panel.
 * @param {string[]} tabs @param {any} cx
 */
export function wake(tabs, cx) {
  if (!tabs.length) return;
  const before = panelState(layout());
  if (!before.tabs.length) return;  // not the corral layout
  const list = tabs.filter((t) => before.tabs.includes(t));
  let i = 0;
  const step = (/** @type {any} */ cx) => {
    if (i < list.length) {
      run("layout.select", { stack: IDS.stack, child: list[i++] });
      if (!before.open) run("layout.show", { id: IDS.panel });
      cx.timer.after(250, step);
      return;
    }
    if (before.active) run("layout.select", { stack: IDS.stack, child: before.active });
    if (!before.open) run("layout.hide", { id: IDS.panel });
  };
  step(cx);
}
