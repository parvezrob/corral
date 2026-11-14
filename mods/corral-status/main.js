// The corral status bar: where you are (machine, branch), agents, live port
// forwards, and the command palette hint. Herdr's own status facts, plus ours.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, run, window, keys, nextCommand, shared } from "herdr";
import { colors } from "./lib/theme.js";
import { forwardsFrom } from "./lib/forward.js";
import { openPanel } from "./lib/panel.js";
import { openUrl } from "./lib/host.js";

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
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        const port = /^open-(\d+)$/.exec(command);
        if (port) openUrl(`http://localhost:${port[1]}`);
        else if (command.startsWith("panel-")) openPanel(command.slice(6));
      }
    });
  }

  render() {
    const t = colors();
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
      .when(forwards > 0, (el) => el.child(h_flex().id("corral-status-ports").gap(6).items_center().cursor_pointer().text_color(t.foreground)
        .hover((s) => s.text_color(t.accent))
        .on_click(() => openPanel("ports"))
        .child(svg("mods/corral-status/ports.svg").size(13)).child(`${forwards} ${forwards === 1 ? "port" : "ports"}`)))
      .child(div().id("corral-status-palette").text_color(t.dim).cursor_pointer().on_click(() => run("app.palette")).child(paletteHint()));
  }
}
