// The corral panel's tab strip: one tab per child of the panel stack, in the
// layout's order, with live counts. Adding a tab is a layout change only.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, terminals, shared } from "herdr";
import { colors, CLEAR } from "./lib/theme.js";
import { panelState } from "./lib/layout.js";
import { forwardsFrom } from "./lib/forward.js";
import { openPanel, closePanel } from "./lib/panel.js";

/** @type {Record<string, { label: string, icon: string }>} */
const TABS = {
  files: { label: "Files", icon: "files" },
  changes: { label: "Changes", icon: "changes" },
  pr: { label: "PR", icon: "pr" },
  ports: { label: "Ports", icon: "ports" },
};

export default class PanelTabs extends View {
  /** @param {string} id */
  badge(id) {
    if (id === "ports") return forwardsFrom(terminals()).filter((f) => f.live).length;
    if (id === "changes") return Number(shared("corral.changes.count")) || 0;
    return 0;
  }

  render() {
    const t = colors();
    const { tabs, active } = panelState(layout());
    const stop = (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation();
    return h_flex().id("corral-panel").size_full().px(6).gap(2).items_center().border_b(1).border_color(t.border).text_size(12.5)
      .children(tabs.map((id) => {
        const spec = TABS[id] ?? { label: id, icon: "files" };
        const on = id === active;
        const count = this.badge(id);
        return h_flex().id(`corral-tab-${id}`).h_full().px(9).gap(6).items_center().flex_none().cursor_pointer()
          .border_b(2).border_color(on ? t.accent : CLEAR)
          .text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_medium())
          .hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click(() => openPanel(id))
          .child(svg(`mods/corral-panel/${spec.icon}.svg`).size(14))
          .child(spec.label)
          .when(count > 0, (el) => el.child(div().px(5).rounded(7).bg(t.raised).text_size(11).text_color(t.foreground).child(String(count))));
      }))
      .child(div().flex_1())
      .child(div().id("corral-panel-close").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click(() => closePanel())
        .child(svg("mods/corral-panel/close.svg").size(13)));
  }
}
