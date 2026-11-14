import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIST_SCRIPT, parseListing, visibleRows, changedFolders } from "../lib/tree.js";
import { score, rank, FILES_SCRIPT, CONTENT_SCRIPT, parseContentHits } from "../lib/fuzzy.js";

/** A small repo: src/app.ts (changed), src/util/, notes.md (new), .hidden, a link to a folder. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-files-"));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src", "util"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "util", "strings.ts"), "export const findMe = 'needle';\n");
  writeFileSync(join(dir, ".hidden"), "x\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 2;\n");
  writeFileSync(join(dir, "notes.md"), "needle in notes\n");
  writeFileSync(join(dir, "ignored.log"), "noise\n");
  symlinkSync(join(dir, "src"), join(dir, "src-link"));
  return dir;
}

test("one listing call: folders, entries and git marks", (t) => {
  try { execFileSync("git", ["--version"]); } catch { t.skip("git not installed"); return; }
  const dir = fixture();
  try {
    const out = execFileSync("sh", ["-c", LIST_SCRIPT, "wb", dir, "", "src"], { encoding: "utf8" });
    const l = parseListing(out);
    assert.equal(l.git, true);
    assert.equal(l.branch?.head, "main");
    assert.deepEqual(l.folders.get("")?.map((e) => `${e.dir ? "d" : "f"}${e.link ? "l" : ""}:${e.name}`),
      ["d:src", "dl:src-link", "f:.gitignore", "f:.hidden", "f:ignored.log", "f:notes.md", "f:README.md"]);
    assert.deepEqual(l.folders.get("src")?.map((e) => e.name), ["util", "app.ts"]);
    assert.equal(l.marks.get("src/app.ts"), "M");
    assert.equal(l.marks.get("notes.md"), "A");
    assert.equal(l.marks.has("ignored.log"), false);

    const rows = visibleRows(l.folders, new Set(["src"]), l.marks);
    assert.deepEqual(rows.slice(0, 4).map((r) => [r.path, r.depth, r.mark]), [["src", 0, "•"], ["src/util", 1, ""], ["src/app.ts", 1, "M"], ["src-link", 0, ""]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder that isn't a repo lists without marks", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-plain-"));
  try {
    writeFileSync(join(dir, "a b.txt"), "");
    const l = parseListing(execFileSync("sh", ["-c", LIST_SCRIPT, "wb", dir, ""], { encoding: "utf8" }));
    assert.equal(l.git, false);
    assert.deepEqual(l.folders.get("")?.map((e) => e.name), ["a b.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changed folders cover every ancestor", () => {
  assert.deepEqual([...changedFolders(new Map([["a/b/c.js", "M"], ["a/d.js", "A"], ["top.js", "M"]]))].sort(), ["a", "a/b"]);
});

test("fuzzy score prefers file names, word starts and runs", () => {
  assert.equal(score("xyz", "src/app.ts"), null);
  assert.ok(score("app", "src/app.ts") > score("app", "apps/other/thing.ts"));
  assert.ok(score("gitjs", "lib/git.js") > score("gitjs", "lib/gizmo/item.js"));
  assert.deepEqual(rank("rdm", ["docs/random.txt", "README.md", "src/rdm/x.js"]).slice(0, 1), ["README.md"]);
  assert.deepEqual(rank("", ["a"]), []);
});

test("file list and content search scripts", (t) => {
  try { execFileSync("git", ["--version"]); } catch { t.skip("git not installed"); return; }
  const dir = fixture();
  try {
    const files = execFileSync("sh", ["-c", FILES_SCRIPT, "wb", dir], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
    assert.ok(files.includes("src/util/strings.ts"));
    assert.ok(files.includes("notes.md"), "untracked files are listed");
    assert.ok(!files.includes("ignored.log"), "ignored files are not");
    const hits = parseContentHits(execFileSync("sh", ["-c", CONTENT_SCRIPT, "wb", dir, "needle"], { encoding: "utf8" }));
    assert.deepEqual(hits.map((h) => `${h.path}:${h.line}`).sort(), ["notes.md:1", "src/util/strings.ts:1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
