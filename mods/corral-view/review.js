// The viewer's review mode: one file of a pull request as its PR diff, with the
// review threads under the lines they're about. Reply, resolve, apply a
// suggested change to the working copy, hand a thread to the agent, or comment
// on any line.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { run as command, notify } from "herdr";
import { alpha, CLEAR } from "./lib/theme.js";
import { sh, run, readFile, writeFile, openUrl, StaleFileError } from "./lib/host.js";
import { PR_DIFF_SCRIPT, fileSection, placeThreads, splitSuggestion, applySuggestion, linesMatch, linesOf } from "./lib/review.js";
import { parseDiff } from "./lib/diff.js";
import { GH, parseThreadsAnswer, threadPrompt, ago } from "./lib/pr.js";
import { handOff, sendLabel } from "./lib/handoff.js";
import { join } from "./lib/paths.js";

/** Rows drawn at first, and added by each "Show more". Rows aren't virtual (threads sit between them). */
const PAGE_ROWS = 500;
const ROW = 20;

/** @typedef {import("./lib/open.js").ViewRequest} ViewRequest */
/** @typedef {NonNullable<ViewRequest["review"]>} ReviewTarget */
/** @typedef {import("./lib/pr.js").Thread} Thread */
/** @typedef {import("./lib/diff.js").DiffRow} DiffRow */

export class Review {
  constructor() {
    this.reply = InputState.new({ placeholder: "Reply…" });
    this.draft = InputState.new({ placeholder: "Comment on this line…" });
    /** @type {ViewRequest | null} */ this.req = null;
    this.reply.on("submit", (/** @type {any} */ _e, /** @type {any} */ cx) => {
      const t = this.threads.find((x) => x.id === this.replyTo);
      if (this.req && t) this.sendReply(this.req, t, cx);
    });
    this.draft.on("submit", (/** @type {any} */ _e, /** @type {any} */ cx) => {
      if (this.req && this.composeAt !== null) this.comment(this.req, this.composeAt, cx);
    });
    /** @type {Map<string, string>} whole PR diffs by repo#number@head */
    this.cache = new Map();
    this.reset();
  }

  reset() {
    /** @type {DiffRow[]} */ this.rows = [];
    /** @type {Thread[]} */ this.threads = [];
    /** @type {Map<number, Thread[]>} */ this.at = new Map();
    /** @type {Thread[]} */ this.elsewhere = [];
    /** @type {boolean} */ this.viewed = false;
    /** @type {string | null} */ this.localBranch = null;
    /** @type {string | null} */ this.replyTo = null;
    /** @type {number | null} */ this.composeAt = null;
    /** @type {string | null} */ this.busy = null;
    /** @type {string | null} */ this.note = null;
    this.limit = PAGE_ROWS;
  }

  release() {
    this.reply.release();
    this.draft.release();
  }

  /** @param {ViewRequest} req @param {() => boolean} alive */
  async load(req, alive) {
    const r = /** @type {ReviewTarget} */ (req.review);
    this.req = req;
    const cwd = req.root ?? undefined;
    const key = `${r.repo}#${r.number}@${r.headSha}`;
    let diff = this.cache.get(key);
    const [d, g, b] = await Promise.all([
      diff === undefined ? sh(req.machine, PR_DIFF_SCRIPT, [`${r.host}/${r.repo}`, String(r.number), r.file], { cwd, timeout: 60000 }) : null,
      run(req.machine, "gh", GH.threads(r.host, r.repo, r.number), { cwd, timeout: 30000 }),
      sh(req.machine, "git symbolic-ref --short -q HEAD", [], { cwd }),
    ]);
    if (!alive()) return;
    if (d) {
      if (d.code !== 0) throw new Error((d.stderr || d.stdout).trim().split("\n")[0] || "Couldn't get the PR's diff");
      diff = d.stdout;
      if (diff.startsWith("diff --git ")) {
        if (this.cache.size > 4) this.cache.clear();
        this.cache.set(key, diff);
      }
    }
    const section = fileSection(diff ?? "", r.file);
    const rows = section === null ? [] : parseDiff(section);
    /** @type {DiffRow[]} */
    const note = [{ kind: "note", old: null, new: null, text: section === null ? "GitHub didn't send a diff for this file (too large, or binary)." : "No line changes (a rename or mode change)." }];
    this.rows = rows.length ? rows : note;
    this.localBranch = b.stdout.trim() || null;
    this.useThreads(g, r.file);
  }

