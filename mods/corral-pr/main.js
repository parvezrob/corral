// Pull request: the PR for the shown space's branch, from opening it to merging.
// Checks (a failing one opens its log beside the terminal), reviews, review
// threads you can reply to, resolve or hand to your agent, and merge. Without a
// PR it offers to open one. Everything runs through `gh` on the machine the repo
// lives on, so it works the same for remote spaces.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { layout, shared, setShared, notify, nextCommand } from "herdr";
import { colors, alpha, CLEAR } from "./lib/theme.js";
import { here } from "./lib/context.js";
import { sh, run, openUrl } from "./lib/host.js";
import { panelState } from "./lib/layout.js";
import { join } from "./lib/paths.js";
import { openView } from "./lib/open.js";
import { changeLetter } from "./lib/review.js";
import { handOff, sendLabel } from "./lib/handoff.js";
import {
  PR_SCRIPT, THREADS_QUERY, SAVE_LOG_SCRIPT, parsePrState, summarizeChecks, prSteps, blockers, canMergeNow,
  GH, draftPr, failurePrompt, threadPrompt, ago, duration,
} from "./lib/pr.js";

const SHOWN_MS = 20000;     // refresh while the PR tab is on screen
const RUNNING_MS = 8000;    // ... and checks are running
const HIDDEN_MS = 60000;    // otherwise: enough for the status bar and toasts
const CONFIRM_MS = 3000;
const SUMMARY_KEY = "corral.pr";

/** @typedef {import("./lib/pr.js").PullRequest} PullRequest */
/** @typedef {import("./lib/pr.js").Check} Check */
/** @typedef {import("./lib/pr.js").Thread} Thread */
/** @typedef {import("./lib/pr.js").MergeMethod} MergeMethod */

const METHOD_LABEL = { squash: "Squash", merge: "Merge commit", rebase: "Rebase" };
const MERGE_BUTTON = { squash: "Squash and merge", merge: "Merge pull request", rebase: "Rebase and merge" };

