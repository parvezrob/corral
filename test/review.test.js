import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSection, placeThreads, splitSuggestion, applySuggestion, linesMatch, linesOf, changeLetter, PR_DIFF_SCRIPT } from "../lib/review.js";
import { parseDiff } from "../lib/diff.js";
import { parseThreadsAnswer, GH } from "../lib/pr.js";

const DIFF = [
  "diff --git a/lib/git.js b/lib/git.js",
  "index 111..222 100644",
  "--- a/lib/git.js",
  "+++ b/lib/git.js",
  "@@ -10,4 +10,5 @@ export function group(entries) {",
  "   const staged = [];",
  "-  const unstaged = entries.filter(isUnstaged);",
  "+  const unstaged = entries.filter(isUnstaged).map(joinRename);",
  "+  const untracked = [];",
  "   return { staged, unstaged };",
  " }",
  "diff --git a/old name.md b/new name.md",
  "similarity index 100%",
  "rename from old name.md",
  "rename to new name.md",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "",
].join("\n");

/** @returns {import("../lib/pr.js").Thread} */
const thread = (o) => ({ id: "T", resolved: false, outdated: false, path: "lib/git.js", line: 11, startLine: null, side: "RIGHT", canResolve: true, canReply: true, hunk: "", comments: [], ...o });

test("one file out of a PR diff: changed, renamed, deleted, bare patch", () => {
  assert.match(fileSection(DIFF, "lib/git.js") ?? "", /joinRename/);
  assert.doesNotMatch(fileSection(DIFF, "lib/git.js") ?? "", /gone/);
  assert.match(fileSection(DIFF, "new name.md") ?? "", /rename to new name\.md/);
  assert.match(fileSection(DIFF, "gone.txt") ?? "", /^-bye$/m);
  assert.equal(fileSection(DIFF, "missing.js"), null);
  assert.equal(fileSection("@@ -1 +1 @@\n-a\n+b", "x"), "@@ -1 +1 @@\n-a\n+b");
  assert.equal(fileSection("", "x"), null);
});

test("threads sit under their line, on the right side", () => {
  const rows = parseDiff(fileSection(DIFF, "lib/git.js") ?? "");
  const right = thread({ id: "R", line: 11, side: "RIGHT" });
  const left = thread({ id: "L", line: 11, side: "LEFT" });
  const old = thread({ id: "O", outdated: true });
  const far = thread({ id: "F", line: 500 });
  const { at, elsewhere } = placeThreads(rows, [right, left, old, far]);
  const where = (id) => [...at].find(([, list]) => list.some((t) => t.id === id))?.[0];
  assert.equal(rows[where("R")].text, "  const unstaged = entries.filter(isUnstaged).map(joinRename);");
  assert.equal(rows[where("L")].text, "  const unstaged = entries.filter(isUnstaged);");
  assert.deepEqual(elsewhere.map((t) => t.id), ["O", "F"]);
});

test("suggestion blocks", () => {
  const s = splitSuggestion("Renames show twice. Suggest:\r\n```suggestion\r\n  unstaged: entries.filter(isUnstaged).map(joinRename),\r\n```\r\nThanks");
  assert.equal(s.before, "Renames show twice. Suggest:");
  assert.equal(s.suggestion, "  unstaged: entries.filter(isUnstaged).map(joinRename),");
  assert.equal(s.after, "Thanks");
  assert.equal(splitSuggestion("```suggestion\n```").suggestion, "");
  assert.equal(splitSuggestion("Looks good").suggestion, null);
  assert.equal(splitSuggestion("```js\nx\n```").suggestion, null);
});

