import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGES_SCRIPT, parseChanges, shortWhen, ACTIONS } from "../lib/changes.js";

const user = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

test("one call: groups, line counts, commits and what isn't pushed", (t) => {
  try { execFileSync("git", ["--version"]); } catch { t.skip("git not installed"); return; }
  const base = mkdtempSync(join(tmpdir(), "wb-changes-"));
  const remote = join(base, "remote.git"), dir = join(base, "work");
  const git = (/** @type {string[]} */ ...args) => execFileSync("git", ["-C", dir, ...user, ...args], { encoding: "utf8" });
  try {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
    writeFileSync(join(dir, "b.txt"), "x\n");
    git("add", "-A"); git("commit", "-q", "-m", "first"); git("push", "-q", "-u", "origin", "main");
    writeFileSync(join(dir, "c.txt"), "new\n");
    git("add", "c.txt"); git("commit", "-q", "-m", "second, not pushed");
    writeFileSync(join(dir, "a.txt"), "1\nTWO\n3\n4\n");     // unstaged edit
    writeFileSync(join(dir, "b.txt"), "y\n"); git("add", "b.txt"); // staged edit
    writeFileSync(join(dir, "b.txt"), "z\n");               // and unstaged on top
    writeFileSync(join(dir, "new file.md"), "# n\n");       // untracked

    const c = parseChanges(execFileSync("sh", ["-c", CHANGES_SCRIPT, "wb", dir], { encoding: "utf8" }));
    assert.equal(c.branch.head, "main");
    assert.equal(c.branch.upstream, "origin/main");
    assert.equal(c.branch.ahead, 1);
    assert.deepEqual(c.staged.map((f) => [f.path, f.letter, f.add, f.del]), [["b.txt", "M", 1, 1]]);
    assert.deepEqual(c.unstaged.map((f) => [f.path, f.letter, f.add, f.del]).sort(), [["a.txt", "M", 2, 1], ["b.txt", "M", 1, 1]]);
    assert.deepEqual(c.untracked.map((f) => f.path), ["new file.md"]);
    assert.equal(c.count, 3);
    assert.deepEqual(c.remotes, ["origin"]);
    assert.deepEqual(c.commits.map((x) => [x.subject, x.pushed]), [["second, not pushed", false], ["first", true]]);
    assert.equal(c.commits[0].short.length, 7);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("not a repo exits 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-norepo-"));
  try {
    assert.throws(() => execFileSync("sh", ["-c", CHANGES_SCRIPT, "wb", dir], { stdio: "pipe" }), (e) => /** @type {any} */ (e).status === 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relative times shorten", () => {
  assert.equal(shortWhen("3 hours ago"), "3h");
  assert.equal(shortWhen("1 day ago"), "1d");
  assert.equal(shortWhen("2 months ago"), "2mo");
  assert.equal(shortWhen("in the future"), "in the future");
});

test("actions keep paths after --", () => {
  assert.deepEqual(ACTIONS.stage(["-rf"]), ["add", "--", "-rf"]);
  assert.deepEqual(ACTIONS.discard(["a b.txt"]), ["restore", "--worktree", "--", "a b.txt"]);
});
