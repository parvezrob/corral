// Usage popover: Claude and Codex limits for the machine your agents run on,
// opened from the status bar chips. The status bar fetches; this only draws
// what it shared ("corral.usage"), detailed or compact.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { shared, setShared, run, nextCommand, props } from "herdr";
import { colors, alpha } from "./lib/theme.js";
import { pace, until, level, shownProviders } from "./lib/usage.js";

/** @typedef {import("./lib/usage.js").Provider} Provider */
/** @typedef {import("./lib/usage.js").Limit} Limit */
/** @typedef {{ machine: string | null, at: number, claude: Provider, codex: Provider, fetching?: boolean } | null} Shared */

/** Brand tiles, as in the design; the rest follows the theme. */
const TILE = { claude: /** @type {const} */ ("#e8a476"), codex: /** @type {const} */ ("#7cacf8") };

export default class UsagePopover extends View {
  /** @param {any} _props @param {any} cx */
  init(_props, cx) {
    // Tick so "Updated 2m ago" and the countdowns stay true while it's open.
    cx.timer.every(30000, (/** @type {any} */ cx) => cx.notify());
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "compact" || command === "detailed") this.setMode(command);
      }
    });
  }

  /** However it was closed (Esc, a click beside it, the chip), the status bar should know. */
  async close() {
    run(`corral-status.usage-closed:${props()?.overlay ?? ""}`);
  }

  get compact() { return shared("corral.usage.mode") === "compact"; }

  /** The other view has another height: the status bar reopens it, sized, in the same spot. @param {"compact" | "detailed"} mode */
  setMode(mode) {
    if ((mode === "compact") === this.compact) return;
    setShared("corral.usage.mode", mode);
    run("corral-status.usage-reopen");
  }

  /** @param {any} _cx */
  render(_cx) {
    const t = colors();
    const u = /** @type {Shared} */ (shared("corral.usage"));
    const providers = shownProviders(u);
    const ago = u ? until(Date.now() + (Date.now() - u.at)) : "";
    /** @param {string} id @param {string} label @param {boolean} on @param {() => void} click */
    const seg = (id, label, on, click) => div().id(id).h(22).px(9).flex().items_center().rounded(6).cursor_pointer()
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).on_click(click).child(label);
    return v_flex().id("corral-usage").size_full().overflow_y_scrollbar().p(14).gap(12).text_size(12.5).text_color(t.foreground)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(13.5).font_semibold().child("Usage"))
        .child(div().text_size(11.5).text_color(t.dim).child(!u ? "" : u.fetching ? "Updating…" : `Updated ${ago === "1m" && Date.now() - u.at < 60e3 ? "just now" : `${ago} ago`}`))
        .child(div().flex_1())
        .child(h_flex().p(2).gap(2).rounded(8).border_1().border_color(t.border).text_size(11.5)
          .child(seg("corral-usage-detailed", "Detailed", !this.compact, () => this.setMode("detailed")))
          .child(seg("corral-usage-compact", "Compact", this.compact, () => this.setMode("compact"))))
        .child(div().id("corral-usage-refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("corral-status.usage-refresh")).child("↻")))
      .when(!u, (el) => el.child(div().text_color(t.dim).child("Reading your limits…")))
      .when(Boolean(u) && !providers.length, (el) => el.child(div().text_color(t.dim).child("Neither Claude Code nor Codex is set up on this machine.")))
      .children(this.compact ? [this.compactTable(t, providers)] : providers.map((p) => this.card(t, p)))
      .when(Boolean(u), (el) => el.child(div().text_size(11.5).text_color(t.dim)
        .child(`Read on ${u?.machine ?? "this computer"} from its Claude and Codex logins.`)));
  }

  /** @param {Record<string, any>} t @param {Limit} l @param {string} tile */
  bar(t, l, tile) {
    const lv = level(l.percent);
    const fill = lv === "high" ? t.ansi1 : lv === "warn" ? t.blocked : tile;
    const pct = Math.max(0, Math.min(100, l.percent));
    return h_flex().h(6).w_full().rounded(3).overflow_hidden().bg(alpha(t.foreground, 0.08))
      .child(div().h_full().flex_grow(pct).rounded(3).bg(fill))
      .child(div().h_full().flex_grow(100 - pct));
  }

  /** @param {Record<string, any>} t @param {Provider} p */
  card(t, p) {
    const tile = TILE[p.id];
    return v_flex().p(12).gap(10).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().size(22).flex().items_center().justify_center().rounded(6).bg(tile).text_color("#1c1d21").font_semibold().child(p.name[0]))
        .child(div().font_semibold().child(p.name))
        .when(Boolean(p.plan), (el) => el.child(div().px(6).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child(p.plan))))
      .when(Boolean(p.error), (el) => el.child(div().text_size(12).text_color(t.muted).child(p.error ?? "")))
      .children(p.limits.map((l) => {
        const lv = level(l.percent);
        return v_flex().gap(5)
          .child(h_flex().items_center()
            .child(div().flex_1().min_w(0).truncate().child(l.label))
            .child(div().flex_none().font_semibold().text_color(lv === "high" ? t.ansi1 : lv === "warn" ? t.blocked : t.foreground).child(`${Math.round(l.percent)}%`)))
          .child(this.bar(t, l, tile))
          .child(h_flex().gap(8).text_size(11.5).text_color(t.dim)
            .child(div().flex_1().min_w(0).truncate().child(pace(l)))
            .when(Boolean(l.resetsAt), (el) => el.child(div().flex_none().child(`Resets in ${until(l.resetsAt)}`))));
      }))
      .when(p.extras.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.muted).child(p.extras.join(" · "))));
  }

  /** @param {Record<string, any>} t @param {Provider[]} providers */
  compactTable(t, providers) {
    return v_flex().gap(7).children(providers.flatMap((p) => {
      if (!p.limits.length) return [h_flex().gap(8).child(div().w(54).font_medium().child(p.name)).child(div().flex_1().text_size(12).text_color(t.muted).child(p.error ?? ""))];
      return p.limits.map((l, i) => h_flex().gap(8).items_center()
        .child(div().w(54).flex_none().truncate().text_color(i ? t.dim : t.foreground).when(!i, (el) => el.font_medium()).child(i ? l.short : p.name))
        .child(div().flex_1().child(this.bar(t, l, TILE[p.id])))
        .child(div().w(36).flex_none().text_right().child(`${Math.round(l.percent)}%`))
        .child(div().w(56).flex_none().text_right().text_size(11.5).text_color(t.dim).child(until(l.resetsAt))));
    }));
  }
}
