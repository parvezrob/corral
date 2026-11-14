// The corral status bar: where you are (machine, branch), agents, live port
// forwards, and the command palette hint. Herdr's own status facts, plus ours.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, run, window, keys, nextCommand, shared, setShared, openOverlay, closeOverlay } from "herdr";
import { colors } from "./lib/theme.js";
import { forwardsFrom } from "./lib/forward.js";
import { openPanel } from "./lib/panel.js";
import { openUrl, sh } from "./lib/host.js";
import { here } from "./lib/context.js";
import { USAGE_SCRIPT, USER_AGENT, parseUsage, chipText, worst, level, shownProviders, popoverHeight } from "./lib/usage.js";

const POPOVER_WIDTH = 360;

const USAGE_EVERY_MS = 5 * 60e3;

/** The palette key as actually bound, so the hint never lies. */
function paletteHint() {
  const mac = window()?.platform === "macos";
  /** @type {Record<string, string>} */
  const names = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
  if (!b) return "commands";
  const parts = b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b.keys.split("-");
  return `${parts.map((p) => names[p.toLowerCase()] ?? p.toUpperCase()).join("")}  commands`;
}

/** @typedef {{ number: number, state: string, checks: string, failing: number, threads: number, ready: boolean, review: boolean }} PrSummary */

export default class Status extends View {
  /** "PR #14 · 1 failing", coloured by what needs doing. @param {Record<string, any>} t @param {PrSummary} pr */
  prChip(t, pr) {
    const [text, color] = pr.state === "merged" ? ["merged", t.ansi5]
      : pr.state === "closed" ? ["closed", t.dim]
      : pr.failing ? [`${pr.failing} failing`, t.ansi1]
      : pr.checks === "running" ? ["checks running", t.blocked]
      : pr.threads ? [`${pr.threads} ${pr.threads === 1 ? "thread" : "threads"} open`, t.blocked]
      : pr.ready ? ["ready to merge", t.ansi2]
      : pr.review ? ["awaiting review", t.blocked]
      : pr.state === "draft" ? ["draft", t.dim]
      : ["open", t.muted];
    return h_flex().id("corral-status-pr").gap(6).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click(() => openPanel("pr"))
      .child(svg("mods/corral-status/pr.svg").size(13))
      .child(`PR #${pr.number}`)
      .child(div().text_color(color).child(`· ${text}`));
  }