export default class PullRequestPanel extends View {
  /** @param {any} _props @param {any} cx */
  init(_props, cx) {
    /** @type {string | null} */ this.key = null;
    /** @type {string | null} */ this.machine = null;
    /** @type {string | null} */ this.root = null;
    /** @type {import("./lib/pr.js").PrState | null} */ this.data = null;
    /** @type {string | null} */ this.error = null;
    /** @type {string | null} */ this.note = null;
    /** @type {string | null} */ this.busy = null;
    this.loading = false;
    this.again = false;
    this.lastRefresh = 0;
    /** @type {"overview" | "threads" | "files"} */ this.tab = "overview";
    /** @type {MergeMethod | null} */ this.method = null;
    /** @type {Record<string, number>} */ this.armed = {};
    /** @type {Set<string>} */ this.openResolved = new Set();
    /** @type {string | null} */ this.replyTo = null;
    this.reply = InputState.new({ placeholder: "Reply…" });
    this.reply.on("submit", (/** @type {any} */ _e, /** @type {any} */ cx) => { if (this.replyTo) this.sendReply(this.replyTo, cx); });
    this.comment = InputState.new({ placeholder: "Leave a comment" });
    this.comment.on("submit", (/** @type {any} */ _e, /** @type {any} */ cx) => this.postComment(cx));
    this.title = InputState.new({ placeholder: "Title" });
    this.body = TextareaState.new({ placeholder: "Description (markdown)" });
    this.body.set_auto_grow(4, 12);
    this.draft = false;
    /** @type {string | null} */ this.draftedFor = null;   // the branch the create form was filled for
    /** @type {{ id: string, checks: string, decision: string, state: string } | null} */ this.prev = null;
    this.sync(cx);
    cx.timer.every(1000, (/** @type {any} */ cx) => this.tick(cx));
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        else if (command === "threads" || command === "overview" || command === "files") this.tab = command;
        else if (command.startsWith("review:")) this.openReview(command.slice(7));
        else if (command === "show-resolved") { this.tab = "threads"; for (const x of this.pr?.threads ?? []) if (x.resolved) this.openResolved.add(x.id); }
        else if (command.startsWith("log:")) { const c = this.pr?.checks[Number(command.slice(4))]; if (c) this.openLog(c); }
        cx.notify();
      }
    });
  }

  async close() {
    this.reply.release();
    this.comment.release();
    this.title.release();
    this.body.release();
  }

  get pr() { return this.data?.pr ?? null; }

  /** @param {any} cx */
  tick(cx) {
    this.sync(cx);
    if (!this.root) return;
    const s = panelState(layout());
    const shown = s.open && s.active === "pr";
    const running = this.pr ? summarizeChecks(this.pr.checks).overall === "running" : false;
    const every = shown ? (running ? RUNNING_MS : SHOWN_MS) : HIDDEN_MS;
    if (Date.now() - this.lastRefresh >= every) this.refresh(cx);
  }

  /** Follows the shown space, and its branch. @param {any} cx */
  sync(cx) {
    const h = here();
    const key = `${h.key}\x1f${h.space?.branch ?? ""}`;
    if (key === this.key) return;
    const sameRepo = this.key?.split("\x1f")[0] === h.key;
    this.key = key;
    this.machine = h.machine;
    if (!sameRepo) { this.root = null; this.data = null; this.error = null; this.note = null; this.prev = null; this.publish(null); }
    if (!h.cwd) return;
    cx.spawn(async (/** @type {any} */ cx) => {
      const r = await sh(h.machine, 'git -C "$1" rev-parse --show-toplevel 2>/dev/null', [h.cwd]).catch(() => /** @type {null} */ (null));
      if (key !== this.key) return;
      const top = r?.stdout.trim();
      if (!top) { this.root = null; this.error = "Not a git repository"; cx.notify(); return; }
      this.root = top;
      this.refresh(cx);
    });
  }

  /** @param {any} cx */
  refresh(cx) {
    if (!this.root) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    this.lastRefresh = Date.now();
    const key = this.key, root = this.root;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const r = await sh(this.machine, PR_SCRIPT, [root, THREADS_QUERY], { timeout: 30000 });
        if (key !== this.key) return;
        if (r.code === 3) throw new Error("Not a git repository");
        if (r.code === 4) throw new Error(`The GitHub CLI (gh) isn't installed on ${this.machine ?? "this computer"}.`);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "Couldn't read the pull request");
        const data = parsePrState(r.stdout);
        this.announce(data.pr);
        this.data = data;
        this.error = null;
        this.fillCreateForm();
        this.publish(data.pr);
      } catch (e) {
        if (key === this.key) this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  /** Toasts for what changed since the last look: checks done, a review, a merge. @param {PullRequest | null} pr */
  announce(pr) {
    if (!pr) { this.prev = null; return; }
    const now = { id: `${pr.repo}#${pr.number}`, checks: summarizeChecks(pr.checks).overall, decision: pr.reviewDecision, state: pr.state };
    const was = this.prev;
    this.prev = now;
    if (!was || was.id !== now.id) return;
    const action = { name: "corral-status.panel-pr" };
    const n = `PR #${pr.number}`;
    if (was.state === "open" && now.state === "merged") notify({ title: `${n} merged`, body: pr.title, level: "success", action });
    if (was.checks !== "fail" && now.checks === "fail") {
      const failed = pr.checks.filter((c) => c.state === "fail");
      notify({ title: `${failed[0]?.name ?? "A check"} failed on ${n}`, body: failed.length > 1 ? `and ${failed.length - 1} more` : pr.title, level: "error", action });
    } else if (was.checks === "running" && now.checks === "pass") {
      notify({ title: `Checks passed on ${n}`, body: pr.title, level: "success", action });
    }
    if (was.decision !== now.decision && now.decision === "APPROVED") notify({ title: `${n} approved`, body: pr.title, level: "success", action });
    if (was.decision !== now.decision && now.decision === "CHANGES_REQUESTED") notify({ title: `Changes requested on ${n}`, body: pr.title, level: "warning", action });
  }

  /** The one-line summary the status bar and tab strip show. @param {PullRequest | null} pr */
  publish(pr) {
    const s = pr ? summarizeChecks(pr.checks) : null;
    const next = pr && s ? {
      number: pr.number, state: pr.draft ? "draft" : pr.state, checks: s.overall, failing: s.counts.fail,
      threads: pr.threads.filter((t) => !t.resolved).length, ready: canMergeNow(pr) && !blockers(pr).length,
      review: pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviews.some((r) => r.state === "requested"),
    } : null;
    if (JSON.stringify(next) !== JSON.stringify(shared(SUMMARY_KEY) ?? null)) setShared(SUMMARY_KEY, next);
  }

  fillCreateForm() {
    const d = this.data;
    if (!d || d.pr || !d.branch || this.draftedFor === d.branch) return;
    this.draftedFor = d.branch;
    const { title, body } = draftPr(d.branch, d.commits);
    this.title.set_value(title);
    this.body.set_value(body);
  }

  // ---- Actions ------------------------------------------------------------

  /**
   * Runs gh in the repo; shows failures in the panel, then refreshes.
   * @param {string} label what's running, shown on its button
   * @param {string[]} args @param {any} cx
   */
  async gh(label, args, cx) {
    if (!this.root || this.busy) return false;
    this.busy = label;
    this.note = null;
    cx.notify();
    try {
      await run(this.machine, "gh", args, { cwd: this.root, timeout: 120000 });
      return true;
    } catch (e) {
      this.note = (e instanceof Error ? e.message : String(e)).replace(/^gh failed \(exit \d+\): /, "");
      return false;
    } finally {
      this.busy = null;
      this.refresh(cx);
      cx.notify();
    }
  }

  /** First click arms, a second within a few seconds acts. @param {string} id @param {any} cx */
  confirm(id, cx) {
    const at = this.armed[id] ?? 0;
    if (Date.now() - at < CONFIRM_MS) { delete this.armed[id]; return true; }
    this.armed[id] = Date.now();
    cx.timer.after(CONFIRM_MS, (/** @type {any} */ cx) => { delete this.armed[id]; cx.notify(); });
    cx.notify();
    return false;
  }

  /** @param {PullRequest} pr */
  chosenMethod(pr) {
    return this.method && pr.methods.includes(this.method) ? this.method : pr.preferred;
  }

  /** @param {any} cx */
  merge(cx) {
    const pr = this.pr;
    if (!pr || !this.confirm("merge", cx)) return;
    cx.spawn(async (/** @type {any} */ cx) => {
      if (await this.gh("Merging…", GH.merge(pr.number, this.chosenMethod(pr), false), cx)) {
        notify({ title: `PR #${pr.number} merged`, body: pr.title, level: "success" });
      }
    });
  }

  /** @param {any} cx */
  toggleAutoMerge(cx) {
    const pr = this.pr;
    if (!pr) return;
    cx.spawn(async (/** @type {any} */ cx) => {
      await this.gh(pr.autoMerge ? "Turning off…" : "Turning on…", pr.autoMerge ? GH.disableAuto(pr.number) : GH.merge(pr.number, this.chosenMethod(pr), true), cx);
    });
  }

  /** @param {any} cx */
  markReady(cx) {
    const pr = this.pr;
    if (pr) cx.spawn(async (/** @type {any} */ cx) => { await this.gh("Marking ready…", GH.ready(pr.number), cx); });
  }

  /** @param {Check} check @param {any} cx */
  rerun(check, cx) {
    if (check.run) cx.spawn(async (/** @type {any} */ cx) => { await this.gh("Re-running…", GH.rerunFailed(check.run ?? ""), cx); });
  }

  /** @param {any} cx */
  postComment(cx) {
    const pr = this.pr, text = this.comment.value().trim();
    if (!pr || !text) return;
    cx.spawn(async (/** @type {any} */ cx) => {
      if (await this.gh("Commenting…", GH.comment(pr.number, text), cx)) this.comment.set_value("");
    });
  }

  /** @param {"approve" | "request-changes"} kind @param {any} cx */
  review(kind, cx) {
    const pr = this.pr;
    if (!pr) return;
    const text = this.comment.value().trim();
    if (kind === "request-changes" && !text) { this.note = "Say what should change in the comment box first."; cx.notify(); return; }
    cx.spawn(async (/** @type {any} */ cx) => {
      if (await this.gh(kind === "approve" ? "Approving…" : "Requesting changes…", GH.review(pr.number, kind, text), cx)) this.comment.set_value("");
    });
  }

  /** @param {string} threadId @param {any} cx */
  sendReply(threadId, cx) {
    const pr = this.pr, text = this.reply.value().trim();
    if (!pr || !text) return;
    cx.spawn(async (/** @type {any} */ cx) => {
      if (await this.gh("Replying…", GH.reply(pr.host, threadId, text), cx)) { this.reply.set_value(""); this.replyTo = null; }
    });
  }

  /** @param {Thread} t @param {any} cx */
  resolve(t, cx) {
    const pr = this.pr;
    if (pr) cx.spawn(async (/** @type {any} */ cx) => { await this.gh(t.resolved ? "Reopening…" : "Resolving…", GH.resolve(pr.host, t.id, !t.resolved), cx); });
  }

  /** Pushes if needed, then opens the PR. @param {any} cx */
  create(cx) {
    const d = this.data;
    const title = this.title.value().trim();
    if (!d?.branch || !this.root || this.busy) return;
    if (!title) { this.note = "A pull request needs a title."; cx.notify(); return; }
    const root = this.root, branch = d.branch;
    this.busy = "Creating…";
    this.note = null;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        if (!d.upstream) await run(this.machine, "git", ["push", "-u", "origin", "HEAD"], { cwd: root, timeout: 120000 });
        else if (d.unpushed > 0) await run(this.machine, "git", ["push"], { cwd: root, timeout: 120000 });
        const out = await run(this.machine, "gh", GH.create({ title, body: this.body.value(), head: branch, base: d.defaultBranch, draft: this.draft }), { cwd: root, timeout: 60000 });
        notify({ title: this.draft ? "Draft pull request opened" : "Pull request opened", body: out.trim().split("\n").pop() ?? title, level: "success" });
        this.tab = "overview";
      } catch (e) {
        this.note = (e instanceof Error ? e.message : String(e)).replace(/^(gh|git) failed \(exit \d+\): /, "");
      } finally {
        this.busy = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  /** @param {Check} check */
  openLog(check) {
    const pr = this.pr;
    if (!pr || !check.job) { if (check.url) openUrl(check.url); return; }
    openView({
      path: check.url, machine: this.machine, root: this.root, mode: "log",
      log: { host: pr.host, repo: pr.repo, job: check.job, run: check.run ?? "", check: check.name, pr: pr.number },
    });
  }

  /** @param {Check} check @param {any} cx */
  sendFailure(check, cx) {
    const pr = this.pr;
    if (!pr || !check.job || !this.root) return;
    const root = this.root;
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        const r = await sh(this.machine, SAVE_LOG_SCRIPT, [pr.host, pr.repo, check.job ?? ""], { cwd: root, timeout: 60000 });
        if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim() || "Couldn't save the log");
        await handOff(failurePrompt({ pr: pr.number, check: check.name, log: r.stdout.trim() }));
      } catch (e) {
        this.note = e instanceof Error ? e.message : String(e);
      }
      cx.notify();
    });
  }

  /** @param {Thread} t @param {any} cx */
  sendThread(t, cx) {
    const pr = this.pr;
    if (!pr) return;
    cx.spawn(async (/** @type {any} */ cx) => {
      try { await handOff(threadPrompt(pr.number, t)); } catch (e) { this.note = e instanceof Error ? e.message : String(e); }
      cx.notify();
    });
  }

  /** A file of the PR as its PR diff, with its threads, beside the terminal. @param {string} file */
  openReview(file) {
    const pr = this.pr;
    if (!pr || !this.root) return;
    const files = pr.fileList.map((f) => f.path);
    openView({
      path: join(this.root, file), machine: this.machine, root: this.root, mode: "prdiff",
      review: { number: pr.number, host: pr.host, repo: pr.repo, id: pr.id, head: pr.head, headSha: pr.headSha, url: pr.url, file, files: files.includes(file) ? files : [...files, file] },
    });
  }

  /** @param {string} path @param {any} cx */
  toggleViewed(path, cx) {
    const pr = this.pr;
    const f = pr?.fileList.find((x) => x.path === path);
    if (!pr || !f || !pr.id) return;
    f.viewed = !f.viewed;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => { if (!(await this.gh("Saving…", GH.viewed(pr.host, pr.id, path, f.viewed), cx))) f.viewed = !f.viewed; });
  }

  // ---- Render -------------------------------------------------------------

  /** @param {any} cx */
  render(cx) {
    const t = colors();
    const root = v_flex().id("corral-pr").size_full().min_h(0).text_color(t.foreground).text_size(13);
    if (this.error && !this.data) return root.child(this.message(t, this.error, cx));
    if (!this.data) return root.child(div().p(14).text_size(12).text_color(t.dim).child(this.root || this.key ? "Looking for a pull request…" : "Open a space to see its pull request."));
    const pr = this.data.pr;
    if (!pr) return root.child(this.noPr(t, cx));
    const open = pr.threads.filter((x) => !x.resolved).length;
    return root
      .child(this.header(t, pr))
      .child(h_flex().flex_none().px(10).gap(4).border_b(1).border_color(t.border).text_size(12.5)
        .child(this.subTab(t, "overview", "Overview", cx))
        .child(this.subTab(t, "threads", open ? `Threads · ${open}` : "Threads", cx))
        .child(this.subTab(t, "files", `Files · ${pr.fileCount}`, cx)))
      .when(Boolean(this.note), (el) => el.child(this.noteBar(t, cx)))
      .child(v_flex().id("corral-pr-body").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(14)
        .child(this.tab === "threads" ? this.threads(t, pr, cx) : this.tab === "files" ? this.files(t, pr, cx) : this.overview(t, pr, cx)));
  }

  /** @param {Record<string, any>} t @param {string} text @param {any} cx */
  message(t, text, cx) {
    return v_flex().p(14).gap(10).text_size(12.5).text_color(t.muted)
      .child(div().child(text))
      .child(div().id("corral-pr-retry").w_auto().self_start().h(26).px(10).flex().items_center().rounded(7).border_1().border_color(t.input).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => this.refresh(cx)).child("Try again"));
  }

  /** @param {Record<string, any>} t @param {any} cx */
  noteBar(t, cx) {
    return h_flex().flex_none().mx(12).mt(8).px(10).py(7).gap(8).items_start().rounded(8).bg(alpha(t.ansi1, 0.12)).text_size(12)
      .child(div().flex_1().min_w(0).child(this.note ?? ""))
      .child(div().id("corral-pr-note-x").flex_none().text_color(t.dim).cursor_pointer().on_click(() => { this.note = null; cx.notify(); }).child("✕"));
  }

  /** @param {Record<string, any>} t @param {"overview" | "threads" | "files"} id @param {string} label @param {any} cx */
  subTab(t, id, label, cx) {
    const on = this.tab === id;
    return div().id(`corral-pr-tab-${id}`).h(32).px(8).flex().items_center().cursor_pointer()
      .border_b(2).border_color(on ? t.accent : CLEAR).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_medium())
      .hover((s) => s.text_color(t.foreground))
      .on_click(() => { this.tab = id; cx.notify(); }).child(label);
  }

  /** @param {Record<string, any>} t @param {PullRequest} pr */
  header(t, pr) {
    const badge = pr.state === "merged" ? ["Merged", t.ansi5] : pr.state === "closed" ? ["Closed", t.ansi1] : pr.draft ? ["Draft", t.dim] : ["Open", t.ansi2];
    /** @type {Record<string, any>} */
    const stepColor = { done: t.ansi2, fail: t.ansi1, wait: t.blocked, todo: t.dim };
    const steps = prSteps(pr);
    return v_flex().flex_none().px(12).pt(12).pb(10).gap(7).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_start()
        .child(div().flex_1().min_w(0).text_size(13.5).font_medium().child(pr.title))
        .child(div().flex_none().px(7).py(1).rounded(10).text_size(11).font_medium().text_color(badge[1]).bg(alpha(badge[1], 0.14)).child(badge[0]))
        .child(div().id("corral-pr-web").flex_none().size(22).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => openUrl(pr.url))
          .child(svg("mods/corral-pr/external.svg").size(13))))
      .child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim).min_w(0)
        .child(div().flex_none().child(`#${pr.number}`))
        .child(div().flex_shrink(1).min_w(0).truncate().font_family("JetBrains Mono").text_size(11.5).child(`${pr.head} → ${pr.base}`))
        .child(div().flex_none().text_color(t.ansi2).child(`+${pr.additions}`))
        .child(div().flex_none().text_color(t.ansi1).child(`−${pr.deletions}`)))
      .child(h_flex().pt(2).gap(6).items_center().text_size(11.5)
        .children(steps.flatMap((s, i) => {
          const c = stepColor[s.state];
          const step = h_flex().flex_none().gap(5).items_center().text_color(s.state === "todo" ? t.dim : t.foreground)
            .child(div().size(8).rounded(4).when(s.state === "todo", (el) => el.border_1().border_color(c)).when(s.state !== "todo", (el) => el.bg(c)))
            .child(s.label);
          return i ? [div().flex_1().min_w(6).h(1).bg(t.border), step] : [step];
        })));
  }

  /** @param {Record<string, any>} t @param {string} text @param {string} [right] */
  heading(t, text, right) {
    return h_flex().pt(14).pb(6).gap(8).items_center().text_size(11).font_semibold().text_color(t.dim)
      .child(div().child(text)).child(div().flex_1())
      .when(Boolean(right), (el) => el.child(div().font_normal().child(right ?? "")));
  }

  /**
   * @param {Record<string, any>} t @param {string} id @param {string} label
   * @param {(e: any, cx: any) => void} click @param {{ primary?: boolean, disabled?: boolean, danger?: boolean }} [o]
   */
  button(t, id, label, click, o = {}) {
    const busy = Boolean(this.busy);
    const off = o.disabled || busy;
    return div().id(id).h(28).px(11).flex().flex_none().items_center().justify_center().rounded(7).text_size(12)
      .when(Boolean(o.primary) && !off, (el) => el.bg(o.danger ? t.ansi1 : t.solid).text_color(t.solid_foreground).cursor_pointer())
      .when(Boolean(o.primary) && off, (el) => el.bg(t.raised).text_color(t.dim))
      .when(!o.primary, (el) => el.border_1().border_color(t.input).text_color(off ? t.dim : t.foreground).when(!off, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))))
      .on_click((/** @type {any} */ e, /** @type {any} */ cx) => { if (!off) click(e, cx); })
      .child(label);
  }

  /** @param {Record<string, any>} t @param {PullRequest} pr @param {any} cx */
  overview(t, pr, cx) {
    const s = summarizeChecks(pr.checks);
    const failed = pr.checks.find((c) => c.state === "fail" && c.run);
    const open = pr.threads.filter((x) => !x.resolved).length;
    return v_flex()
      .child(this.heading(t, "CHECKS", s.text))
      .when(Boolean(failed), (el) => el.child(h_flex().pb(6).gap(6)
        .child(this.button(t, "corral-pr-rerun", this.busy === "Re-running…" ? "Re-running…" : "Re-run failed", (_e, cx) => failed && this.rerun(failed, cx)))
        .child(this.button(t, "corral-pr-send-fail", sendLabel(), (_e, cx) => failed && this.sendFailure(failed, cx)))))
      .when(!pr.checks.length, (el) => el.child(div().py(4).text_size(12).text_color(t.dim).child("No checks on this commit.")))
      .children(pr.checks.map((c, i) => this.checkRow(t, c, i)))
      .child(this.heading(t, "REVIEW"))
      .when(!pr.reviews.length, (el) => el.child(div().py(4).text_size(12).text_color(t.dim).child("No reviews yet.")))
      .children(pr.reviews.map((r) => this.reviewRow(t, r)))
      .when(open > 0, (el) => el.child(div().id("corral-pr-open-threads").mt(4).py(4).text_size(12).text_color(t.accent).cursor_pointer()
        .on_click(() => { this.tab = "threads"; cx.notify(); })
        .child(`${open} unresolved ${open === 1 ? "thread" : "threads"} →`)))
      .when(Boolean(pr.threadsError), (el) => el.child(div().py(4).text_size(11.5).text_color(t.dim).child(`Threads unavailable: ${pr.threadsError}`)))
      .child(this.mergeBox(t, pr, cx))
      .when(pr.state === "open", (el) => el.child(this.commentBox(t, pr, cx)));
  }

  /** @param {Record<string, any>} t @param {Check} c @param {number} i */
  checkRow(t, c, i) {
    /** @type {Record<string, [string, any]>} */
    const look = {
      pass: ["✓", t.ansi2], fail: ["✕", t.ansi1], running: ["●", t.blocked], queued: ["○", t.dim],
      cancelled: ["⊘", t.dim], skipped: ["–", t.dim], neutral: ["–", t.dim],
    };
    const [glyph, color] = look[c.state];
    const right = c.state === "running" ? "running" : c.state === "queued" ? "queued" : c.state === "skipped" ? "skipped" : duration(c.seconds);
    return h_flex().id(`corral-check-${i}`).h(28).px(6).mx(-6).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => (c.state === "fail" ? this.openLog(c) : openUrl(c.url)))
      .child(div().w(14).flex_none().text_center().text_color(color).child(glyph))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .when(Boolean(c.workflow), (el) => el.child(div().flex_none().text_color(t.dim).child(`${c.workflow} ·`)))
        .child(div().min_w(0).truncate().child(c.name)))
      .child(div().flex_none().text_size(11.5).text_color(c.state === "fail" ? t.ansi1 : t.dim).child(c.state === "fail" ? "View log" : right));
  }

  /** @param {Record<string, any>} t @param {import("./lib/pr.js").Review} r */
  reviewRow(t, r) {
    /** @type {Record<string, [string, any]>} */
    const look = {
      approved: ["Approved", t.ansi2], changes: ["Changes requested", t.ansi1], commented: ["Commented", t.muted],
      dismissed: ["Dismissed", t.dim], pending: ["Pending", t.dim], requested: ["Review requested", t.dim],
    };
    const [label, color] = look[r.state];
    return h_flex().h(30).gap(8).items_center()
      .child(this.avatar(t, r.who, 22))
      .child(div().flex_1().min_w(0).truncate().child(r.who))
      .child(div().flex_none().text_size(11.5).text_color(color).child(label));
  }

  /** @param {Record<string, any>} t @param {string} who @param {number} size */
  avatar(t, who, size) {
    const letters = who.replace(/\[bot\]$/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
    return div().size(size).flex_none().flex().items_center().justify_center().rounded(size / 2).bg(t.raised)
      .text_size(size * 0.42).font_semibold().text_color(t.muted).child(letters);
  }

  /** @param {Record<string, any>} t @param {PullRequest} pr @param {any} cx */
  mergeBox(t, pr, cx) {
    const box = v_flex().mt(16).p(12).gap(10).rounded(10).border_1().border_color(t.border).bg(t.surface);
    if (pr.state === "merged") return box.child(div().text_color(t.ansi5).font_medium().child("✓ Merged"));
    if (pr.state === "closed") return box.child(div().text_color(t.muted).child("Closed without merging."));
    const stops = blockers(pr);
    const running = summarizeChecks(pr.checks).overall === "running";
    const ready = canMergeNow(pr);
    const method = this.chosenMethod(pr);
    const status = stops.length ? [`Blocked: ${stops.join(", ")}`, t.ansi1]
      : running ? ["Waiting for checks to finish", t.blocked]
      : ready ? ["Ready to merge", t.ansi2]
      : ["GitHub is still working out whether this can merge", t.dim];
    const armed = Boolean(this.armed.merge);
    return box
      .child(div().text_size(12.5).text_color(status[1]).child(status[0]))
      .when(pr.methods.length > 1, (el) => el.child(h_flex().p(2).gap(2).self_start().rounded(8).border_1().border_color(t.border).text_size(12)
        .children(pr.methods.map((m) => div().id(`corral-method-${m}`).h(24).px(10).flex().items_center().rounded(6).cursor_pointer()
          .bg(m === method ? t.selected : CLEAR).text_color(m === method ? t.foreground : t.muted)
          .on_click(() => { this.method = m; cx.notify(); }).child(METHOD_LABEL[m])))))
      .child(h_flex().gap(8).items_center()
        .child(pr.draft
          ? this.button(t, "corral-pr-ready", this.busy ?? "Ready for review", (_e, cx) => this.markReady(cx), { primary: true })
          : this.button(t, "corral-pr-merge", this.busy === "Merging…" ? "Merging…" : armed ? "Click again to merge" : MERGE_BUTTON[method], (_e, cx) => this.merge(cx), { primary: true, disabled: !ready, danger: armed })))
      .when(pr.autoMergeAllowed && !pr.draft && (!ready || pr.autoMerge), (el) => el.child(h_flex().id("corral-pr-auto").gap(8).items_center().cursor_pointer()
        .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => { if (!this.busy) this.toggleAutoMerge(cx); })
        .child(this.toggle(t, pr.autoMerge))
        .child(div().text_size(12.5).child(pr.autoMerge ? `Merging automatically (${METHOD_LABEL[method].toLowerCase()}) when ready` : "Merge automatically when ready"))));
  }

  /** @param {Record<string, any>} t @param {boolean} on */
  toggle(t, on) {
    return div().w(30).h(17).flex_none().relative().rounded(9).bg(on ? t.done : t.input)
      .child(div().absolute().top(2).left(on ? 15 : 2).size(13).rounded(7).bg("#ffffff"));
  }

  /** @param {Record<string, any>} t @param {PullRequest} pr @param {any} cx */
  commentBox(t, pr, cx) {
    return v_flex().mt(14).gap(8)
      .child(div().h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.chrome)
        .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
        .child(Input.new(this.comment).w_full().text_size(12.5)))
      .child(h_flex().gap(6)
        .child(this.button(t, "corral-pr-comment", "Comment", (_e, cx) => this.postComment(cx)))
        .when(!pr.mine, (el) => el
          .child(this.button(t, "corral-pr-approve", "Approve", (_e, cx) => this.review("approve", cx)))
          .child(this.button(t, "corral-pr-request", "Request changes", (_e, cx) => this.review("request-changes", cx)))));
  }

  /** @param {Record<string, any>} t @param {PullRequest} pr @param {any} cx */
  threads(t, pr, cx) {
    const open = pr.threads.filter((x) => !x.resolved);
    const done = pr.threads.filter((x) => x.resolved);
    return v_flex()
      .when(Boolean(pr.threadsError), (el) => el.child(div().pt(12).text_size(12).text_color(t.dim).child(`Threads unavailable: ${pr.threadsError}`)))
      .child(this.heading(t, `UNRESOLVED · ${open.length}`))
      .when(!open.length, (el) => el.child(div().py(4).text_size(12).text_color(t.dim).child("Nothing waiting on you.")))
      .children(open.map((x) => this.threadCard(t, pr, x, cx)))
      .when(done.length > 0, (el) => el.child(this.heading(t, `RESOLVED · ${done.length}`))
        .children(done.map((x) => this.openResolved.has(x.id) ? this.threadCard(t, pr, x, cx) : this.resolvedRow(t, x, cx))));
  }

  /** The PR's files: change, path, open threads, size, viewed. @param {Record<string, any>} t @param {PullRequest} pr @param {any} cx */
  files(t, pr, cx) {
    /** @type {Record<string, any>} */
    const color = { A: t.ansi2, D: t.ansi1, R: t.ansi4 ?? t.accent, C: t.accent, M: t.ansi3 };
    /** @type {Map<string, number>} */
    const open = new Map();
    for (const x of pr.threads) if (!x.resolved) open.set(x.path, (open.get(x.path) ?? 0) + 1);
    const viewed = pr.fileList.filter((f) => f.viewed).length;
    return v_flex()
      .child(this.heading(t, "FILES", pr.fileList.length ? `${viewed} of ${pr.fileList.length} viewed` : ""))
      .when(!pr.fileList.length, (el) => el.child(div().py(4).text_size(12).text_color(t.dim).child(pr.threadsError ? `Files unavailable: ${pr.threadsError}` : "Loading files…")))
      .children(pr.fileList.map((f, i) => {
        const letter = changeLetter(f.change);
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
        const n = open.get(f.path) ?? 0;
        return h_flex().id(`corral-pr-file-${i}`).h(30).px(6).mx(-6).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.openReview(f.path))
          .child(div().w(12).flex_none().text_size(11.5).font_semibold().text_color(color[letter]).child(letter))
          .child(h_flex().flex_1().min_w(0).items_center().text_size(12.5).when(f.viewed, (el) => el.text_color(t.dim))
            .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(dir))
            .child(div().flex_none().child(f.path.slice(dir.length))))
          .when(n > 0, (el) => el.child(div().flex_none().px(5).rounded(7).bg(alpha(t.blocked, 0.18)).text_size(11).text_color(t.blocked).child(`${n} open`)))
          .child(div().flex_none().text_size(11).text_color(t.ansi2).child(f.additions ? `+${f.additions}` : ""))
          .child(div().flex_none().text_size(11).text_color(t.ansi1).child(f.deletions ? `−${f.deletions}` : ""))
          .child(div().id(`corral-pr-viewed-${i}`).size(15).flex().flex_none().items_center().justify_center().rounded(4).border_1()
            .border_color(f.viewed ? t.accent : t.input).bg(f.viewed ? t.accent : CLEAR).text_size(10).text_color(t.solid_foreground)
            .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
            .on_click((/** @type {any} */ _e, /** @type {any} */ cx) => { cx.stop_propagation(); this.toggleViewed(f.path, cx); })
            .child(f.viewed ? "✓" : ""));
      }))
      .when(pr.fileCount > pr.fileList.length && pr.fileList.length > 0, (el) => el.child(div().pt(8).text_size(12).text_color(t.dim)
        .child(`Showing ${pr.fileList.length} of ${pr.fileCount} files. The rest are on GitHub.`)));
  }

  /** @param {Record<string, any>} t @param {Thread} x @param {any} cx */
  resolvedRow(t, x, cx) {
    const first = x.comments[0]?.body.split("\n")[0] ?? "";
    return h_flex().id(`corral-thread-${x.id}`).h(28).gap(8).items_center().rounded(6).cursor_pointer().text_size(12)
      .hover((s) => s.bg(t.hover))
      .on_click(() => { this.openResolved.add(x.id); cx.notify(); })
      .child(div().flex_none().font_family("JetBrains Mono").text_size(11.5).text_color(t.dim).child(x.line ? `${x.path.split("/").pop()}:${x.line}` : x.path.split("/").pop() ?? ""))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(first));
  }

  /** @param {Record<string, any>} t @param {PullRequest} pr @param {Thread} x @param {any} cx */
  threadCard(t, pr, x, cx) {
    const where = x.line ? `${x.path}:${x.line}` : x.path;
    const replying = this.replyTo === x.id;
    return v_flex().mb(8).p(10).gap(9).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center()
        .child(div().id(`corral-thread-file-${x.id}`).min_w(0).truncate().font_family("JetBrains Mono").text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click(() => this.openReview(x.path)).child(where))
        .when(x.outdated, (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim).child("outdated")))
        .child(div().flex_1())
        .when(x.resolved, (el) => el.child(div().id(`corral-thread-fold-${x.id}`).flex_none().text_size(11.5).text_color(t.dim).cursor_pointer()
          .on_click(() => { this.openResolved.delete(x.id); cx.notify(); }).child("Hide"))))
      .children(x.comments.map((c) => v_flex().gap(4)
        .child(h_flex().gap(6).items_center().text_size(12)
          .child(this.avatar(t, c.who, 18))
          .child(div().font_medium().child(c.who))
          .child(div().text_color(t.dim).child(ago(c.at))))
        .child(TextView.markdown(`corral-comment-${c.id}`, c.body).selectable(true)
          .on_link_click((/** @type {string} */ url) => openUrl(url)).w_full().text_size(12.5))))
      .when(replying, (el) => el.child(div().h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.chrome)
        .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
        .child(Input.new(this.reply).w_full().text_size(12.5))))
      .child(h_flex().gap(6)
        .when(x.canReply, (el) => el.child(replying
          ? this.button(t, `corral-reply-send-${x.id}`, "Send reply", (_e, cx) => this.sendReply(x.id, cx), { primary: true })
          : this.button(t, `corral-reply-${x.id}`, "Reply", (_e, cx) => { this.replyTo = x.id; this.reply.set_value(""); this.reply.focus(); cx.notify(); })))
        .when(replying, (el) => el.child(this.button(t, `corral-reply-cancel-${x.id}`, "Cancel", (_e, cx) => { this.replyTo = null; cx.notify(); })))
        .when(!x.resolved, (el) => el.child(this.button(t, `corral-thread-send-${x.id}`, sendLabel(), (_e, cx) => this.sendThread(x, cx))))
        .child(div().flex_1())
        .when(x.canResolve, (el) => el.child(this.button(t, `corral-resolve-${x.id}`, x.resolved ? "Unresolve" : "Resolve", (_e, cx) => this.resolve(x, cx)))));
  }

  /** No PR for this branch: why, or a form to open one. @param {Record<string, any>} t @param {any} cx */
  noPr(t, cx) {
    const d = /** @type {import("./lib/pr.js").PrState} */ (this.data);
    if (d.error) return this.message(t, d.error, cx);
    if (!d.branch) return this.message(t, "Detached HEAD. Check out a branch to open a pull request.", cx);
    if (d.defaultBranch && d.branch === d.defaultBranch) {
      return v_flex().p(14).gap(6).text_size(12.5)
        .child(div().font_medium().child(`You're on ${d.branch}`))
        .child(div().text_color(t.muted).child("Pull requests start from a branch. Switch to one (or have your agent make one) and it shows up here."));
    }
    const push = !d.upstream ? `Pushes ${d.branch} to origin first.` : d.unpushed > 0 ? `Pushes ${d.unpushed} ${d.unpushed === 1 ? "commit" : "commits"} first.` : "";
    return v_flex().id("corral-pr-create").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(14)
      .child(h_flex().pt(14).pb(4).gap(8).items_center()
        .child(div().text_size(13.5).font_medium().child("Open a pull request")))
      .child(div().pb(10).font_family("JetBrains Mono").text_size(11.5).text_color(t.dim).truncate().child(`${d.branch} → ${d.defaultBranch ?? "default branch"}`))
      .when(Boolean(this.note), (el) => el.child(div().mb(8).px(10).py(7).rounded(8).bg(alpha(t.ansi1, 0.12)).text_size(12).child(this.note ?? "")))
      .child(div().h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.chrome)
        .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
        .child(Input.new(this.title).w_full().text_size(13)))
      .child(div().mt(8).px(4).py(2).rounded(8).border_1().border_color(t.input).bg(t.chrome)
        .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
        .child(Textarea.new(this.body).w_full().text_size(12.5)))
      .child(h_flex().id("corral-pr-draft").mt(10).gap(8).items_center().cursor_pointer()
        .on_click(() => { this.draft = !this.draft; cx.notify(); })
        .child(this.toggle(t, this.draft)).child(div().text_size(12.5).child("Draft")))
      .child(h_flex().mt(12).gap(10).items_center()
        .child(this.button(t, "corral-pr-create-go", this.busy ?? (this.draft ? "Create draft" : "Create pull request"), (_e, cx) => this.create(cx), { primary: true }))
        .when(Boolean(push), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(push))))
      .when(d.commits.length > 0, (el) => el.child(this.heading(t, `COMMITS · ${d.commits.length}`))
        .children(d.commits.map((c, i) => div().id(`corral-pr-commit-${i}`).py(3).text_size(12).text_color(t.muted).truncate().child(c.subject))))
      .when(!d.commits.length && Boolean(d.defaultBranch), (el) => el.child(div().pt(12).text_size(12).text_color(t.dim).child(`No commits on ${d.branch} yet beyond ${d.defaultBranch}.`)));
  }
}
