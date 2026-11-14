import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatusV2, groupStatus, statusLetter, parseNumstatZ, READ_ONLY } from "../lib/git.js";

test("parses branch headers", () => {
  const out = "# branch.oid 1234abcd\0# branch.head feat/x\0# branch.upstream origin/feat/x\0# branch.ab +2 -1\0";
  assert.deepEqual(parseStatusV2(out).branch, { oid: "1234abcd", head: "feat/x", upstream: "origin/feat/x", ahead: 2, behind: 1 });
});

test("parses initial and detached states", () => {
  const { branch } = parseStatusV2("# branch.oid (initial)\0# branch.head (detached)\0");
  assert.equal(branch.oid, null);
  assert.equal(branch.head, null);
  assert.equal(branch.upstream, null);
});

test("parses every entry type, keeping spaces in paths", () => {
  const out = [
    "1 .M N... 100644 100644 100644 aaa aaa src/a file.js",
    "2 R. N... 100644 100644 100644 bbb bbb R100 lib/new name.js",
    "lib/old name.js",
    "u UU N... 100644 100644 100644 100644 c1 c2 c3 conflict.txt",
    "? notes/todo.md",
    "! dist/out.js",
    "",
  ].join("\0");
  const { entries } = parseStatusV2(out);
  assert.deepEqual(entries.map((e) => [e.kind, e.x, e.y, e.path, e.orig]), [
    ["changed", ".", "M", "src/a file.js", null],
    ["renamed", "R", ".", "lib/new name.js", "lib/old name.js"],
    ["conflict", "U", "U", "conflict.txt", null],
    ["untracked", "?", "?", "notes/todo.md", null],
    ["ignored", "!", "!", "dist/out.js", null],
  ]);
});

test("groups a file with staged and unstaged edits into both", () => {
  const { entries } = parseStatusV2("1 MM N... 100644 100644 100644 a b both.js\0? new.js\0u UU N... 1 1 1 1 a b c c.js\0");
  const g = groupStatus(entries);
  assert.deepEqual(g.staged.map((e) => e.path), ["both.js"]);
  assert.deepEqual(g.unstaged.map((e) => e.path), ["both.js"]);
  assert.deepEqual(g.untracked.map((e) => e.path), ["new.js"]);
  assert.deepEqual(g.conflicts.map((e) => e.path), ["c.js"]);
  assert.equal(statusLetter(g.staged[0], "staged"), "M");
  assert.equal(statusLetter(g.untracked[0]), "?");
  assert.equal(statusLetter(g.conflicts[0]), "U");
});

test("numstat: counts, binaries and renames keyed by the new path", () => {
  const out = "3\t1\tsrc/a.js\0-\t-\timg.png\0" + "5\t0\t\0old.js\0new.js\0";
  const m = parseNumstatZ(out);
  assert.deepEqual(m.get("src/a.js"), { add: 3, del: 1, binary: false });
  assert.deepEqual(m.get("img.png"), { add: 0, del: 0, binary: true });
  assert.deepEqual(m.get("new.js"), { add: 5, del: 0, binary: false });
  assert.equal(m.has("old.js"), false);
});

test("matches real git output", (t) => {
  try { execFileSync("git", ["--version"]); } catch { t.skip("git not installed"); return; }
  const dir = mkdtempSync(join(tmpdir(), "wb-git-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "keep.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "move me.txt"), "a\nb\nc\nd\ne\n");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    writeFileSync(join(dir, "keep.txt"), "one\nTWO\nthree\n");
    git("mv", "move me.txt", "moved.txt");
    writeFileSync(join(dir, "fresh file.md"), "# hi\n");

    const { branch, entries } = parseStatusV2(git(...READ_ONLY, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"));
    assert.equal(branch.head, "main");
    assert.equal(branch.upstream, null);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    assert.equal(byPath["keep.txt"].y, "M");
    assert.equal(byPath["moved.txt"].kind, "renamed");
    assert.equal(byPath["moved.txt"].orig, "move me.txt");
    assert.equal(byPath["fresh file.md"].kind, "untracked");

    const stats = parseNumstatZ(git(...READ_ONLY, "diff", "HEAD", "--numstat", "-z", "-M"));
    assert.deepEqual(stats.get("keep.txt"), { add: 2, del: 1, binary: false });
    assert.deepEqual(stats.get("moved.txt"), { add: 0, del: 0, binary: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