  /** The status bar is always on screen, so mod commands sent from toasts land here. @param {any} _props @param {any} cx */
  init(_props, cx) {
    /** @type {Map<string, { at: number, data: import("./lib/usage.js").Usage }>} usage by machine ("" = this computer) */
    this.usage = new Map();
    /** @type {string | null} */ this.fetching = null;
    /** @type {{ x: number, y: number, width: number, height: number } | null} the chip last pressed */ this.chip = null;
    /** @type {string | null} */ this.popover = null;
    cx.timer.every(15000, (/** @type {any} */ cx) => this.usageTick(cx, false));
    this.usageTick(cx, false);
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "usage-refresh") { this.usageTick(cx, true); continue; }
        if (command === "usage-reopen") { this.openUsage(true); continue; }
        if (command.startsWith("usage-closed:")) { if (command.slice(13) === this.popover) this.popover = null; continue; }
        // "usage-at:x,y,w,h" opens it above a box at those window coordinates (scripts, tests).
        const box = /^usage-at:([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(command);
        if (box) { this.chip = { x: +box[1], y: +box[2], width: +box[3], height: +box[4] }; this.openUsage(false); continue; }
        const port = /^open-(\d+)$/.exec(command);
        if (port) openUrl(`http://localhost:${port[1]}`);
        else if (command.startsWith("panel-")) openPanel(command.slice(6));
      }
    });
  }

  /**
   * Usage for the machine your agents are on (the shown space's), every few
   * minutes or on demand. Shared so the popover can draw it.
   * @param {any} cx @param {boolean} force
   */
  usageTick(cx, force) {
    const machine = here().machine;
    const key = machine ?? "";
    const have = this.usage.get(key);
    const published = /** @type {{ machine: string | null } | null} */ (shared("corral.usage"));
    if (have && (published?.machine ?? null) !== machine) this.publishUsage(machine, have.at, have.data, false);
    if (this.fetching !== null || (!force && have && Date.now() - have.at < USAGE_EVERY_MS)) return;
    this.fetching = key;
    if (have) this.publishUsage(machine, have.at, have.data, true);
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const r = await sh(machine, USAGE_SCRIPT, [USER_AGENT], { timeout: 40000 });
        const data = parseUsage(r.stdout);
        const at = Date.now();
        this.usage.set(key, { at, data });
        if ((here().machine ?? "") === key) this.publishUsage(machine, at, data, false);
      } catch {
        // Unreachable machine: keep what we had; the next tick tries again.
        if (have) this.publishUsage(machine, have.at, have.data, false);
      } finally {
        this.fetching = null;
        cx.notify();
      }
    });
  }

  /** @param {string | null} machine @param {number} at @param {import("./lib/usage.js").Usage} data @param {boolean} fetching */
  publishUsage(machine, at, data, fetching) {
    setShared("corral.usage", { machine, at, claude: data.claude, codex: data.codex, fetching });
  }

  /**
   * The usage popover, right above the chip that was pressed, its right edge on
   * the chip's, at the height its content needs.
   * @param {boolean} reopen  replace the open one (its view changed)
   * @returns {void}
   */
  openUsage(reopen) {
    const open = this.popover;
    if (open) { closeOverlay(open); this.popover = null; }
    // A second click on a chip closes it; a reopen needs one open.
    if (open ? !reopen : reopen) return;
    const height = popoverHeight(/** @type {any} */ (shared("corral.usage")), shared("corral.usage.mode") === "compact");
    const b = this.chip;
    const at = b ? { x: Math.max(8, Math.round(b.x + b.width - POPOVER_WIDTH)), y: Math.max(8, Math.round(b.y - height - 6)) } : "pointer";
    this.popover = openOverlay({ mod: "corral-usage", kind: "popup", width: POPOVER_WIDTH, height, at });
  }

  /** "Claude 42% wk", coloured as it fills up. @param {Record<string, any>} t @param {import("./lib/usage.js").Provider} p */
  usageChip(t, p) {
    const w = worst(p);
    const lv = w ? level(w.percent) : "normal";
    return h_flex().id(`corral-status-${p.id}`).gap(5).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (/** @type {any} */ e) => {
        // The chip's box in the window: where the press was, minus where in the chip it was.
        const local = e.local_position ?? { x: 0, y: 0 };
        this.chip = { x: e.position.x - local.x, y: e.position.y - local.y, width: e.bounds?.width ?? 0, height: e.bounds?.height ?? 0 };
      })
      .on_click(() => this.openUsage(false))
      .child(div().text_color(t.foreground).child(p.name))
      .child(div().text_color(lv === "high" ? t.ansi1 : lv === "warn" ? t.blocked : t.muted).child(w ? chipText(p) : "?"));
  }

  render() {
    const t = colors();
    const usage = /** @type {{ claude: import("./lib/usage.js").Provider, codex: import("./lib/usage.js").Provider } | null} */ (shared("corral.usage"));
    // A provider gets a chip once it has numbers, or a problem worth a look (not "not installed").
    const chips = shownProviders(usage).filter((p) => p.limits.length || !/Not signed in/.test(p.error ?? ""));
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const forwards = forwardsFrom(terminals()).filter((f) => f.live).length;
    const pr = /** @type {PrSummary | null} */ (shared("corral.pr"));
    /** @param {string} icon @param {string} text */
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/corral-status/${icon}.svg`).size(13)).child(text);
    return h_flex().id("corral-status").size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .when(Boolean(pr), (el) => el.child(this.prChip(t, /** @type {PrSummary} */ (pr))))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .children(chips.map((p) => this.usageChip(t, p)))
      .when(forwards > 0, (el) => el.child(h_flex().id("corral-status-ports").gap(6).items_center().cursor_pointer().text_color(t.foreground)
        .hover((s) => s.text_color(t.accent))
        .on_click(() => openPanel("ports"))
        .child(svg("mods/corral-status/ports.svg").size(13)).child(`${forwards} ${forwards === 1 ? "port" : "ports"}`)))
      .child(div().id("corral-status-palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(paletteHint()));
  }
}