test("applying a suggestion keeps line endings; empty deletes", () => {
  assert.equal(applySuggestion("a\nb\nc\n", 2, 2, "B1\nB2"), "a\nB1\nB2\nc\n");
  assert.equal(applySuggestion("a\r\nb\r\nc", 1, 2, "x"), "x\r\nc");
  assert.equal(applySuggestion("a\nb\nc", 2, 3, ""), "a");
  assert.throws(() => applySuggestion("a\n", 5, 5, "x"), /aren't in the file/);
});

test("the working copy must still have the reviewed lines", () => {
  const rows = parseDiff(fileSection(DIFF, "lib/git.js") ?? "");
  const local = ["", "", "", "", "", "", "", "", "", "  const staged = [];", "  const unstaged = entries.filter(isUnstaged).map(joinRename);", "  const untracked = [];", "  return { staged, unstaged };", "}"].join("\n");
  assert.equal(linesMatch(local, rows, 11, 12), true);
  assert.equal(linesMatch(local.replace("joinRename", "other"), rows, 11, 11), false);
  assert.equal(linesMatch(local, rows, 40, 40), false);
  assert.deepEqual(linesOf(rows, 11, 12), ["  const unstaged = entries.filter(isUnstaged).map(joinRename);", "  const untracked = [];"]);
});

test("files, sides and ranges from GraphQL", () => {
  const g = parseThreadsAnswer(JSON.stringify({ data: { repository: {
    viewerDefaultMergeMethod: "MERGE", squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: false, autoMergeAllowed: false,
    pullRequest: {
      id: "PR_1", viewerDidAuthor: false,
      files: { totalCount: 2, nodes: [{ path: "a.js", additions: 1, deletions: 0, changeType: "ADDED", viewerViewedState: "VIEWED" }, { path: "b.js", additions: 2, deletions: 2, changeType: "MODIFIED", viewerViewedState: "UNVIEWED" }] },
      reviewThreads: { nodes: [
        { id: "T1", isResolved: false, isOutdated: false, path: "b.js", line: 9, originalLine: 9, startLine: 7, originalStartLine: 7, diffSide: "LEFT", viewerCanResolve: true, viewerCanReply: true, comments: { nodes: [] } },
        { id: "T2", isResolved: false, isOutdated: true, path: "b.js", line: null, originalLine: 4, startLine: null, originalStartLine: 3, diffSide: "RIGHT", viewerCanResolve: true, viewerCanReply: true, comments: { nodes: [] } },
      ] },
    },
  } } }));
  assert.equal(g.error, null);
  assert.equal(g.id, "PR_1");
  assert.deepEqual(g.files.map((f) => [f.path, f.viewed, changeLetter(f.change)]), [["a.js", true, "A"], ["b.js", false, "M"]]);
  assert.deepEqual(g.threads.map((t) => [t.id, t.startLine, t.line, t.side]), [["T1", 7, 9, "LEFT"], ["T2", 3, 4, "RIGHT"]]);
  assert.equal(parseThreadsAnswer('{"errors":[{"message":"nope"}]}').error, "nope");
});

test("line comment argv: single line and range", () => {
  const one = GH.lineComment("github.com", "a/b", 14, { body: "Why?", sha: "abc", path: "x.js", line: 9, side: "RIGHT" });
  assert.deepEqual(one.slice(0, 6), ["api", "--hostname", "github.com", "-X", "POST", "repos/a/b/pulls/14/comments"]);
  assert.ok(one.includes("line=9") && !one.some((a) => a.startsWith("start_line")));
  const range = GH.lineComment("github.com", "a/b", 14, { body: "x", sha: "abc", path: "x.js", line: 9, side: "LEFT", startLine: 7 });
  assert.ok(range.includes("start_line=7") && range.includes("start_side=LEFT"));
});

test("PR diff script falls back to the file's patch", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-prdiff-"));
  try {
    writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$1 $2" in
  "pr diff") echo "could not find pull request diff: diff too large" >&2; exit 1 ;;
  "api --hostname") [ "$3" = "ghe.corp" ] && [ "$4" = "repos/acme/w/pulls/7/files" ] && printf '@@ -1 +1 @@\\n-a\\n+b\\n' ;;
esac
`);
    chmodSync(join(dir, "gh"), 0o755);
    const out = execFileSync("sh", ["-c", PR_DIFF_SCRIPT, "corral", "ghe.corp/acme/w", "7", "x.js"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    assert.equal(fileSection(out, "x.js"), "@@ -1 +1 @@\n-a\n+b\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
