import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PR_SCRIPT, THREADS_QUERY, JOB_LOG_SCRIPT, parsePrState, parseGithubUrl, normalizeChecks, summarizeChecks,
  prSteps, blockers, canMergeNow, GH, draftPr, parseJobLog, pickAgent, agentName, threadPrompt, ghError, duration,
} from "../lib/pr.js";

const NOW = Date.parse("2026-11-14T15:00:00Z");

const PR_JSON = {
  number: 14, title: "Add source control panel", state: "OPEN", isDraft: false,
  url: "https://github.com/acme/widgets/pull/14", headRefName: "feat/source-control", baseRefName: "main",
  headRefOid: "a41c9e2", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED",
  author: { login: "you" }, createdAt: "2026-11-14T12:00:00Z", additions: 120, deletions: 30, changedFiles: 6,
  autoMergeRequest: null,
  latestReviews: [{ author: { login: "mkoval" }, state: "CHANGES_REQUESTED" }, { author: { login: "copilot" }, state: "COMMENTED" }],
  reviewRequests: [{ __typename: "User", login: "dana" }, { __typename: "User", login: "mkoval" }],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "unit tests", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-14T14:00:00Z", completedAt: "2026-11-14T14:01:12Z", detailsUrl: "https://github.com/acme/widgets/actions/runs/482/job/9001" },
    { __typename: "CheckRun", name: "unit tests", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-14T13:00:00Z", completedAt: "2026-11-14T13:01:00Z", detailsUrl: "https://github.com/acme/widgets/actions/runs/400/job/8000" },
    { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-14T14:00:00Z", completedAt: "2026-11-14T14:00:40Z", detailsUrl: "https://github.com/acme/widgets/actions/runs/482/job/9002" },
    { __typename: "CheckRun", name: "e2e", workflowName: "CI", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-11-14T14:58:00Z", completedAt: null, detailsUrl: "https://github.com/acme/widgets/actions/runs/482/job/9003" },
    { __typename: "StatusContext", context: "deploy/preview", state: "SUCCESS", targetUrl: "https://preview.example/14", startedAt: "2026-11-14T14:00:00Z" },
  ],
};

const GRAPH = {
  data: { repository: {
    viewerDefaultMergeMethod: "SQUASH", squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, autoMergeAllowed: true,
    pullRequest: { viewerDidAuthor: true, reviewThreads: { nodes: [
      { id: "T1", isResolved: false, isOutdated: false, path: "lib/git.js", line: 42, originalLine: 40, viewerCanResolve: true, viewerCanReply: true,
        comments: { nodes: [{ id: "C1", author: { login: "mkoval" }, body: "Renames show up twice.", createdAt: "2026-11-14T12:00:00Z", url: "u", diffHunk: "@@ -1 +1 @@" }] } },
      { id: "T2", isResolved: true, isOutdated: true, path: "lib/old.js", line: null, originalLine: 7, viewerCanResolve: true, viewerCanReply: true,
        comments: { nodes: [{ id: "C2", author: null, body: "ok", createdAt: "", url: "", diffHunk: "" }] } },
    ] } },
  } },
};

/** A temp repo on a branch with two commits past main, plus a stub `gh` on PATH. */
function fixture({ prExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "corral-pr-"));
  const repo = join(dir, "repo"), bin = join(dir, "bin"), remote = join(dir, "remote.git");
  mkdirSync(repo); mkdirSync(bin);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n"); git("add", "-A"); git("commit", "-q", "-m", "first");
  git("remote", "add", "origin", remote); git("push", "-q", "-u", "origin", "main");
  git("remote", "set-head", "origin", "main");
  git("checkout", "-q", "-b", "feat/source-control");
  writeFileSync(join(repo, "b.txt"), "b\n"); git("add", "-A"); git("commit", "-q", "-m", "Add b", "-m", "Because b.");
  writeFileSync(join(repo, "c.txt"), "c\n"); git("add", "-A"); git("commit", "-q", "-m", "Add c");
  writeFileSync(join(dir, "pr.json"), JSON.stringify(PR_JSON));
  writeFileSync(join(dir, "graph.json"), JSON.stringify(GRAPH));
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "pr view") ${prExit ? `echo 'no pull requests found for branch "feat/source-control"' >&2; exit ${prExit}` : `cat "${join(dir, "pr.json")}"`} ;;
  "api graphql") printf '%s\\n' "$@" > "${join(dir, "graph-args")}"; cat "${join(dir, "graph.json")}" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  const runScript = () => execFileSync("sh", ["-c", PR_SCRIPT, "corral", repo, THREADS_QUERY], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { dir, repo, runScript, git };
}

