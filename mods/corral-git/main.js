// Changes: the shown space's repo on whatever machine it lives on. Staged,
// unstaged, untracked and conflicted files with stage/unstage/discard, a commit
// box, pull/push, and recent commits. A file opens its diff in the viewer pane.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { layout, watchFolder, shared, setShared, notify, nextCommand } from "herdr";
import { colors, alpha, CLEAR } from "./lib/theme.js";
import { here, repoRoot } from "./lib/context.js";
import { sh, run } from "./lib/host.js";
import { panelState } from "./lib/layout.js";
import { CHANGES_SCRIPT, parseChanges, ACTIONS } from "./lib/changes.js";
import { join } from "./lib/paths.js";
import { openView } from "./lib/open.js";

const REMOTE_POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const HIDDEN_POLL_MS = 30000;   // panel closed: the Changes count, at most this often
const CONFIRM_MS = 3000;
const GROUP_ROWS = 300;     // rows per group before "Show all": an untracked build folder can be thousands   // a destructive button arms on the first click, acts on the second

/** @typedef {import("./lib/changes.js").ChangedFile} ChangedFile */
/** @typedef {"staged" | "unstaged" | "untracked" | "conflicts"} Group */

export default class Changes extends View {
  /** @param {any} _props @param {any} cx */
  init(_props, cx) {
    /** @type {string | null} */ this.key = null;
    /** @type {string | null} machine and repo root */ this.ctx = null;
    this.stale = false;
    /** @type {string | null} */ this.root = null;
    /** @type {string | null} */ this.machine = null;
    /** @type {import("./lib/changes.js").Changes | null} */ this.data = null;
    /** @type {string | null} */ this.error = null;
    /** @type {string | null} */ this.note = null;
    this.loading = false;
    this.again = false;
    this.busy = /** @type {string | null} */ (null);   // what's running: "commit", "push", ...
    this.lastRefresh = 0;
    /** @type {string | null} the last answer, to skip unchanged ones */ this.lastRaw = null;
    /** @type {string | null} */ this.watching = null;
    /** @type {Record<string, number>} */ this.armed = {};
    /** @type {Set<string>} */ this.folded = new Set();
    /** @type {Set<string>} groups showing every row */ this.expanded = new Set();
    /** @type {{ group: Group, path: string } | null} */ this.selected = null;
    this.message = "";
    // A summary line, and a body below it if you want one.
    this.input = TextareaState.new({ placeholder: "Commit message" });
    this.input.set_auto_grow(1, 6);
    this.input.on("change", (/** @type {any} */ _e, /** @type {any} */ cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (/** @type {any} */ _e, /** @type {any} */ cx) => this.commit(cx));
    this.sync(cx);
    cx.timer.every(1000, (/** @type {any} */ cx) => this.tick(cx));
    // Commands for keys.json and scripts: "refresh", "diff:<path relative to the repo>".
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        else if (command.startsWith("diff:") && this.data) {
          const path = command.slice(5);
          /** @type {Group[]} */
          const groups = ["conflicts", "unstaged", "staged", "untracked"];
          const group = groups.find((g) => this.data?.[g].some((f) => f.path === path));
          const file = group && this.data[group].find((f) => f.path === path);
          if (group && file) this.open(group, file, /** @type {any} */ (undefined));
        }
        cx.notify();
      }
    });
  }

  async close() {
    this.input.release();
  }

  /** @param {any} cx */
  tick(cx) {
    if (!this.root) return;
    const since = Date.now() - this.lastRefresh;
    if (this.shown()) {
      if (this.stale || since >= (this.machine ? REMOTE_POLL_MS : IDLE_POLL_MS)) { this.stale = false; this.refresh(cx); }
    } else if (since >= HIDDEN_POLL_MS && (this.stale || this.machine)) {
      // Hidden: only the tab's count needs keeping up, and not often.
      this.stale = false;
      this.refresh(cx);
    }
  }

  shown() {
    const s = panelState(layout());
    return s.open && s.active === "changes";
  }

  /** @param {any} cx */
  sync(cx) {
    const h = here();
    if (h.key === this.key) return;
    this.key = h.key;
    const key = h.key;
    if (!h.cwd) { this.reset(h.machine, null); return; }
    cx.spawn(async (/** @type {any} */ cx) => {
      const top = await repoRoot(h.machine, h.cwd);
      if (key !== this.key) return;
      if (top && top === this.root && h.machine === this.machine) return;   // same repo
      this.reset(h.machine, top);
      if (!top) { this.error = "Not a git repository"; this.publishCount(0); cx.notify(); return; }
      this.refresh(cx);
      this.watch(cx);
    });
  }

  /** @param {string | null} machine @param {string | null} root */
  reset(machine, root) {
    this.machine = machine;
    this.root = root;
    this.ctx = root ? `${machine ?? ""}\0${root}` : null;
    this.data = null;
    this.error = null;
    this.note = null;
    this.selected = null;
    this.watching = null;
    this.lastRaw = null;
    this.stale = false;
  }

  /** @param {any} cx */
  watch(cx) {
    if (this.machine || !this.root || this.watching === this.root) return;
    const root = this.root, key = this.ctx;
    this.watching = root;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        while (this.ctx === key && this.watching === root) {
          await watchFolder(root);
          if (this.ctx !== key) break;
          if (this.shown()) this.refresh(cx); else this.stale = true;
        }
      } catch {
        if (this.watching === root) this.watching = null;
      }
    });
  }

  /** @param {any} cx */
  refresh(cx) {
    if (!this.root) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    this.lastRefresh = Date.now();
    const key = this.ctx, root = this.root;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const r = await sh(this.machine, CHANGES_SCRIPT, [root], { timeout: 20000 });
        if (key !== this.ctx) return;
        if (r.code === 3) { this.error = "Not a git repository"; this.data = null; return; }
        if (r.code !== 0) throw new Error(r.stderr.trim() || "git status failed");
        if (r.stdout === this.lastRaw && this.data && !this.error) return;
        this.lastRaw = r.stdout;
        this.data = parseChanges(r.stdout);
        this.error = null;
        this.publishCount(this.data.count);
      } catch (e) {
        if (key === this.ctx) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  /** The panel tab's badge. Only written when it changes: every write re-renders every mod. @param {number} n */
  publishCount(n) {
    if (shared("corral.changes.count") !== n) setShared("corral.changes.count", n);
  }

  /**
   * Runs one git command in the repo, then refreshes. Errors show under the
   * branch line instead of disappearing.
   * @param {string} label @param {string[]} args @param {any} cx @param {number} [timeout]
   */
  git(label, args, cx, timeout = 30000) {
    if (!this.root || this.busy) return Promise.resolve(false);
    this.busy = label;
    this.note = null;
    const key = this.ctx, root = this.root, machine = this.machine;
    cx.notify();
    return new Promise((resolve) => {
      cx.spawn(async (/** @type {any} */ cx) => {
        let ok = false;
        try {
          await run(machine, "git", args, { cwd: root, timeout });
          ok = true;
        } catch (e) {
          if (key === this.ctx) this.note = `${label} failed: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          this.busy = null;
          this.refresh(cx);
          cx.notify();
          resolve(ok);
        }
      });
    });
  }

  /** @param {any} cx */
  async commit(cx) {
    const message = this.message.trim();
    const d = this.data;
    const key = this.ctx;
    if (!message || !d || this.busy) return;
    // Nothing staged: commit everything, like most git panels.
    if (!d.staged.length && !(await this.git("Stage all", ACTIONS.stageAll(), cx))) return;
    // Another space was shown meanwhile: don't commit there.
    if (key !== this.ctx) return;
    // Hooks (lint, tests) can take a while.
    if (await this.git("Commit", ACTIONS.commit(message), cx, 180000)) {
      this.message = "";
      this.input.set_value("");
      cx.notify();
    }
  }

  /** @param {any} cx */
  async push(cx) {
    const b = this.data?.branch;
    if (!b?.head) return;
    const remote = this.data?.remotes.includes("origin") ? "origin" : this.data?.remotes[0];
    if (!b.upstream && !remote) return;
    const ok = await this.git("Push", b.upstream ? ACTIONS.push() : ACTIONS.publish(remote ?? "origin", b.head), cx, 120000);
    if (ok) notify({ title: `Pushed ${b.head}`, level: "success", timeout: 3000 });
  }

  /** Two-click confirm for destructive buttons. @param {string} id @param {any} cx */
  confirm(id, cx) {
    const now = Date.now();
    if (now - (this.armed[id] ?? 0) < CONFIRM_MS) { delete this.armed[id]; return true; }
    this.armed = { [id]: now };
    cx.timer.after(CONFIRM_MS, (/** @type {any} */ cx) => cx.notify());
    cx.notify();
    return false;
  }

  /** @param {Group} group @param {ChangedFile} f @param {import("gpui-kit").ClickEvent} e */
  open(group, f, e) {
    if (!this.root) return;
    this.selected = { group, path: f.path };
    const path = join(this.root, f.path);
    const newTab = Boolean(e?.modifiers?.platform || e?.modifiers?.control);
    if (group === "conflicts") { openView({ path, machine: this.machine, root: this.root, mode: "file" }, { newTab }); return; }
    openView({ path, machine: this.machine, root: this.root, mode: "diff", diff: group === "untracked" ? "untracked" : group, orig: f.orig }, { newTab });
  }

  /** @param {any} cx */
  render(cx) {
    this.sync(cx);
    const t = colors();
    const d = this.data;
    return v_flex().id("corral-git").size_full().min_h(0).text_color(t.foreground).text_size(13)
      .child(this.branchBar(t, cx))
      .when(Boolean(this.note), (el) => el.child(div().px(12).py(6).text_size(12).text_color(t.ansi1).bg(alpha(t.ansi1, 0.08)).child(this.note ?? "")))
      .child(this.commitBox(t, cx))
      .child(!d
        ? div().p(12).text_size(12).text_color(t.dim).child(this.error ?? (this.loading || this.ctx ? "Loading changes…" : "No folder"))
        : v_flex().id("corral-git-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(8)
          .when(d.count === 0, (el) => el.child(div().px(8).py(10).text_size(12).text_color(t.dim).child("No changes. The working tree is clean.")))
          .child(this.group(t, cx, "conflicts", "Conflicts", d.conflicts))
          .child(this.group(t, cx, "staged", "Staged", d.staged))
          .child(this.group(t, cx, "unstaged", "Changes", d.unstaged))
          .child(this.group(t, cx, "untracked", "Untracked", d.untracked)))
      .when(Boolean(d?.commits.length), (el) => el.child(this.commits(t, cx)));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  branchBar(t, cx) {
    const b = this.data?.branch;
    const button = (/** @type {string} */ id, /** @type {string} */ label, /** @type {boolean} */ primary, /** @type {() => void} */ click) =>
      div().id(id).h(26).px(10).flex().items_center().rounded(7).cursor_pointer().text_size(12)
        .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
        .when(!primary, (el) => el.border_1().border_color(t.input).hover((s) => s.bg(t.hover)))
        .on_click(click).child(label);
    const hasRemote = Boolean(this.data?.remotes.length);
    const sync = b?.upstream ? `→ ${b.upstream} · ↑${b.ahead} ↓${b.behind}` : !b?.head ? "" : hasRemote ? "not published yet" : "no remote";
    return h_flex().flex_none().px(12).py(9).gap(8).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center().child(svg("mods/corral-git/branch.svg").size(13).text_color(t.muted))
          .child(div().min_w(0).truncate().font_family("JetBrains Mono").text_size(12.5).child(b ? b.head ?? `detached ${b.oid?.slice(0, 7) ?? ""}` : "")))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(this.busy ? `${this.busy}…` : sync)))
      .when(Boolean(b?.upstream && b.behind > 0), (el) => el.child(button("corral-pull", `Pull ↓${b?.behind}`, false, () => this.git("Pull", ACTIONS.pull(), cx, 120000))))
      .when(Boolean(b?.upstream && b.behind === 0), (el) => el.child(button("corral-pull", "Pull", false, () => this.git("Pull", ACTIONS.pull(), cx, 120000))))
      .when(Boolean(b?.head && (b.upstream ? b.ahead > 0 : hasRemote)), (el) => el.child(button("corral-push", b?.upstream ? `Push ↑${b?.ahead}` : "Publish", true, () => this.push(cx))));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  commitBox(t, cx) {
    const d = this.data;
    const ready = Boolean(this.message.trim() && d && d.count > 0 && !this.busy);
    const label = !d ? "Commit" : d.staged.length ? `Commit ${d.staged.length} staged` : d.count ? `Commit all ${d.count}` : "Nothing to commit";
    return h_flex().flex_none().px(10).py(8).gap(8).items_start()
      .child(div().id("corral-commit-message").flex_1().min_w(0).min_h(32).px(4).py(1).rounded(8).border_1().border_color(t.input).bg(t.chrome)
        .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
        .child(Textarea.new(this.input).w_full().text_size(12.5)))
      .child(div().id("corral-commit").h(32).px(12).flex().items_center().rounded(8).text_size(12).flex_none()
        .bg(ready ? t.accent : t.raised).text_color(ready ? t.accent_foreground : t.dim)
        .when(ready, (el) => el.cursor_pointer()).on_click(() => { if (ready) this.commit(cx); })
        .child(this.busy === "Commit" ? "Committing…" : label));
  }

  /**
   * @param {Record<string, any>} t @param {any} cx
   * @param {Group} group @param {string} title @param {ChangedFile[]} files
   */
  group(t, cx, group, title, files) {
    if (!files.length) return div();
    const folded = this.folded.has(group);
    const all = files.map((f) => f.path);
    const bulk = group === "staged" ? { label: "Unstage all", act: () => this.git("Unstage", ACTIONS.unstageAll(), cx) }
      : group === "conflicts" ? null
      : { label: "Stage all", act: () => this.git("Stage", ACTIONS.stage(all), cx) };
    return v_flex()
      .child(h_flex().id(`corral-group-${group}`).h(28).px(8).mt(6).gap(6).items_center().cursor_pointer().text_size(11).font_semibold().text_color(t.dim)
        .on_click(() => { if (folded) this.folded.delete(group); else this.folded.add(group); cx.notify(); })
        .child(svg(`mods/corral-git/chevron-${folded ? "right" : "down"}.svg`).size(10))
        .child(div().flex_1().child(`${title.toUpperCase()} · ${files.length}`))
        .when(Boolean(bulk), (el) => el.child(div().id(`corral-bulk-${group}`).px(6).py(2).rounded(5).font_normal().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => { cx.stop_propagation(); bulk?.act(); }).child(bulk?.label ?? ""))))
      .when(!folded, (el) => el.children((this.expanded.has(group) ? files : files.slice(0, GROUP_ROWS)).map((f) => this.row(t, cx, group, f))))
      .when(!folded && files.length > GROUP_ROWS && !this.expanded.has(group), (el) => el.child(div().id(`corral-more-${group}`).px(8).py(6).text_size(12).text_color(t.accent).cursor_pointer()
        .on_click(() => { this.expanded.add(group); cx.notify(); }).child(`Show all ${files.length}`)));
  }

  /** @param {Record<string, any>} t @param {any} cx @param {Group} group @param {ChangedFile} f */
  row(t, cx, group, f) {
    const id = `${group}:${f.path}`;
    const selected = this.selected?.group === group && this.selected.path === f.path;
    const slash = f.path.lastIndexOf("/");
    const armed = Date.now() - (this.armed[`discard:${id}`] ?? 0) < CONFIRM_MS;
    /** @param {string} key @param {string} icon @param {string} tip @param {() => void} act */
    const action = (key, icon, tip, act) => div().id(`corral-${key}-${id}`).size(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => { cx.stop_propagation(); act(); })
      .child(svg(`mods/corral-git/${icon}.svg`).size(13));
    const discard = () => {
      if (!this.confirm(`discard:${id}`, cx)) return;
      this.git("Discard", group === "untracked" ? ACTIONS.clean([f.path]) : ACTIONS.discard([f.path]), cx);
    };
    return h_flex().id(`corral-file-${id}`).h(28).px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .bg(selected ? t.selected : CLEAR).hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((/** @type {import("gpui-kit").ClickEvent} */ e, /** @type {any} */ cx) => { this.open(group, f, e); cx.notify(); })
      .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(letterColor(t, f.letter)).child(f.letter === "?" ? "A" : f.letter))
      .child(h_flex().flex_1().min_w(0)
        .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(slash > 0 ? f.path.slice(0, slash + 1) : ""))
        .child(div().flex_none().child(f.path.slice(slash + 1))))
      .when(armed, (el) => el.child(div().text_size(11).text_color(t.ansi1).child("click again")))
      .when(!armed && f.add > 0, (el) => el.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(!armed && f.del > 0, (el) => el.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
      .when(group === "unstaged" || group === "untracked", (el) => el
        .child(action("discard", "undo", group === "untracked" ? "Delete file" : "Discard changes", discard))
        .child(action("stage", "plus", "Stage", () => this.git("Stage", ACTIONS.stage([f.path]), cx))))
      .when(group === "staged", (el) => el.child(action("unstage", "minus", "Unstage", () => this.git("Unstage", ACTIONS.unstage([f.path], !this.data?.branch.oid), cx))))
      .when(group === "conflicts", (el) => el.child(action("stage", "plus", "Mark resolved", () => this.git("Stage", ACTIONS.stage([f.path]), cx))));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  commits(t, cx) {
    const folded = this.folded.has("commits");
    const list = this.data?.commits ?? [];
    return v_flex().flex_none().max_h(260).border_t(1).border_color(t.border).px(6).py(4)
      .child(h_flex().id("corral-commits-head").h(28).px(8).gap(6).items_center().cursor_pointer().text_size(11).font_semibold().text_color(t.dim)
        .on_click(() => { if (folded) this.folded.delete("commits"); else this.folded.add("commits"); cx.notify(); })
        .child(svg(`mods/corral-git/chevron-${folded ? "right" : "down"}.svg`).size(10)).child("COMMITS"))
      .when(!folded, (el) => el.child(v_flex().id("corral-commits").overflow_y_scrollbar().children(list.map((c) =>
        h_flex().id(`corral-commit-${c.sha}`).h(28).px(8).gap(10).items_center().rounded(7)
          .child(div().size(8).flex_none().rounded_full().when(c.pushed, (e) => e.bg(t.dim)).when(!c.pushed, (e) => e.border_2().border_color(t.accent)))
          .child(div().flex_1().min_w(0).truncate().child(c.subject))
          .child(div().flex_none().font_family("JetBrains Mono").text_size(11).text_color(t.dim).child(c.short))
          .child(div().w(30).flex_none().text_right().text_size(11).text_color(t.dim).child(c.when))))));
  }
}

/** @param {Record<string, any>} t @param {string} letter */
function letterColor(t, letter) {
  if (letter === "A" || letter === "?") return t.ansi2;
  if (letter === "D" || letter === "U") return t.ansi1;
  if (letter === "R" || letter === "C") return t.accent;
  return t.blocked;
}
