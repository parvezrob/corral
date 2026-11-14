import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMarkdown } from "../lib/markdown.js";
import { languageFor, languageForFence, isMarkdown } from "../lib/lang.js";
import { parseDiff, addedFileRows, untab, widestRow } from "../lib/diff.js";

test("splits prose and fenced code", () => {
  const md = "# Title\n\nText.\n\n```ts\nconst a: number = 1;\n```\n\nMore *text*.\n\n~~~\nplain\n~~~\n";
  assert.deepEqual(splitMarkdown(md), [
    { kind: "text", text: "# Title\n\nText." },
    { kind: "code", lang: "ts", code: "const a: number = 1;" },
    { kind: "text", text: "More *text*." },
    { kind: "code", lang: "", code: "plain" },
  ]);
});

test("longer fences hold shorter ones; an unclosed fence runs to the end", () => {
  assert.deepEqual(splitMarkdown("````md\n```js\nx\n```\n````"), [{ kind: "code", lang: "md", code: "```js\nx\n```" }]);
  assert.deepEqual(splitMarkdown("a\n```py\nprint(1)"), [{ kind: "text", text: "a" }, { kind: "code", lang: "py", code: "print(1)" }]);
});

test("indented fences lose their indent", () => {
  assert.deepEqual(splitMarkdown("  ```sh\n  ls -la\n  ```"), [{ kind: "code", lang: "sh", code: "ls -la" }]);
});

test("languages", () => {
  assert.equal(languageFor("/a/b/x.tsx"), "js");
  assert.equal(languageFor("Cargo.toml"), "yaml");
  assert.equal(languageFor("main.rs"), "rust");
  assert.equal(languageFor("Dockerfile"), "bash");
  assert.equal(languageFor("notes.txt"), "text");
  assert.equal(languageForFence("TypeScript"), "js");
  assert.equal(languageForFence("rust"), "rust");
  assert.equal(languageForFence("py"), "python");
  assert.equal(languageForFence("mermaid"), "text");
  assert.ok(isMarkdown("README.MD"));
  assert.ok(!isMarkdown("x.js"));
});

test("diff rows carry both line numbers", () => {
  const diff = [
    "diff --git a/x.js b/x.js",
    "index 1..2 100644",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -10,3 +10,4 @@ function f() {",
    " keep",
    "-old",
    "+new",
    "+\tmore",
    " tail",
    "\\ No newline at end of file",
  ].join("\n");
  const rows = parseDiff(diff);
  assert.deepEqual(rows.map((r) => [r.kind, r.old, r.new, r.text]), [
    ["hunk", null, null, "@@ -10,3 +10,4 @@ function f() {"],
    ["ctx", 10, 10, "keep"],
    ["del", 11, null, "old"],
    ["add", null, 11, "new"],
    ["add", null, 12, "    more"],
    ["ctx", 12, 13, "tail"],
    ["note", null, null, "No newline at end of file"],
  ]);
});

test("binary and new files", () => {
  assert.deepEqual(parseDiff("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n").map((r) => r.text), ["Binary file changed"]);
  const rows = addedFileRows("a\nb\n");
  assert.deepEqual(rows.map((r) => [r.kind, r.new, r.text]), [["hunk", null, "@@ -0,0 +1,2 @@ new file"], ["add", 1, "a"], ["add", 2, "b"]]);
  assert.equal(widestRow(rows), "@@ -0,0 +1,2 @@ new file".length);
});

test("untab pads to 4-column stops", () => {
  assert.equal(untab("a\tb"), "a   b");
  assert.equal(untab("\t\tx"), "        x");
});
