// Generated from lib/pr.js by scripts/build.mjs. Edit the source, not this copy.
// Pull requests through the GitHub CLI, run on the machine the repo lives on.
// One script call per refresh: the branch facts from git, the PR for the branch
// (`gh pr view`), then its review threads and the repo's merge settings (GraphQL).
// Pure: parsing and argv building only.

const PR_FIELDS = [
  "number", "title", "state", "isDraft", "url", "headRefName", "baseRefName", "headRefOid",
  "mergeable", "mergeStateStatus", "reviewDecision", "statusCheckRollup", "latestReviews",
  "reviewRequests", "author", "createdAt", "additions", "deletions", "changedFiles", "autoMergeRequest",
].join(",");

/** Threads, who may resolve them, and how this repo merges. */
export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerDefaultMergeMethod squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed
    pullRequest(number: $number) {
      viewerDidAuthor
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine startLine viewerCanResolve viewerCanReply
          comments(first: 50) { nodes { id author { login } body createdAt url diffHunk } }
        }
      }
    }
  }
}`;

/**
 * `sh -c PR_SCRIPT corral <root> <threads query>`. Sections split by \x1e: branch,
 * the remote's default branch ("origin/main"), upstream, unpushed count, commits
 * since the default branch (subject \x1f body, NUL-ended), gh's exit code, the
 * PR JSON or gh's error, and the GraphQL answer. Exit 3: not a repo; 4: no gh.
 */
export const PR_SCRIPT = `cd "$1" 2>/dev/null || exit 2
git rev-parse --git-dir >/dev/null 2>&1 || exit 3
command -v gh >/dev/null 2>&1 || exit 4
branch=$(git symbolic-ref --short -q HEAD)
base=$(git symbolic-ref --short -q refs/remotes/origin/HEAD)
printf '%s\\036%s\\036' "$branch" "$base"
git rev-parse --abbrev-ref '@{u}' 2>/dev/null; printf '\\036'
git rev-list --count '@{u}..HEAD' 2>/dev/null; printf '\\036'
[ -n "$base" ] && git log -n 30 --no-merges --format='%s%x1f%b%x00' "$base..HEAD" 2>/dev/null
printf '\\036'
[ -n "$branch" ] || exit 0
out=$(gh pr view --json ${PR_FIELDS} 2>&1); code=$?
printf '%s\\036%s\\036' "$code" "$out"
[ "$code" -eq 0 ] || exit 0
where=$(printf '%s' "$out" | sed -n 's#.*"url":"https\\{0,1\\}://\\([^/"]*\\)/\\([^/"]*\\)/\\([^/"]*\\)/pull/\\([0-9]*\\)".*#\\1 \\2 \\3 \\4#p')
set -- "$2" $where
[ $# -eq 5 ] || exit 0
gh api graphql --hostname "$2" -f query="$1" -F owner="$3" -F name="$4" -F number="$5" 2>&1
exit 0`;

/**
 * @typedef {"pass" | "fail" | "running" | "queued" | "cancelled" | "skipped" | "neutral"} CheckState
 * @typedef {object} Check
 * @property {string} name
 * @property {string} workflow   "" for a commit status
 * @property {CheckState} state
 * @property {string} url
 * @property {string | null} job   Actions job id, when it is one
 * @property {string | null} run   Actions run id
 * @property {number | null} seconds  how long it ran (so far)
 *
 * @typedef {object} Review
 * @property {string} who
 * @property {"approved" | "changes" | "commented" | "dismissed" | "pending" | "requested"} state
 *
 * @typedef {object} ThreadComment
 * @property {string} id
 * @property {string} who
 * @property {string} body
 * @property {string} at
 * @property {string} url
 *
 * @typedef {object} Thread
 * @property {string} id
 * @property {boolean} resolved
 * @property {boolean} outdated
 * @property {string} path
 * @property {number | null} line
 * @property {boolean} canResolve
 * @property {boolean} canReply
 * @property {string} hunk
 * @property {ThreadComment[]} comments
 *
 * @typedef {"squash" | "merge" | "rebase"} MergeMethod
 *
 * @typedef {object} PullRequest
 * @property {number} number
 * @property {string} title
 * @property {string} url
 * @property {string} host       "github.com"
 * @property {string} repo       "owner/name"
 * @property {"open" | "merged" | "closed"} state
 * @property {boolean} draft
 * @property {string} head
 * @property {string} base
 * @property {string} headSha
 * @property {string} author
 * @property {string} createdAt
 * @property {number} additions
 * @property {number} deletions
 * @property {number} files
 * @property {string} mergeable       MERGEABLE | CONFLICTING | UNKNOWN
 * @property {string} mergeState      CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | HAS_HOOKS | DRAFT | UNKNOWN
 * @property {string} reviewDecision  APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
 * @property {boolean} autoMerge
 * @property {Check[]} checks
 * @property {Review[]} reviews
 * @property {Thread[]} threads
 * @property {MergeMethod[]} methods    the merge methods this repo allows
 * @property {MergeMethod} preferred
 * @property {boolean} autoMergeAllowed
 * @property {boolean} mine            you opened it
 * @property {string | null} threadsError
 *
 * @typedef {object} PrState
 * @property {string | null} branch      null: detached HEAD
 * @property {string | null} defaultBranch  "main", from the remote's HEAD
 * @property {string | null} upstream
 * @property {number} unpushed
 * @property {{ subject: string, body: string }[]} commits  on the branch, newest first
 * @property {PullRequest | null} pr
 * @property {string | null} error       why there's nothing to show
 */

/** @param {string} stdout @returns {PrState} */
export function parsePrState(stdout) {
  const parts = stdout.split("\x1e");
  const [branch = "", base = "", upstream = "", unpushed = "", log = "", code = "", out = "", graph = ""] = parts;
  /** @type {PrState} */
  const state = {
    branch: branch.trim() || null,
    defaultBranch: base.trim().replace(/^[^/]+\//, "") || null,
    upstream: upstream.trim() || null,
    unpushed: Number(unpushed.trim()) || 0,
    commits: log.split("\0").map((c) => c.replace(/^\n/, "")).filter((c) => c.trim()).map((c) => {
      const [subject = "", body = ""] = c.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    }),
    pr: null,
    error: null,
  };
  if (!state.branch || parts.length < 7) return state;
  if (code.trim() !== "0") {
    state.error = ghError(out);
    return state;
  }
  try {
    state.pr = normalizePr(JSON.parse(out), graph.trim() ? graph : null);
  } catch {
    state.error = `Unexpected answer from gh: ${out.slice(0, 200)}`;
  }
  return state;
}

/** gh's failure, in words; null when the branch simply has no PR. @param {string} text */
export function ghError(text) {
  const t = text.trim();
  if (/no pull requests found/i.test(t)) return null;
  if (/gh auth login|not logged in|authentication/i.test(t)) return "The GitHub CLI isn't signed in on this machine. Run `gh auth login` there.";
  if (/no git remotes|none of the git remotes|not a github/i.test(t)) return "This repo has no GitHub remote.";
  if (/could not resolve host|network|timeout/i.test(t)) return "Can't reach GitHub right now.";
  return t.split("\n")[0] || "gh failed";
}

/** The pieces of a PR or Actions URL. @param {string} url */
export function parseGithubUrl(url) {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:pull\/(\d+)|actions\/runs\/(\d+)(?:\/job\/(\d+))?)/.exec(url ?? "");
  if (!m) return null;
  return { host: m[1], repo: `${m[2]}/${m[3]}`, number: m[4] ? Number(m[4]) : null, run: m[5] ?? null, job: m[6] ?? null };
}

const FAIL = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const ORDER = ["fail", "running", "queued", "pass", "cancelled", "neutral", "skipped"];

/** One check from statusCheckRollup. @param {any} c @param {number} now @returns {Check} */
export function normalizeCheck(c, now = Date.now()) {
  /** @type {CheckState} */
  let state;
  if (c.__typename === "StatusContext") {
    state = c.state === "SUCCESS" ? "pass" : FAIL.has(c.state) ? "fail" : c.state === "PENDING" ? "running" : "queued";
  } else if (c.status !== "COMPLETED") {
    state = c.status === "IN_PROGRESS" ? "running" : "queued";
  } else {
    const k = c.conclusion;
    state = k === "SUCCESS" ? "pass" : FAIL.has(k) ? "fail" : k === "CANCELLED" ? "cancelled" : k === "SKIPPED" ? "skipped" : "neutral";
  }
  const url = c.detailsUrl ?? c.targetUrl ?? "";
  const ids = parseGithubUrl(url);
  const start = Date.parse(c.startedAt ?? "");
  const end = Date.parse(c.completedAt ?? "");
  const seconds = Number.isFinite(start) && start > 0 ? Math.max(0, Math.round(((Number.isFinite(end) && end > 0 ? end : now) - start) / 1000)) : null;
  return {
    name: c.name ?? c.context ?? "check",
    workflow: c.workflowName ?? "",
    state,
    url,
    run: ids?.run ?? null,
    job: ids?.job ?? null,
    seconds,
  };
}

/** Latest run of each check, failures first. @param {any[]} rollup @param {number} [now] */
export function normalizeChecks(rollup, now = Date.now()) {
  /** @type {Map<string, { check: Check, started: string }>} */
  const latest = new Map();
  for (const c of rollup ?? []) {
    const key = `${c.workflowName ?? ""}\x1f${c.name ?? c.context}`;
    const started = c.startedAt ?? "";
    const seen = latest.get(key);
    if (!seen || started > seen.started) latest.set(key, { check: normalizeCheck(c, now), started });
  }
  return [...latest.values()].map((x) => x.check)
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
}

/** "3 passed · 1 failed · 1 running", and the overall state. @param {Check[]} checks */
export function summarizeChecks(checks) {
  /** @type {Record<CheckState, number>} */
  const n = { pass: 0, fail: 0, running: 0, queued: 0, cancelled: 0, skipped: 0, neutral: 0 };
  for (const c of checks) n[c.state]++;
  const parts = [];
  if (n.pass) parts.push(`${n.pass} passed`);
  if (n.fail) parts.push(`${n.fail} failed`);
  if (n.running + n.queued) parts.push(`${n.running + n.queued} running`);
  if (n.cancelled) parts.push(`${n.cancelled} cancelled`);
  if (n.skipped) parts.push(`${n.skipped} skipped`);
  /** @type {"none" | "fail" | "running" | "pass"} */
  const overall = !checks.length ? "none" : n.fail ? "fail" : n.running + n.queued ? "running" : "pass";
  return { counts: n, overall, text: parts.join(" · ") || "No checks" };
}

const REVIEW_STATES = /** @type {const} */ ({ APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" });

/** @param {any} raw the `gh pr view` JSON @param {string | null} graph the GraphQL answer @returns {PullRequest} */
export function normalizePr(raw, graph) {
  const where = parseGithubUrl(raw.url);
  /** @type {Review[]} */
  const reviews = (raw.latestReviews ?? []).map((/** @type {any} */ r) => ({
    who: r.author?.login ?? "someone",
    state: REVIEW_STATES[/** @type {keyof typeof REVIEW_STATES} */ (r.state)] ?? "commented",
  }));
  for (const r of raw.reviewRequests ?? []) {
    const who = r.login ?? r.slug ?? r.name;
    if (who && !reviews.some((x) => x.who === who)) reviews.push({ who, state: "requested" });
  }
  let threads = /** @type {Thread[]} */ ([]);
  /** @type {MergeMethod[]} */
  let methods = ["squash", "merge", "rebase"];
  /** @type {MergeMethod} */
  let preferred = "squash";
  let autoMergeAllowed = false;
  let mine = false;
  /** @type {string | null} */
  let threadsError = null;
  if (graph) {
    try {
      const g = JSON.parse(graph);
      if (g.errors?.length && !g.data) throw new Error(g.errors[0].message);
      const repo = g.data.repository;
      const pr = repo.pullRequest;
      mine = Boolean(pr.viewerDidAuthor);
      autoMergeAllowed = Boolean(repo.autoMergeAllowed);
      methods = /** @type {MergeMethod[]} */ ([repo.squashMergeAllowed && "squash", repo.mergeCommitAllowed && "merge", repo.rebaseMergeAllowed && "rebase"].filter(Boolean));
      const def = String(repo.viewerDefaultMergeMethod ?? "").toLowerCase();
      preferred = /** @type {MergeMethod} */ (methods.includes(/** @type {MergeMethod} */ (def)) ? def : methods[0] ?? "merge");
      threads = (pr.reviewThreads?.nodes ?? []).map(normalizeThread);
    } catch (e) {
      threadsError = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    number: raw.number,
    title: raw.title ?? "",
    url: raw.url ?? "",
    host: where?.host ?? "github.com",
    repo: where?.repo ?? "",
    state: raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open",
    draft: Boolean(raw.isDraft),
    head: raw.headRefName ?? "",
    base: raw.baseRefName ?? "",
    headSha: raw.headRefOid ?? "",
    author: raw.author?.login ?? "",
    createdAt: raw.createdAt ?? "",
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    files: raw.changedFiles ?? 0,
    mergeable: raw.mergeable ?? "UNKNOWN",
    mergeState: raw.mergeStateStatus ?? "UNKNOWN",
    reviewDecision: raw.reviewDecision ?? "",
    autoMerge: Boolean(raw.autoMergeRequest),
    checks: normalizeChecks(raw.statusCheckRollup ?? []),
    reviews,
    threads,
    methods: methods.length ? methods : ["merge"],
    preferred,
    autoMergeAllowed,
    mine,
    threadsError,
  };
}

/** @param {any} t @returns {Thread} */
export function normalizeThread(t) {
  const comments = (t.comments?.nodes ?? []).map((/** @type {any} */ c) => ({
    id: c.id, who: c.author?.login ?? "ghost", body: c.body ?? "", at: c.createdAt ?? "", url: c.url ?? "",
  }));
  return {
    id: t.id,
    resolved: Boolean(t.isResolved),
    outdated: Boolean(t.isOutdated),
    path: t.path ?? "",
    line: t.line ?? t.originalLine ?? null,
    canResolve: Boolean(t.viewerCanResolve),
    canReply: Boolean(t.viewerCanReply),
    hunk: t.comments?.nodes?.[0]?.diffHunk ?? "",
    comments,
  };
}

/**
 * The four steps across the top: Opened, Checks, Review, Merge.
 * @param {PullRequest} pr
 * @returns {{ label: string, state: "done" | "fail" | "wait" | "todo" }[]}
 */
export function prSteps(pr) {
  const checks = summarizeChecks(pr.checks).overall;
  const merged = pr.state === "merged";
  return [
    { label: pr.draft ? "Draft" : "Opened", state: pr.draft ? "wait" : "done" },
    { label: "Checks", state: merged || checks === "pass" || checks === "none" ? "done" : checks === "fail" ? "fail" : "wait" },
    { label: "Review", state: merged || pr.reviewDecision === "APPROVED" ? "done" : pr.reviewDecision === "CHANGES_REQUESTED" ? "fail"
      : pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviews.some((r) => r.state === "requested") ? "wait" : "done" },
    { label: merged ? "Merged" : "Merge", state: merged ? "done" : pr.state === "closed" ? "fail" : "todo" },
  ];
}

/** What stands between this PR and a merge, in words. @param {PullRequest} pr */
export function blockers(pr) {
  if (pr.state !== "open") return [];
  const out = [];
  const s = summarizeChecks(pr.checks);
  if (pr.draft) out.push("it's a draft");
  if (s.counts.fail) out.push(`${s.counts.fail} failing ${s.counts.fail === 1 ? "check" : "checks"}`);
  if (pr.reviewDecision === "CHANGES_REQUESTED") out.push("changes requested");
  else if (pr.reviewDecision === "REVIEW_REQUIRED") out.push("review required");
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") out.push(`conflicts with ${pr.base}`);
  else if (pr.mergeState === "BEHIND") out.push(`behind ${pr.base}`);
  const open = pr.threads.filter((t) => !t.resolved).length;
  if (pr.mergeState === "BLOCKED" && open && !out.length) out.push(`${open} unresolved ${open === 1 ? "thread" : "threads"}`);
  const waiting = pr.reviews.filter((r) => r.state === "requested").map((r) => r.who);
  if (pr.mergeState === "BLOCKED" && !out.length && waiting.length) out.push(`waiting for ${waiting.join(", ")} to review`);
  else if (pr.mergeState === "BLOCKED" && !out.length && s.overall !== "running") out.push("branch protection rules");
  return out;
}

/** Whether a merge right now would go through. @param {PullRequest} pr */
export function canMergeNow(pr) {
  return pr.state === "open" && !pr.draft && ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeState);
}

/** gh argv for the actions the panel offers. */
export const GH = {
  /** @param {number} n @param {MergeMethod} method @param {boolean} auto */
  merge: (n, method, auto) => ["pr", "merge", String(n), `--${method}`, ...(auto ? ["--auto"] : [])],
  /** @param {number} n */
  disableAuto: (n) => ["pr", "merge", String(n), "--disable-auto"],
  /** @param {number} n */
  ready: (n) => ["pr", "ready", String(n)],
  /** @param {number} n @param {string} body */
  comment: (n, body) => ["pr", "comment", String(n), "--body", body],
  /** @param {number} n @param {"approve" | "request-changes" | "comment"} kind @param {string} body */
  review: (n, kind, body) => ["pr", "review", String(n), `--${kind}`, ...(body ? ["--body", body] : [])],
  /** @param {{ title: string, body: string, head: string, base?: string | null, draft?: boolean }} p */
  create: (p) => ["pr", "create", "--title", p.title, "--body", p.body, "--head", p.head, ...(p.base ? ["--base", p.base] : []), ...(p.draft ? ["--draft"] : [])],
  /** @param {string} run */
  rerunFailed: (run) => ["run", "rerun", run, "--failed"],
  /** @param {string} host @param {string} threadId @param {string} body */
  reply: (host, threadId, body) => ["api", "graphql", "--hostname", host, "-f", `query=${REPLY_MUTATION}`, "-f", `thread=${threadId}`, "-f", `body=${body}`],
  /** @param {string} host @param {string} threadId @param {boolean} resolve */
  resolve: (host, threadId, resolve) => ["api", "graphql", "--hostname", host, "-f", `query=${resolve ? RESOLVE_MUTATION : UNRESOLVE_MUTATION}`, "-f", `thread=${threadId}`],
};

const REPLY_MUTATION = "mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }";
const RESOLVE_MUTATION = "mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }";
const UNRESOLVE_MUTATION = "mutation($thread: ID!) { unresolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }";

/**
 * A PR title and body from the branch's commits: one commit gives its own
 * subject and body; several give the branch name and a list of subjects.
 * @param {string} branch @param {{ subject: string, body: string }[]} commits newest first
 */
export function draftPr(branch, commits) {
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body };
  const name = branch.replace(/^[^/]+\//, "").replace(/[-_]+/g, " ").trim();
  const title = name ? name[0].toUpperCase() + name.slice(1) : branch;
  return { title, body: [...commits].reverse().map((c) => `- ${c.subject}`).join("\n") };
}

// ---- CI job logs ----------------------------------------------------------

/**
 * `sh -c JOB_LOG_SCRIPT corral <host> <owner/repo> <job>`: the job (JSON), \x1e,
 * then its log (last 20000 lines). Read through the API: `gh run view --log`
 * comes back empty on older gh versions.
 */
export const JOB_LOG_SCRIPT = `gh api --hostname "$1" "repos/$2/actions/jobs/$3" || exit $?
printf '\\036'
gh api --hostname "$1" "repos/$2/actions/jobs/$3/logs" 2>&1 | tail -n 20000`;

/**
 * Saves a job's log as plain text where an agent can read it: <git dir>/corral/ci-<job>.log.
 * `sh -c SAVE_LOG_SCRIPT corral <host> <owner/repo> <job>`; prints the path.
 */
export const SAVE_LOG_SCRIPT = `dir="$(git rev-parse --absolute-git-dir)/corral" && mkdir -p "$dir" || exit 1
f="$dir/ci-$3.log"
gh api --hostname "$1" "repos/$2/actions/jobs/$3/logs" | sed -e 's/^[^ ]*[0-9]Z //' > "$f" || exit 1
printf '%s' "$f"`;

/**
 * @typedef {object} LogRow
 * @property {"group" | "error" | "warn" | "line" | "step"} kind
 * @property {string} text
 * @property {number} n   1-based line in the job log
 *
 * @typedef {object} JobLog
 * @property {string} name
 * @property {string} conclusion
 * @property {string} url
 * @property {string} run
 * @property {{ name: string, conclusion: string | null, number: number }[]} steps
 * @property {string | null} failedStep
 * @property {LogRow[]} rows        the whole log
 * @property {LogRow[]} failedRows  only the failed steps (empty if they can't be told apart)
 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?Z ?/;

/** @param {string} stdout JOB_LOG_SCRIPT's output @returns {JobLog} */
export function parseJobLog(stdout) {
  const at = stdout.indexOf("\x1e");
  const job = JSON.parse(at < 0 ? stdout : stdout.slice(0, at));
  const text = at < 0 ? "" : stdout.slice(at + 1);
  const steps = (job.steps ?? []).map((/** @type {any} */ s) => ({
    name: s.name, conclusion: s.conclusion ?? null, number: s.number,
    start: (s.started_at ?? "").slice(0, 19), end: (s.completed_at ?? "").slice(0, 19),
  }));
  const failed = steps.filter((/** @type {any} */ s) => s.conclusion === "failure");
  /** @type {LogRow[]} */
  const rows = [];
  /** @type {LogRow[]} */
  const failedRows = [];
  let stepIndex = -1;
  let lastFailedStep = -1;
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.forEach((raw, i) => {
    const m = STAMP.exec(raw);
    const stamp = m ? m[1] : null;
    let line = (m ? raw.slice(m[0].length) : raw.replace(/^\uFEFF/, "")).replace(ANSI, "").replace(/\r$/, "");
    if (line.startsWith("##[endgroup]")) return;
    // A line belongs to the last step that started by its time.
    if (stamp) while (stepIndex + 1 < steps.length && steps[stepIndex + 1].start && steps[stepIndex + 1].start <= stamp) stepIndex++;
    /** @type {LogRow["kind"]} */
    let kind = "line";
    if (line.startsWith("##[group]")) { kind = "group"; line = line.slice(9); }
    else if (line.startsWith("##[error]")) { kind = "error"; line = line.slice(9); }
    else if (line.startsWith("##[warning]")) { kind = "warn"; line = line.slice(11); }
    else if (line.startsWith("##[command]")) line = `$ ${line.slice(11)}`;
    else if (/^##\[(notice|debug)\]/.test(line)) line = line.replace(/^##\[\w+\]/, "");
    else if (/^(Error|ERROR|FAIL|✖|×|npm ERR!)\b|\berror(\[\w+\])?:|\bfailed\b/.test(line)) kind = "error";
    const row = { kind, text: line, n: i + 1 };
    rows.push(row);
    const step = steps[stepIndex];
    if (step && step.conclusion === "failure") {
      if (lastFailedStep !== stepIndex) { failedRows.push({ kind: "step", text: step.name, n: i + 1 }); lastFailedStep = stepIndex; }
      failedRows.push(row);
    }
  });
  return {
    name: job.name ?? "job",
    conclusion: job.conclusion ?? job.status ?? "",
    url: job.html_url ?? "",
    run: String(job.run_id ?? ""),
    steps: steps.map((/** @type {any} */ s) => ({ name: s.name, conclusion: s.conclusion, number: s.number })),
    failedStep: failed[0]?.name ?? null,
    rows,
    failedRows,
  };
}

// ---- Handing work to an agent ---------------------------------------------

/**
 * The agent to hand work to: one in the shown tab, else in the shown space;
 * the one you looked at last wins.
 * @param {import("herdr").AgentInfo[]} agents @param {string | null} tab @param {string | null} space
 */
export function pickAgent(agents, tab, space) {
  const byRecent = [...agents].sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0) || b.seq - a.seq);
  return byRecent.find((a) => a.tab === tab) ?? byRecent.find((a) => a.space === space) ?? null;
}

/** "Claude", "Codex", or the program's name. @param {import("herdr").AgentInfo | null} agent */
export function agentName(agent) {
  if (!agent) return "agent";
  const app = String(agent.app ?? agent.program ?? "").toLowerCase();
  if (app.startsWith("claude")) return "Claude";
  if (app.startsWith("codex")) return "Codex";
  if (app.startsWith("cursor")) return "Cursor";
  return app ? app[0].toUpperCase() + app.slice(1) : "agent";
}

/** The message for a failed check. @param {{ pr: number, check: string, log: string }} p */
export function failurePrompt(p) {
  return `The CI check "${p.check}" failed on PR #${p.pr}. Its log is saved at ${p.log}. Find the cause, fix it, and run the same check locally if you can.`;
}

/** The message for a review thread. @param {number} pr @param {Thread} t */
export function threadPrompt(pr, t) {
  const where = t.line ? `${t.path}:${t.line}` : t.path;
  const said = t.comments.map((c) => `${c.who}:\n${c.body.trim()}`).join("\n\n");
  return `Review comment on PR #${pr} at ${where}:\n\n${said}\n\nAddress this in the code. If you disagree, tell me why instead of changing it.`;
}

/** "3m", "2h", "5d" since an ISO time. @param {string} iso @param {number} [now] */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "1m 12s". @param {number | null} s */
export function duration(s) {
  if (s === null) return "";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