  /** @param {string} answer GraphQL JSON @param {string} file */
  useThreads(answer, file) {
    const g = parseThreadsAnswer(answer);
    this.threads = g.threads.filter((t) => t.path === file);
    this.viewed = g.files.find((f) => f.path === file)?.viewed ?? false;
    if (g.error) this.note = `Threads unavailable: ${g.error}`;
    this.place();
  }

  /** Threads onto the rows on screen; the rest list at the top. */
  place() {
    const placed = placeThreads(this.rows.slice(0, this.limit), this.threads);
    this.at = placed.at;
    this.elsewhere = placed.elsewhere;
  }

  /**
   * Runs gh, then reloads the threads and tells the PR tab.
   * @param {ViewRequest} req @param {string} label @param {string[]} args @param {any} cx
   */
  async act(req, label, args, cx) {
    if (this.busy) return false;
    const r = /** @type {ReviewTarget} */ (req.review);
    this.busy = label;
    this.note = null;
    cx.notify();
    try {
      await run(req.machine, "gh", args, { cwd: req.root ?? undefined, timeout: 60000 });
      const g = await run(req.machine, "gh", GH.threads(r.host, r.repo, r.number), { cwd: req.root ?? undefined, timeout: 30000 });
      // Moved to another file meanwhile: these threads aren't its threads.
      if (this.req === req) this.useThreads(g, r.file);
      command("corral-pr.refresh");
      return true;
    } catch (e) {
      this.note = (e instanceof Error ? e.message : String(e)).replace(/^gh failed \(exit \d+\): /, "");
      return false;
    } finally {
      this.busy = null;
      cx.notify();
    }
  }

  /** @param {ViewRequest} req @param {Thread} t @param {any} cx */
  sendReply(req, t, cx) {
    const text = this.reply.value().trim();
    if (!text) return;
    cx.spawn(async (/** @type {any} */ cx) => {
      if (await this.act(req, "Replying…", GH.reply(req.review?.host ?? "github.com", t.id, text), cx)) { this.reply.set_value(""); this.replyTo = null; }
    });
  }

  /** @param {ViewRequest} req @param {Thread} t @param {any} cx */
  resolve(req, t, cx) {
    cx.spawn(async (/** @type {any} */ cx) => { await this.act(req, t.resolved ? "Reopening…" : "Resolving…", GH.resolve(req.review?.host ?? "github.com", t.id, !t.resolved), cx); });
  }

  /** @param {ViewRequest} req @param {any} cx */
  toggleViewed(req, cx) {
    const r = /** @type {ReviewTarget} */ (req.review);
    if (!r.id) return;
    const next = /** @type {boolean} */ (!this.viewed);
    this.viewed = next;
    cx.spawn(async (/** @type {any} */ cx) => { if (!(await this.act(req, "Saving…", GH.viewed(r.host, r.id, r.file, next), cx)) && this.req === req) this.viewed = !next; });
  }

  /** A comment on the line a row shows. @param {ViewRequest} req @param {number} index @param {any} cx */
  comment(req, index, cx) {
    const r = /** @type {ReviewTarget} */ (req.review);
    const row = this.rows[index];
    const body = this.draft.value().trim();
    if (!row || !body) return;
    const right = row.kind !== "del" && row.new !== null;
    const line = right ? row.new : row.old;
    if (line === null) return;
    cx.spawn(async (/** @type {any} */ cx) => {
      const args = GH.lineComment(r.host, r.repo, r.number, { body, sha: r.headSha, path: r.file, line, side: right ? "RIGHT" : "LEFT" });
      if (await this.act(req, "Commenting…", args, cx)) { this.draft.set_value(""); this.composeAt = null; }
    });
  }

  /** @param {Thread} t @param {ViewRequest} req @param {any} cx */
  send(t, req, cx) {
    cx.spawn(async (/** @type {any} */ cx) => {
      try { await handOff(threadPrompt(req.review?.number ?? 0, t)); } catch (e) { this.note = e instanceof Error ? e.message : String(e); }
      cx.notify();
    });
  }

  /** Whether "Apply suggestion" can work here, and why not. @param {ViewRequest} req @param {Thread} t */
  canApply(req, t) {
    const r = /** @type {ReviewTarget} */ (req.review);
    if (t.outdated || t.line === null) return "The code it was written on has changed.";
    if (t.side !== "RIGHT") return "It's on a removed line.";
    if (this.localBranch !== r.head) return `Check out ${r.head} here to apply it.`;
    return null;
  }

