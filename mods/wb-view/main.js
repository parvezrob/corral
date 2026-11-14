// The viewer pane: a file (editable, saved safely), a markdown file (rendered or
// source), or a diff. Opened beside the terminal by lib/open.js; one per tab,
// retargeted through shared state.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, v_virtual_list, Scrollbar } from "gpui-base";
import { props, shared, setShared, settings, nextCommand, notify } from "herdr";
import { colors, alpha } from "./lib/theme.js";
import { readFile, writeFile, run, openUrl, StaleFileError } from "./lib/host.js";
import { languageFor, languageForFence, isMarkdown, syntaxColors } from "./lib/lang.js";
import { splitMarkdown } from "./lib/markdown.js";
import { parseDiff, addedFileRows, widestRow } from "./lib/diff.js";
import { READ_ONLY } from "./lib/git.js";
import { basename, dirname, join, relative } from "./lib/paths.js";
import { requestKey } from "./lib/open.js";

const ROW = 20;          // diff row height, px
const CODE_LINE = 19;    // editor line height at 12.5 px, for sizing code blocks
const MONO = () => /** @type {string} */ (settings().font_family) || "JetBrains Mono";

/** @typedef {import("./lib/open.js").ViewRequest} ViewRequest */
/** @typedef {import("./lib/diff.js").DiffRow} DiffRow */

