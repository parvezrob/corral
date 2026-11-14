// Files: the shown space's folder on whatever machine it lives on, with git
// marks, find-by-name and search-in-contents. Files open in the viewer pane
// beside the terminal (Ctrl/Cmd-click: in a new tab).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, v_virtual_list, Scrollbar } from "gpui-base";
import { layout, watchFolder, nextCommand } from "herdr";
import { colors, CLEAR } from "./lib/theme.js";
import { here, repoRoot } from "./lib/context.js";
import { sh } from "./lib/host.js";
import { panelState } from "./lib/layout.js";
import { LIST_SCRIPT, parseListing, visibleRows, changedFolders } from "./lib/tree.js";
import { rank, FILES_SCRIPT, CONTENT_SCRIPT, parseContentHits } from "./lib/fuzzy.js";
import { basename, join } from "./lib/paths.js";
import { splitNul } from "./lib/sh.js";
import { openView } from "./lib/open.js";

const ROW = 26;
const REMOTE_POLL_MS = 4000;   // remote folders can't be watched: poll while shown
const IDLE_POLL_MS = 15000;    // safety net for local watches that miss something

/** @typedef {import("./lib/tree.js").Row} Row */

export default class Files extends View {
  /** @param {any} _props @param {any} cx */
  init(_props, cx) {
    /** @type {string | null} */ this.key = null;
    /** @type {string | null} machine and repo root: changes only when the tree does */ this.ctx = null;
    /** @type {string} */ this.query = "";
    this.stale = false;
    /** @type {string | null} */ this.root = null;
    /** @type {string | null} */ this.machine = null;
    this.listing = /** @type {import("./lib/tree.js").Listing | null} */ (null);
    /** @type {Set<string>} */ this.open = new Set();
    /** @type {Row[]} */ this.rows = [];
    this.loading = false;
    this.again = false;
    /** @type {string | null} */ this.error = null;
    /** @type {string | null} */ this.watching = null;
    this.lastRefresh = 0;
    /** @type {string | null} the last answer, to skip unchanged ones */ this.lastRaw = null;
    /** @type {import("gpui-kit").Modifiers | null} */ this.pressMods = null;

    /** @type {"names" | "contents"} */ this.mode = "names";
    this.query = "";
    /** @type {string[] | null} */ this.allFiles = null;
    /** @type {string[]} */ this.nameHits = [];
    /** @type {{ path: string, line: number, text: string }[]} */ this.contentHits = [];
    this.searching = false;
    this.input = InputState.new({ placeholder: "Find files" });
    this.input.on("change", (/** @type {any} */ _e, /** @type {any} */ cx) => this.onQuery(this.input.value(), cx));
    this.input.on("submit", (/** @type {any} */ _e, /** @type {any} */ cx) => { if (this.mode === "contents") this.searchContents(cx); });

    this.sync(cx);
    cx.timer.every(1000, (/** @type {any} */ cx) => this.tick(cx));
    // Commands for keys.json ("corral-files.refresh") and scripts
    // (`herdr-app do corral-files.open:src/app.ts`, a path relative to the root).
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") { this.allFiles = null; this.refresh(cx); }
        else if (command.startsWith("open:")) this.openFile(command.slice(5), undefined);
        cx.notify();
      }
    });
  }

  async close() {
    this.input.release();
  }

  /** Called every second: polls a remote folder while the panel shows it, and backs up local watches. @param {any} cx */
  tick(cx) {
    if (!this.root || !this.shown()) return;
    const every = this.machine ? REMOTE_POLL_MS : IDLE_POLL_MS;
    if (this.stale || Date.now() - this.lastRefresh >= every) { this.stale = false; this.refresh(cx); }
  }

  shown() {
    const s = panelState(layout());
    return s.open && s.active === "files";
  }

  /** Follows the shown space and folder: a new context starts a fresh tree. @param {any} cx */
  sync(cx) {
    const h = here();
    if (h.key === this.key) return;
    this.key = h.key;
    const key = h.key;
    if (!h.cwd) { this.reset(h.machine, null); return; }
    cx.spawn(async (/** @type {any} */ cx) => {
      // The repo's top when the folder is in one, so the tree and git agree.
      const root = (await repoRoot(h.machine, h.cwd)) ?? h.cwd;
      if (key !== this.key) return;
      // Another terminal in the same repo: keep the tree as it is.
      if (root === this.root && h.machine === this.machine) return;
      this.reset(h.machine, root);
      this.open = this.restoreOpen(root);
      this.refresh(cx);
      this.watch(cx);
      if (this.query.trim()) this.onQuery(this.query, cx);
    });
  }

  /** A new folder tree: drop everything about the old one. @param {string | null} machine @param {string | null} root */
  reset(machine, root) {
    this.machine = machine;
    this.root = root;
    this.ctx = root ? `${machine ?? ""}\0${root}` : null;
    this.listing = null;
    this.rows = [];
    this.allFiles = null;
    this.error = null;
    this.watching = null;
    this.lastRaw = null;
    this.stale = false;
    this.nameHits = [];
    this.contentHits = [];
  }

  /** @param {string} root */
  restoreOpen(root) {
    try { return new Set(JSON.parse(localStorage.getItem(`open:${this.machine ?? ""}:${root}`) ?? "[]")); } catch { return new Set(); }
  }

  saveOpen() {
    if (!this.root) return;
    try { localStorage.setItem(`open:${this.machine ?? ""}:${this.root}`, JSON.stringify([...this.open])); } catch { /* storage is a convenience */ }
  }

  /** Local roots get a real folder watch; remote ones are polled by tick(). @param {any} cx */
  watch(cx) {
    if (this.machine || !this.root || this.watching === this.root) return;
    const root = this.root, key = this.ctx;
    this.watching = root;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        while (this.ctx === key && this.watching === root) {
          await watchFolder(root);
          if (this.ctx !== key) break;
          this.allFiles = null;
          // Hidden: just remember; the tick refreshes when the tab is on screen.
          if (this.shown()) this.refresh(cx); else this.stale = true;
        }
      } catch {
        if (this.watching === root) this.watching = null; // too big to watch: tick() polls instead
      }
    });
  }

  /** One round trip: every open folder plus git status. @param {any} cx */
  refresh(cx) {
    if (!this.root) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    this.lastRefresh = Date.now();
    const key = this.ctx, root = this.root;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const args = [root, "", ...this.open];
        const r = await sh(this.machine, LIST_SCRIPT, args, { timeout: 20000 });
        if (key !== this.ctx) return;
        if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || `Cannot list ${root}`);
        // Same folders asked, same answer: nothing to rebuild or draw.
        const raw = `${args.join("\0")}\x1f${r.stdout}`;
        if (raw === this.lastRaw && this.listing && !this.error) return;
        this.lastRaw = raw;
        this.listing = parseListing(r.stdout);
        // Forget open folders that are gone.
        for (const f of [...this.open]) if (!this.listing.folders.has(f)) this.open.delete(f);
        this.rebuild();
        this.error = null;
      } catch (e) {
        if (key === this.ctx) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  rebuild() {
    const l = this.listing;
    this.rows = l ? visibleRows(l.folders, this.open, l.marks, changedFolders(l.marks)) : [];
  }

  /** @param {Row} row @param {any} cx */
  toggle(row, cx) {
    if (this.open.has(row.path)) {
      for (const f of [...this.open]) if (f === row.path || f.startsWith(`${row.path}/`)) this.open.delete(f);
    } else {
      this.open.add(row.path);
    }
    this.saveOpen();
    this.rebuild();
    if (this.open.has(row.path) && !this.listing?.folders.has(row.path)) this.refresh(cx);
    cx.notify();
  }

  /** @param {string} relPath @param {import("gpui-kit").ClickEvent | undefined} e */
  openFile(relPath, e) {
    if (!this.root) return;
    const newTab = Boolean(e?.modifiers?.platform || e?.modifiers?.control);
    openView({ path: join(this.root, relPath), machine: this.machine, root: this.root, mode: "file" }, { newTab });
  }

  /** @param {string} text @param {any} cx */
  onQuery(text, cx) {
    this.query = text;
    if (this.mode === "contents") { if (!text.trim()) this.contentHits = []; cx.notify(); return; }
    if (!text.trim()) { this.nameHits = []; cx.notify(); return; }
    if (this.allFiles) { this.nameHits = rank(text, this.allFiles); cx.notify(); return; }
    if (this.searching || !this.root) return;
    this.searching = true;
    const key = this.ctx, root = this.root;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const r = await sh(this.machine, FILES_SCRIPT, [root], { timeout: 20000 });
        if (key !== this.ctx) return;
        // find(1) prints "./a/b"; git prints "a/b".
        this.allFiles = splitNul(r.stdout).map((p) => (p.startsWith("./") ? p.slice(2) : p));
        this.nameHits = rank(this.query, this.allFiles);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.searching = false;
        cx.notify();
      }
    });
  }

  /** @param {any} cx */
  searchContents(cx) {
    const q = this.query.trim();
    if (!q || !this.root || this.searching) return;
    this.searching = true;
    const key = this.ctx, root = this.root;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const r = await sh(this.machine, CONTENT_SCRIPT, [root, q], { timeout: 30000 });
        if (key === this.ctx) this.contentHits = parseContentHits(r.stdout);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.searching = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  /** @param {"names" | "contents"} mode @param {any} cx */
  setMode(mode, cx) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.input.set_value("");
    this.query = "";
    this.nameHits = [];
    this.contentHits = [];
    cx.notify();
  }

  /** @param {any} cx */
  render(cx) {
    this.sync(cx);
    const t = colors();
    const name = this.root ? basename(this.root) : "";
    const icon = (/** @type {string} */ id, /** @type {string} */ file, /** @type {() => void} */ click) =>
      div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(click).child(svg(`mods/corral-files/${file}.svg`).size(14));
    const seg = (/** @type {"names" | "contents"} */ m, /** @type {string} */ label) => div().id(`corral-mode-${m}`).flex_1().h(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .bg(this.mode === m ? t.selected : CLEAR).text_color(this.mode === m ? t.foreground : t.muted).on_click(() => this.setMode(m, cx)).child(label);
    const searching = Boolean(this.query.trim());
    return v_flex().id("corral-files").size_full().min_h(0).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(10).pt(10).pb(6).gap(8)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(name || "Files"))
          .when(Boolean(this.machine), (el) => el.child(div().text_size(11).text_color(t.dim).child(this.machine ?? "")))
          .child(icon("corral-collapse", "collapse", () => { this.open.clear(); this.saveOpen(); this.rebuild(); cx.notify(); }))
          .child(icon("corral-refresh", "refresh", () => { this.allFiles = null; this.refresh(cx); })))
        .child(h_flex().h(32).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.chrome)
          .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
          .child(svg("mods/corral-files/search.svg").size(14).text_color(t.dim))
          .child(Input.new(this.input).flex_1().text_size(12.5)))
        .child(h_flex().p(2).gap(2).rounded(8).border_1().border_color(t.border).bg(t.chrome).text_size(12)
          .child(seg("names", "Names")).child(seg("contents", "Contents"))))
      .child(searching ? this.results(t, cx) : this.tree(t, cx));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  tree(t, cx) {
    if (!this.rows.length) {
      return div().p(12).text_size(12).text_color(t.dim).child(this.error ?? (this.loading || !this.root ? "Loading files…" : "Empty folder"));
    }
    const rows = this.rows;
    // Rows of a virtual list can't carry handlers: one on_item_click serves them
    // all, and a mouse-down around the list records Ctrl/Cmd for it.
    /** @param {Row} r */
    const row = (r) => h_flex().h(ROW).pl(8 + r.depth * 16).pr(10).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .child(r.dir ? svg(`mods/corral-files/chevron-${r.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/corral-files/${r.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(r.mark && !r.dir ? t.foreground : r.dir ? t.foreground : t.muted).child(r.name))
      .when(Boolean(r.mark), (el) => el.child(div().flex_none().text_size(11).font_semibold().text_color(markColor(t, r.mark)).child(r.mark)));
    return div().id("corral-tree-box").flex_1().min_h(0).relative().px(6).pb(6)
      .on_mouse_down("left", (/** @type {import("gpui-kit").MouseButtonEvent} */ e) => { this.pressMods = e.modifiers; })
      .child(v_virtual_list("corral-tree", rows.length, ROW, (i) => rows[i].path, (range) => rows.slice(range.start, range.end).map(row)).size_full()
        .on_item_click((/** @type {string} */ path, /** @type {any} */ cx) => {
          const r = this.rows.find((x) => x.path === path);
          if (!r) return;
          if (r.dir) this.toggle(r, cx);
          else this.openFile(r.path, /** @type {any} */ ({ modifiers: this.pressMods }));
          this.pressMods = null;
        }))
      .child(Scrollbar.vertical("corral-tree").viewport_from_layout().absolute().inset_0());
  }

  /** @param {Record<string, any>} t @param {any} cx */
  results(t, cx) {
    if (this.mode === "contents") {
      const hits = this.contentHits;
      if (!hits.length) return div().p(12).text_size(12).text_color(t.dim).child(this.searching ? "Searching…" : "Press Enter to search file contents");
      return v_flex().id("corral-hits").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(6)
        .children(hits.map((h, i) => v_flex().id(`corral-hit-${i}`).px(8).py(5).gap(2).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((/** @type {import("gpui-kit").ClickEvent} */ e) => this.openFile(h.path, e))
          .child(h_flex().gap(6).text_size(12).child(div().min_w(0).truncate().text_color(t.muted).child(h.path)).child(div().flex_none().text_color(t.dim).child(`:${h.line}`)))
          .child(div().truncate().text_size(12).font_family("JetBrains Mono").child(h.text))));
    }
    const hits = this.nameHits;
    if (!hits.length) return div().p(12).text_size(12).text_color(t.dim).child(this.searching ? "Listing files…" : "No matching files");
    return v_flex().id("corral-name-hits").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(6)
      .children(hits.map((path) => {
        const slash = path.lastIndexOf("/");
        return h_flex().id(`corral-hit-${path}`).h(ROW).px(8).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((/** @type {import("gpui-kit").ClickEvent} */ e) => this.openFile(path, e))
          .child(svg("mods/corral-files/file.svg").size(14).flex_none().text_color(t.muted))
          .child(div().flex_none().child(path.slice(slash + 1)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(slash > 0 ? path.slice(0, slash) : ""));
      }));
  }
}

/** @param {Record<string, any>} t @param {string} mark */
function markColor(t, mark) {
  if (mark === "A") return t.ansi2;
  if (mark === "D" || mark === "U") return t.ansi1;
  if (mark === "•") return t.blocked;
  return t.blocked;
}