  /** Writes the suggested lines into the working copy, if it still has what the reviewer saw. @param {ViewRequest} req @param {Thread} t @param {string} suggestion @param {any} cx */
  apply(req, t, suggestion, cx) {
    const r = /** @type {ReviewTarget} */ (req.review);
    const why = this.req !== req ? "Open the file again to apply this." : this.canApply(req, t);
    if (why) { this.note = why; cx.notify(); return; }
    const end = /** @type {number} */ (t.line);
    const start = t.startLine ?? end;
    const path = join(req.root ?? "", r.file);
    this.busy = "Applying…";
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const text = await readFile(req.machine, path);
        if (text === null) throw new Error(`${r.file} isn't in your working copy.`);
        if (!linesMatch(text, this.rows, start, end)) throw new Error(`Your copy of ${r.file} differs at ${start === end ? `line ${end}` : `lines ${start}–${end}`} from what was reviewed (unpushed edits?). Open the file and apply it by hand.`);
        await writeFile(req.machine, path, applySuggestion(text, start, end, suggestion), text);
        notify({ title: "Suggestion applied", body: `${r.file}: commit and push to update PR #${r.number}.`, level: "success", timeout: 6000 });
      } catch (e) {
        this.note = e instanceof StaleFileError ? `${r.file} changed while applying. Try again.` : e instanceof Error ? e.message : String(e);
      } finally {
        this.busy = null;
        cx.notify();
      }
    });
  }

  // ---- Render -------------------------------------------------------------

  /**
   * @param {Record<string, any>} t @param {any} cx @param {ViewRequest} req
   * @param {(file: string) => void} go  open another file of the PR
   * @param {string} mono
   * @param {() => void} edit  open the working copy of this file
   */
  header(t, cx, req, go, mono, edit) {
    const r = /** @type {ReviewTarget} */ (req.review);
    const i = r.files.indexOf(r.file);
    const dir = r.file.includes("/") ? r.file.slice(0, r.file.lastIndexOf("/") + 1) : "";
    /** @param {string} id @param {string} label @param {boolean} on @param {() => void} click */
    const nav = (id, label, on, click) => div().id(id).size(24).flex().flex_none().items_center().justify_center().rounded(6)
      .text_color(on ? t.foreground : t.dim).when(on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_click(() => { if (on) click(); }).child(label);
    return v_flex().flex_none().px(12).py(7).gap(5).border_b(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(div().text_color(t.dim).child(`PR #${r.number} · review`))
        .child(div().flex_1())
        .when(i >= 0 && r.files.length > 1, (el) => el
          .child(nav("corral-review-prev", "‹", i > 0, () => go(r.files[i - 1])))
          .child(div().text_color(t.muted).child(`${i + 1} of ${r.files.length}`))
          .child(nav("corral-review-next", "›", i < r.files.length - 1, () => go(r.files[i + 1])))))
      .child(h_flex().gap(10).items_center()
        .child(h_flex().flex_1().min_w(0).items_center().font_family(mono).text_size(12)
          .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(dir))
          .child(div().flex_none().child(r.file.slice(dir.length))))
        .when(Boolean(r.id), (el) => el.child(h_flex().id("corral-review-viewed").gap(6).items_center().cursor_pointer().text_size(12)
          .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => this.toggleViewed(req, cx))
          .child(div().size(14).flex().items_center().justify_center().rounded(4).border_1()
            .border_color(this.viewed ? t.accent : t.input).bg(this.viewed ? t.accent : CLEAR).text_size(10).text_color(t.solid_foreground)
            .child(this.viewed ? "✓" : ""))
          .child("Viewed")))
        .child(this.button(t, "corral-review-edit", "Edit file", () => edit()))
        .child(this.button(t, "corral-review-web", "GitHub", () => openUrl(`${r.url}/files`))));
  }

  /**
   * @param {Record<string, any>} t @param {string} id @param {string} label @param {(e: any, cx: any) => void} click
   * @param {boolean} [primary]
   */
  button(t, id, label, click, primary = false) {
    const off = Boolean(this.busy);
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(7).text_size(12)
      .when(primary, (el) => el.bg(off ? t.raised : t.solid).text_color(off ? t.dim : t.solid_foreground))
      .when(!primary, (el) => el.border_1().border_color(t.input).text_color(off ? t.dim : t.foreground))
      .when(!off, (el) => el.cursor_pointer().hover((s) => (primary ? s : s.bg(t.hover))))
      .on_click((/** @type {any} */ e, /** @type {any} */ cx) => { if (!off) click(e, cx); })
      .child(label);
  }

  /** @param {Record<string, any>} t @param {any} cx @param {ViewRequest} req @param {string} mono @param {string} ui */
  body(t, cx, req, mono, ui) {
    const rows = this.rows.slice(0, this.limit);
    const addBg = alpha(t.ansi2, 0.12), delBg = alpha(t.ansi1, 0.12);
    /** A line number; clicking it opens a comment box under the line. @param {number | null} n @param {number} i @param {string} side */
    const num = (n, i, side) => div().id(`corral-ln-${side}-${i}`).w(40).flex_none().text_right().pr(6).text_color(t.dim)
      .when(n !== null, (el) => el.cursor_pointer().hover((s) => s.text_color(t.accent))
        .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => {
          this.composeAt = this.composeAt === i ? null : i;
          this.draft.set_value("");
          if (this.composeAt !== null) this.draft.focus();
          cx.notify();
        }))
      .child(n === null ? "" : String(n));
    /** @param {DiffRow} r @param {number} i */
    const row = (r, i) => {
      if (r.kind === "hunk") return div().w_full().min_h(ROW).px(12).flex().items_center().bg(t.raised).text_color(t.dim).truncate().child(r.text);
      if (r.kind === "note") return div().w_full().min_h(ROW).px(12).py(6).flex().items_center().text_color(t.dim).font_family(ui).child(r.text);
      return h_flex().w_full().min_h(ROW).items_start()
        .when(r.kind === "add", (el) => el.bg(addBg)).when(r.kind === "del", (el) => el.bg(delBg))
        .when(this.composeAt === i, (el) => el.bg(alpha(t.accent, 0.14)))
        .child(num(r.old, i, "o")).child(num(r.new, i, "n"))
        .child(div().w(14).flex_none().text_color(r.kind === "add" ? t.ansi2 : r.kind === "del" ? t.ansi1 : t.dim).child(r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""))
        .child(div().flex_1().min_w(0).pr(10).overflow_hidden().child(r.text));
    };
    return v_flex().id("corral-review-body").flex_1().min_h(0).overflow_y_scrollbar().font_family(mono).text_size(12.5).pb(24)
      .when(Boolean(this.note), (el) => el.child(h_flex().mx(10).mt(8).px(10).py(7).gap(8).items_start().rounded(8).bg(alpha(t.ansi1, 0.12)).font_family(ui).text_size(12)
        .child(div().flex_1().min_w(0).child(this.note ?? ""))
        .child(div().id("corral-review-note-x").flex_none().text_color(t.dim).cursor_pointer().on_click(() => { this.note = null; cx.notify(); }).child("✕"))))
      .when(this.elsewhere.length > 0, (el) => el
        .child(div().px(12).pt(10).pb(2).font_family(ui).text_size(11).font_semibold().text_color(t.dim).child(`ON OLDER CODE OR LINES NOT SHOWN · ${this.elsewhere.length}`))
        .children(this.elsewhere.map((x) => this.card(t, cx, req, x, ui, mono))))
      .children(rows.flatMap((r, i) => {
        const out = [row(r, i)];
        for (const x of this.at.get(i) ?? []) out.push(this.card(t, cx, req, x, ui, mono));
        if (this.composeAt === i) out.push(this.composer(t, cx, req, i, ui));
        return out;
      }))
      .when(this.rows.length > this.limit, (el) => el.child(div().id("corral-review-more").mx(12).my(10).px(10).py(6).self_start().rounded(7)
        .border_1().border_color(t.input).font_family(ui).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => { this.limit += PAGE_ROWS; this.place(); cx.notify(); })
        .child(`Show more (${this.rows.length - this.limit} lines left)`)));
  }

  /** @param {Record<string, any>} t @param {string} who */
  avatar(t, who) {
    const letters = who.replace(/\[bot\]$/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
    return div().size(18).flex_none().flex().items_center().justify_center().rounded(9).bg(t.raised).text_size(7.5).font_semibold().text_color(t.muted).child(letters);
  }

  /** @param {Record<string, any>} t @param {any} cx @param {ViewRequest} req @param {Thread} x @param {string} ui @param {string} mono */
  card(t, cx, req, x, ui, mono) {
    const replying = this.replyTo === x.id;
    const end = x.line;
    const start = x.startLine ?? end;
    const where = end === null ? "" : start !== end ? `Lines ${start}–${end}` : `Line ${end}`;
    const suggestion = x.comments.map((c) => splitSuggestion(c.body).suggestion).find((s) => s !== null) ?? null;
    const blocked = suggestion !== null ? this.canApply(req, x) : null;
    return v_flex().mx(10).my(6).p(10).gap(9).rounded(10).border_1().border_color(x.resolved ? t.border : t.input).bg(t.surface)
      .font_family(ui).text_size(12.5)
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().child(where + (x.side === "LEFT" ? " (removed)" : "")))
        .when(x.outdated, (el) => el.child(div().px(5).rounded(4).bg(t.raised).child("outdated")))
        .when(x.resolved, (el) => el.child(div().px(5).rounded(4).bg(alpha(t.ansi2, 0.15)).text_color(t.ansi2).child("resolved"))))
      .children(x.comments.map((c) => {
        const part = splitSuggestion(c.body);
        const old = part.suggestion !== null && end !== null ? linesOf(this.rows, start ?? end, end) : [];
        return v_flex().gap(5)
          .child(h_flex().gap(6).items_center().text_size(12)
            .child(this.avatar(t, c.who)).child(div().font_medium().child(c.who)).child(div().text_color(t.dim).child(ago(c.at))))
          .when(Boolean(part.before), (el) => el.child(TextView.markdown(`corral-rc-${c.id}-a`, part.before).selectable(true).on_link_click((/** @type {string} */ u) => openUrl(u)).w_full()))
          .when(part.suggestion !== null, (el) => el.child(v_flex().rounded(8).border_1().border_color(t.border).overflow_hidden().font_family(mono).text_size(12)
            .child(div().px(8).py(4).bg(t.raised).font_family(ui).text_size(11).text_color(t.dim).child("Suggested change"))
            .children(old.map((l) => h_flex().px(8).bg(alpha(t.ansi1, 0.12)).child(div().w(14).flex_none().text_color(t.ansi1).child("−")).child(div().flex_1().min_w(0).child(l))))
            .children((part.suggestion ?? "").split("\n").filter((l, i, all) => part.suggestion !== "" || i < all.length - 1)
              .map((l) => h_flex().px(8).bg(alpha(t.ansi2, 0.12)).child(div().w(14).flex_none().text_color(t.ansi2).child("+")).child(div().flex_1().min_w(0).child(l || " "))))))
          .when(Boolean(part.after), (el) => el.child(TextView.markdown(`corral-rc-${c.id}-b`, part.after).selectable(true).on_link_click((/** @type {string} */ u) => openUrl(u)).w_full()));
      }))
      .when(replying, (el) => el.child(div().h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.chrome)
        .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
        .child(Input.new(this.reply).w_full().text_size(12.5))))
      .child(h_flex().gap(6).flex_wrap()
        .when(x.canReply, (el) => el.child(replying
          ? this.button(t, `corral-rr-send-${x.id}`, "Send reply", (_e, cx) => this.sendReply(req, x, cx), true)
          : this.button(t, `corral-rr-${x.id}`, "Reply", (_e, cx) => { this.replyTo = x.id; this.reply.set_value(""); this.reply.focus(); cx.notify(); })))
        .when(replying, (el) => el.child(this.button(t, `corral-rr-x-${x.id}`, "Cancel", (_e, cx) => { this.replyTo = null; cx.notify(); })))
        .when(suggestion !== null && !x.resolved, (el) => el.child(this.button(t, `corral-apply-${x.id}`, this.busy === "Applying…" ? "Applying…" : "Apply suggestion",
          (_e, cx) => this.apply(req, x, /** @type {string} */ (suggestion), cx), !blocked)))
        .when(!x.resolved, (el) => el.child(this.button(t, `corral-rs-${x.id}`, sendLabel(), (_e, cx) => this.send(x, req, cx))))
        .child(div().flex_1())
        .when(x.canResolve, (el) => el.child(this.button(t, `corral-rv-${x.id}`, x.resolved ? "Unresolve" : "Resolve", (_e, cx) => this.resolve(req, x, cx)))))
      .when(Boolean(blocked) && suggestion !== null && !x.resolved, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(blocked ?? "")));
  }

  /** @param {Record<string, any>} t @param {any} cx @param {ViewRequest} req @param {number} i @param {string} ui */
  composer(t, cx, req, i, ui) {
    const r = this.rows[i];
    const line = r.kind !== "del" && r.new !== null ? `line ${r.new}` : `removed line ${r.old}`;
    return v_flex().mx(10).my(6).p(10).gap(8).rounded(10).border_1().border_color(t.accent).bg(t.surface).font_family(ui).text_size(12.5)
      .child(div().text_size(11.5).text_color(t.dim).child(`Comment on ${line}. It's posted right away.`))
      .child(div().h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.chrome)
        .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
        .child(Input.new(this.draft).w_full().text_size(12.5)))
      .child(h_flex().gap(6)
        .child(this.button(t, `corral-cm-go-${i}`, this.busy === "Commenting…" ? "Commenting…" : "Comment", (_e, cx) => this.comment(req, i, cx), true))
        .child(this.button(t, `corral-cm-x-${i}`, "Cancel", (_e, cx) => { this.composeAt = null; cx.notify(); })));
  }
}