export default class Viewer extends View {
  /** @param {any} initial @param {any} cx */
  init(initial, cx) {
    // A pane mod reads what it was opened with from props(); init's argument can be empty.
    const p = props() ?? initial;
    this.viewId = p?.viewId ?? null;
    /** @type {ViewRequest | null} */ this.req = null;
    this.seq = -1;
    this.reset();
    this.handle = cx.focus_handle();
    if (p?.path) this.load(p, cx);
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "save") this.save(cx);
        else if (command === "toggle") this.toggleView(cx);
        cx.notify();
      }
    });
  }

  reset() {
    this.releaseStates();
    this.loading = false;
    /** @type {string | null} */ this.error = null;
    /** @type {string | null} */ this.original = null;
    this.source = null;            // EditorState for the file
    /** @type {any[]} */ this.codeStates = [];
    /** @type {import("./lib/markdown.js").Block[]} */ this.blocks = [];
    /** @type {DiffRow[]} */ this.rows = [];
    this.diffWidth = 0;
    this.dirty = false;
    this.saving = false;
    this.conflict = false;
    /** @type {"rendered" | "source" | "diff"} */ this.view = "source";
    /** @type {ViewRequest | null} */ this.waiting = null;   // a request held back by unsaved edits
  }

  /** Old editors are released only after a frame that no longer shows them. */
  releaseStates() {
    /** @type {any[]} */
    this.retired = this.retired ?? [];
    if (this.source) this.retired.push(this.source);
    for (const s of this.codeStates ?? []) this.retired.push(s);
    this.source = null;
    this.codeStates = [];
  }

  async close() {
    this.releaseStates();
    for (const s of this.retired) s.release();
    this.retired = [];
    if (this.viewId) setShared(requestKey(this.viewId), null);
  }

  /** @param {ViewRequest} req @param {any} cx */
  load(req, cx) {
    if (this.dirty && req.path !== this.req?.path) { this.waiting = req; this.seq = req.seq ?? Date.now(); cx.notify(); return; }
    const keepView = this.req?.path === req.path && this.req?.mode === req.mode ? this.view : null;
    this.reset();
    this.req = req;
    this.seq = req.seq ?? Date.now();
    this.loading = true;
    const seq = this.seq;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        if (req.mode === "diff") await this.loadDiff(req);
        else await this.loadFile(req, keepView);
      } catch (e) {
        if (seq === this.seq) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        if (seq === this.seq) this.loading = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  /** @param {ViewRequest} req @param {"rendered" | "source" | "diff" | null} keepView */
  async loadFile(req, keepView) {
    const seq = this.seq;
    const text = await readFile(req.machine, req.path);
    if (seq !== this.seq) return;
    if (text === null) { this.error = "This file doesn't exist (anymore)."; return; }
    if (text.includes("\0")) { this.error = "Binary file: no text view."; return; }
    this.original = text;
    this.makeSource(text);
    if (isMarkdown(req.path)) {
      this.makeBlocks(text);
      this.view = keepView === "source" ? "source" : "rendered";
    }
  }

  /** @param {string} text */
  makeSource(text) {
    const req = /** @type {ViewRequest} */ (this.req);
    this.source = EditorState.new({
      language: languageFor(req.path), value: text, font_family: MONO(), font_size: 13,
      syntax: syntaxColors(colors()),
    });
    this.source.on("change", (/** @type {any} */ _e, /** @type {any} */ cx) => {
      if (!this.dirty) { this.dirty = true; cx.notify(); }
    });
  }

  /** @param {string} text */
  makeBlocks(text) {
    this.retired.push(...this.codeStates);
    this.blocks = splitMarkdown(text);
    const syntax = syntaxColors(colors());
    this.codeStates = this.blocks.map((b) => b.kind === "code"
      ? EditorState.new({ language: languageForFence(b.lang), value: b.code, readonly: true, line_numbers: false, folding: false, font_family: MONO(), font_size: 12.5, syntax })
      : null).filter(Boolean);
  }

  /** @param {ViewRequest} req */
  async loadDiff(req) {
    const seq = this.seq;
    this.view = "diff";
    let rows;
    if (req.diff === "untracked") {
      const text = await readFile(req.machine, req.path);
      if (text === null) throw new Error("This file doesn't exist (anymore).");
      rows = text.includes("\0") ? [{ kind: "note", old: null, new: null, text: "Binary file" }] : addedFileRows(text);
    } else {
      const which = req.diff === "staged" ? ["--cached"] : req.diff === "head" ? ["HEAD"] : [];
      const rel = req.root ? relative(req.root, req.path) ?? req.path : req.path;
      const out = await run(req.machine, "git", [...READ_ONLY, "diff", ...which, "--no-color", "--no-ext-diff", "-M", "--", rel], { cwd: req.root ?? dirname(req.path) });
      rows = parseDiff(out);
      if (!rows.length) rows = [{ kind: "note", old: null, new: null, text: "No changes" }];
    }
    if (seq !== this.seq) return;
    this.rows = /** @type {DiffRow[]} */ (rows);
    this.diffWidth = Math.max(400, widestRow(this.rows) * 7.6 + 120);
  }

  /** @param {any} cx */
  save(cx, overwrite = false) {
    const req = this.req;
    if (!req || !this.source || this.saving || (!this.dirty && !overwrite)) return;
    const text = this.source.value();
    this.saving = true;
    const seq = this.seq;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const expected = overwrite ? await readFile(req.machine, req.path) : this.original;
        await writeFile(req.machine, req.path, text, expected);
        if (seq !== this.seq) return;
        this.original = text;
        this.dirty = false;
        this.conflict = false;
        if (this.blocks.length || isMarkdown(req.path)) this.makeBlocks(text);
      } catch (e) {
        if (seq !== this.seq) return;
        if (e instanceof StaleFileError) this.conflict = true;
        else notify({ title: `Couldn't save ${basename(req.path)}`, body: e instanceof Error ? e.message : String(e), level: "error" });
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  /** @param {any} cx */
  toggleView(cx) {
    if (!this.req) return;
    if (this.req.mode === "diff") { this.load({ ...this.req, mode: "file", seq: Date.now() }, cx); return; }
    if (this.blocks.length || isMarkdown(this.req.path)) {
      if (this.view === "source" && this.dirty && this.source) this.makeBlocks(this.source.value());
      this.view = this.view === "rendered" ? "source" : "rendered";
      cx.notify();
    }
  }

  /** A link in rendered markdown: web links to the browser, file links here. @param {string} url @param {any} cx */
  followLink(url, cx) {
    const req = this.req;
    if (!req) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("file:")) { openUrl(url); return; }
    const target = url.replace(/^file:\/\//, "").replace(/#.*$/, "");
    if (!target) return;
    const path = target.startsWith("/") ? target : join(dirname(req.path), decodeURIComponent(target));
    this.load({ ...req, path, mode: "file", seq: Date.now() }, cx);
  }

  /** @param {any} cx */
  render(cx) {
    const pending = /** @type {ViewRequest | null} */ (this.viewId ? shared(requestKey(this.viewId)) : null);
    if (pending && (pending.seq ?? 0) > this.seq) this.load(pending, cx);
    if (this.retired.length) {
      const old = this.retired;
      this.retired = [];
      cx.timer.after(500, () => { for (const st of old) st.release(); });
    }
    const t = colors();
    return v_flex().id("wb-view").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((/** @type {import("gpui-kit").KeyEvent} */ e, /** @type {any} */ cx) => {
        if (e.key === "s" && (e.modifiers.control || e.modifiers.platform)) { this.save(cx); cx.stop_propagation(); }
      })
      .child(this.header(t, cx))
      .when(Boolean(this.waiting), (el) => el.child(this.unsavedBar(t, cx)))
      .when(this.conflict, (el) => el.child(this.conflictBar(t, cx)))
      .child(this.body(t, cx));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  header(t, cx) {
    const req = this.req;
    const shown = req ? (req.root && relative(req.root, req.path)) || req.path : "";
    const dir = shown.includes("/") ? shown.slice(0, shown.lastIndexOf("/") + 1) : "";
    const md = Boolean(req && req.mode === "file" && isMarkdown(req.path) && this.source);
    /** @param {string} id @param {string} label @param {boolean} on @param {() => void} click */
    const seg = (id, label, on, click) => div().id(id).h(24).px(10).flex().items_center().rounded(6).cursor_pointer()
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
      .on_click(click).child(label);
    return h_flex().h(36).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().flex_1().min_w(0).items_center().font_family(MONO()).text_size(12)
        .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(dir))
        .child(div().flex_none().text_color(t.foreground).child(shown.slice(dir.length)))
        .when(req?.mode === "diff", (el) => el.child(div().ml(8).flex_none().font_family(/** @type {string} */ (settings().ui_font_family) || "Geist").text_color(t.muted).child(req?.diff === "staged" ? "staged changes" : req?.diff === "untracked" ? "new file" : "changes"))))
      .when(this.dirty, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.saving ? "Saving…" : "● Unsaved")))
      .when(md, (el) => el.child(h_flex().p(2).gap(2).rounded(8).border_1().border_color(t.border).bg(t.chrome).text_size(12)
        .child(seg("wb-rendered", "Rendered", this.view === "rendered", () => { if (this.view !== "rendered") this.toggleView(cx); }))
        .child(seg("wb-source", "Source", this.view === "source", () => { if (this.view !== "source") this.toggleView(cx); }))))
      .when(req?.mode === "diff" && req?.diff !== "staged", (el) => el.child(div().id("wb-edit").h(26).px(10).flex().items_center().rounded(7).border_1().border_color(t.input).cursor_pointer().text_size(12)
        .hover((s) => s.bg(t.hover)).on_click(() => this.toggleView(cx)).child("Edit file")))
      .when(this.dirty, (el) => el.child(div().id("wb-save").h(26).px(12).flex().items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground).cursor_pointer().text_size(12)
        .on_click(() => this.save(cx)).child("Save")));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  unsavedBar(t, cx) {
    const next = /** @type {ViewRequest} */ (this.waiting);
    return h_flex().flex_none().px(12).py(8).gap(10).items_center().bg(alpha(t.blocked, 0.12)).border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().child(`Unsaved changes in ${basename(this.req?.path ?? "")}. Open ${basename(next.path)} anyway?`))
      .child(div().id("wb-keep").px(10).py(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => { this.waiting = null; cx.notify(); }).child("Keep editing"))
      .child(div().id("wb-discard").px(10).py(4).rounded(6).border_1().border_color(t.input).cursor_pointer().on_click(() => { this.dirty = false; this.waiting = null; this.load(next, cx); }).child("Discard and open"));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  conflictBar(t, cx) {
    return h_flex().flex_none().px(12).py(8).gap(10).items_center().bg(alpha(t.ansi1, 0.14)).border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().child("This file changed on disk since you opened it (an agent?). Your edits aren't saved."))
      .child(div().id("wb-reload").px(10).py(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => { this.dirty = false; if (this.req) this.load({ ...this.req, seq: Date.now() }, cx); }).child("Reload theirs"))
      .child(div().id("wb-overwrite").px(10).py(4).rounded(6).border_1().border_color(t.input).cursor_pointer().on_click(() => this.save(cx, true)).child("Overwrite with mine"));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  body(t, cx) {
    if (!this.req) return div().flex_1().p(16).text_color(t.dim).child("Open a file from Files or Changes.");
    if (this.error) return div().flex_1().p(16).text_color(t.muted).child(this.error);
    if (this.loading) return div().flex_1().p(16).text_color(t.dim).child("Loading…");
    if (this.view === "diff") return this.diffBody(t);
    if (this.view === "rendered") return this.markdownBody(t, cx);
    return this.source ? Editor.new(this.source).flex_1().min_h(0) : div().flex_1();
  }

  /** @param {Record<string, any>} t @param {any} cx */
  markdownBody(t, cx) {
    let code = 0;
    return v_flex().id("wb-md").flex_1().min_h(0).overflow_y_scrollbar().px(32).py(24).gap(14).text_size(14)
      .children(this.blocks.map((b, i) => {
        if (b.kind === "text") {
          return TextView.markdown(`wb-md-${i}`, b.text).selectable(true).on_link_click((/** @type {string} */ url, /** @type {any} */ cx) => this.followLink(url, cx)).w_full();
        }
        const state = this.codeStates[code++];
        const lines = b.code.split("\n").length;
        return v_flex().w_full().flex_none().rounded(8).border_1().border_color(t.border).bg(t.chrome).overflow_hidden()
          .when(Boolean(b.lang), (el) => el.child(div().px(10).pt(6).text_size(11).text_color(t.dim).child(b.lang)))
          .child(div().h(lines * CODE_LINE + 16).px(4).py(6).child(Editor.new(state).size_full()));
      }));
  }

  /** @param {Record<string, any>} t */
  diffBody(t) {
    const rows = this.rows;
    const addBg = alpha(t.ansi2, 0.12), delBg = alpha(t.ansi1, 0.12);
    /** @param {number | null} n */
    const num = (n) => div().w(44).flex_none().text_right().pr(8).text_color(t.dim).child(n === null ? "" : String(n));
    /** @param {DiffRow} r */
    const row = (r) => {
      if (r.kind === "hunk") return div().w_full().h(ROW).px(12).flex().items_center().bg(t.raised).text_color(t.dim).truncate().child(r.text);
      if (r.kind === "note") return div().w_full().h(ROW).px(12).flex().items_center().text_color(t.dim).child(r.text);
      return h_flex().w_full().h(ROW).items_center()
        .when(r.kind === "add", (el) => el.bg(addBg)).when(r.kind === "del", (el) => el.bg(delBg))
        .child(num(r.old)).child(num(r.new))
        .child(div().w(16).flex_none().text_color(r.kind === "add" ? t.ansi2 : r.kind === "del" ? t.ansi1 : t.dim).child(r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""))
        .child(div().flex_none().whitespace_nowrap().child(r.text));
    };
    return div().flex_1().min_h(0).relative().font_family(MONO()).text_size(12.5)
      .child(div().id("wb-diff-x").size_full().overflow_x_scrollbar()
        .child(div().min_w(this.diffWidth).w_full().h_full()
          .child(v_virtual_list("wb-diff", rows.length, ROW, (i) => String(i), (range) => rows.slice(range.start, range.end).map(row)).size_full())))
      .child(Scrollbar.vertical("wb-diff").viewport_from_layout().absolute().inset_0());
  }
}