test("PR script: branch facts, the PR and its threads in one call", (t) => {
  try { execFileSync("git", ["--version"]); } catch { t.skip("git not installed"); return; }
  const f = fixture();
  try {
    const s = parsePrState(f.runScript());
    assert.equal(s.branch, "feat/source-control");
    assert.equal(s.defaultBranch, "main");
    assert.equal(s.upstream, null);
    assert.deepEqual(s.commits.map((c) => c.subject), ["Add c", "Add b"]);
    assert.equal(s.commits[1].body, "Because b.");
    assert.equal(s.error, null);
    const pr = s.pr;
    assert.ok(pr);
    assert.equal(pr.number, 14);
    assert.equal(pr.repo, "acme/widgets");
    assert.deepEqual(pr.methods, ["squash", "rebase"]);
    assert.equal(pr.preferred, "squash");
    assert.equal(pr.mine, true);
    assert.deepEqual(pr.threads.map((x) => [x.id, x.resolved, x.line]), [["T1", false, 42], ["T2", true, 7]]);
    assert.equal(pr.threads[1].comments[0].who, "ghost");
    assert.deepEqual(pr.reviews, [{ who: "mkoval", state: "changes" }, { who: "copilot", state: "commented" }, { who: "dana", state: "requested" }]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("PR script: a branch without a PR", (t) => {
  try { execFileSync("git", ["--version"]); } catch { t.skip("git not installed"); return; }
  const f = fixture({ prExit: 1 });
  try {
    const s = parsePrState(f.runScript());
    assert.equal(s.pr, null);
    assert.equal(s.error, null);
    assert.equal(s.commits.length, 2);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("gh errors in words", () => {
  assert.equal(ghError('no pull requests found for branch "x"'), null);
  assert.match(ghError("To get started with GitHub CLI, please run:  gh auth login"), /isn't signed in/);
  assert.match(ghError("none of the git remotes configured for this repository point to a known GitHub host"), /no GitHub remote/);
});

test("URLs: PRs and Actions jobs", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/widgets/pull/14"), { host: "github.com", repo: "acme/widgets", number: 14, run: null, job: null });
  assert.deepEqual(parseGithubUrl("https://ghe.corp/a/b/actions/runs/1/job/2"), { host: "ghe.corp", repo: "a/b", number: null, run: "1", job: "2" });
  assert.equal(parseGithubUrl("https://preview.example/14"), null);
});

test("checks: latest run of each, failures first, summarized", () => {
  const checks = normalizeChecks(PR_JSON.statusCheckRollup, NOW);
  assert.deepEqual(checks.map((c) => [c.name, c.state]), [["unit tests", "fail"], ["e2e", "running"], ["deploy/preview", "pass"], ["lint", "pass"]]);
  assert.equal(checks[0].job, "9001");
  assert.equal(checks[0].run, "482");
  assert.equal(checks[0].seconds, 72);
  assert.equal(checks[1].seconds, 120);
  assert.equal(duration(72), "1m 12s");
  const s = summarizeChecks(checks);
  assert.equal(s.text, "2 passed · 1 failed · 1 running");
  assert.equal(s.overall, "fail");
  assert.equal(summarizeChecks([]).overall, "none");
});

test("steps, blockers and mergeability", () => {
  const s = parsePrState(["feat", "origin/main", "", "0", "", "0", JSON.stringify(PR_JSON), JSON.stringify(GRAPH)].join("\x1e"));
  const pr = /** @type {import("../lib/pr.js").PullRequest} */ (s.pr);
  assert.deepEqual(prSteps(pr).map((x) => x.state), ["done", "fail", "fail", "todo"]);
  assert.deepEqual(blockers(pr), ["1 failing check", "changes requested"]);
  assert.equal(canMergeNow(pr), false);
  const clean = { ...pr, checks: [], reviewDecision: "APPROVED", mergeState: "CLEAN" };
  assert.deepEqual(blockers(clean), []);
  assert.equal(canMergeNow(clean), true);
  assert.deepEqual(blockers({ ...clean, mergeState: "DIRTY", mergeable: "CONFLICTING" }), ["conflicts with main"]);
  assert.deepEqual(prSteps({ ...pr, state: "merged" }).map((x) => x.state), ["done", "done", "done", "done"]);
});

test("gh argv", () => {
  assert.deepEqual(GH.merge(14, "squash", false), ["pr", "merge", "14", "--squash"]);
  assert.deepEqual(GH.merge(14, "rebase", true), ["pr", "merge", "14", "--rebase", "--auto"]);
  assert.deepEqual(GH.create({ title: "T", body: "", head: "feat", base: "main", draft: true }), ["pr", "create", "--title", "T", "--body", "", "--head", "feat", "--base", "main", "--draft"]);
  const reply = GH.reply("github.com", "T1", "@mkoval thanks");
  assert.equal(reply.at(-1), "body=@mkoval thanks");
  assert.ok(reply.includes("--hostname"));
});

test("a PR drafted from commits", () => {
  assert.deepEqual(draftPr("feat/x", [{ subject: "Add b", body: "Because b." }]), { title: "Add b", body: "Because b." });
  assert.deepEqual(draftPr("feat/source-control", [{ subject: "Add c", body: "" }, { subject: "Add b", body: "" }]), { title: "Source control", body: "- Add b\n- Add c" });
});

test("job log: steps by time, groups, errors, failed step only", () => {
  const job = {
    name: "test", conclusion: "failure", html_url: "https://github.com/a/b/actions/runs/1/job/2", run_id: 1,
    steps: [
      { name: "Set up job", conclusion: "success", number: 1, started_at: "2026-11-14T13:33:48Z", completed_at: "2026-11-14T13:33:49Z" },
      { name: "Run tests", conclusion: "failure", number: 2, started_at: "2026-11-14T13:33:50Z", completed_at: "2026-11-14T13:34:10Z" },
    ],
  };
  const log = [
    "﻿2026-11-14T13:33:48.1444909Z Current runner version: '2.338.2'",
    "2026-11-14T13:33:48.1479315Z ##[group]Runner Image",
    "2026-11-14T13:33:48.1480000Z ##[endgroup]",
    "2026-11-14T13:33:50.0000000Z ##[group]Run npm test",
    "2026-11-14T13:33:51.0000000Z \x1b[31mnot ok 1 - adds\x1b[0m",
    "2026-11-14T13:34:09.0000000Z ##[error]Process completed with exit code 1.",
    "",
  ].join("\n");
  const r = parseJobLog(JSON.stringify(job) + "\x1e" + log);
  assert.equal(r.failedStep, "Run tests");
  assert.equal(r.run, "1");
  assert.deepEqual(r.rows.map((x) => [x.kind, x.text]), [
    ["line", "Current runner version: '2.338.2'"], ["group", "Runner Image"], ["group", "Run npm test"],
    ["line", "not ok 1 - adds"], ["error", "Process completed with exit code 1."],
  ]);
  assert.deepEqual(r.failedRows.map((x) => [x.kind, x.text]), [
    ["step", "Run tests"], ["group", "Run npm test"], ["line", "not ok 1 - adds"], ["error", "Process completed with exit code 1."],
  ]);
});

test("job log script calls the API, not gh run view", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-log-"));
  try {
    writeFileSync(join(dir, "gh"), `#!/bin/sh\ncase "$4" in */logs) printf 'l1\\nl2\\n' ;; *) printf '{"name":"j","steps":[]}' ;; esac\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const out = execFileSync("sh", ["-c", JOB_LOG_SCRIPT, "corral", "github.com", "a/b", "2"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    const r = parseJobLog(out);
    assert.deepEqual(r.rows.map((x) => x.text), ["l1", "l2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents: the shown tab first, then the space, most recent wins", () => {
  const a = (address, tab, space, seq, app) => /** @type {any} */ ({ address, tab, space, seq, app, focused: false });
  const list = [a("t1", "tabA", "s1", 5, "claude-code"), a("t2", "tabB", "s1", 9, "codex"), a("t3", "tabB", "s1", 3, "claude-code")];
  assert.equal(pickAgent(list, "tabB", "s1")?.address, "t2");
  assert.equal(pickAgent(list, "tabZ", "s1")?.address, "t2");
  assert.equal(pickAgent(list, "tabZ", "s9"), null);
  assert.equal(agentName(list[0]), "Claude");
  assert.equal(agentName(list[1]), "Codex");
});

test("thread prompt quotes every comment", () => {
  const p = threadPrompt(14, { id: "T", resolved: false, outdated: false, path: "lib/git.js", line: 42, canResolve: true, canReply: true, hunk: "", comments: [{ id: "c", who: "mkoval", body: "Fix it.", at: "", url: "" }] });
  assert.match(p, /PR #14 at lib\/git\.js:42/);
  assert.match(p, /mkoval:\nFix it\./);
});
