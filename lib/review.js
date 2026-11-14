// Reviewing a pull request file by file: the file's part of the PR diff, review
// threads placed on the lines they talk about, and suggested changes applied to
// the working copy. Pure.
import { untab } from "./diff.js";

/**
 * `sh -c PR_DIFF_SCRIPT corral <host/owner/name> <number> <path>`: the whole PR
 * diff, or, when GitHub won't produce one (too large), that file's patch.
 */
export const PR_DIFF_SCRIPT = `out=$(gh pr diff "$2" -R "$1" --color never 2>&1) && { printf '%s' "$out"; exit 0; }
repo=\${1#*/}
P="$3" gh api --hostname "\${1%%/*}" "repos/$repo/pulls/$2/files" --paginate --jq '.[] | select(.filename == $ENV.P) | .patch' 2>/dev/null && exit 0
printf '%s\\n' "$out" >&2
exit 1`;

/**
 * One file's part of a multi-file unified diff (a bare patch passes through).
 * @param {string} diff @param {string} path
 * @returns {string | null} null when the file isn't in it
 */
export function fileSection(diff, path) {
  if (!diff.startsWith("diff --git ")) return diff.trim() ? diff : null;
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const lines = block.split("\n", 12);
    const plus = lines.find((l) => l.startsWith("+++ "));
    const minus = lines.find((l) => l.startsWith("--- "));
    const renamed = lines.find((l) => l.startsWith("rename to "));
    /** @param {string | undefined} l */
    const strip = (l) => l?.slice(4).replace(/\t.*$/, "").replace(/^"(.*)"$/, "$1").replace(/^[ab]\//, "");
    let name = plus && plus !== "+++ /dev/null" ? strip(plus) : minus && minus !== "--- /dev/null" ? strip(minus) : renamed?.slice(10);
    if (!name) {
      const m = / b\/(.+)$/.exec(lines[0]);
      name = m?.[1];
    }
    if (name === path) return block;
  }
  return null;
}

/**
 * Which diff row each thread belongs under. A thread on the new side sits under
 * the row with that new line number; on the old side, under the removed line.
 * @param {import("./diff.js").DiffRow[]} rows
 * @param {import("./pr.js").Thread[]} threads  this file's threads
 * @returns {{ at: Map<number, import("./pr.js").Thread[]>, elsewhere: import("./pr.js").Thread[] }}
 */
export function placeThreads(rows, threads) {
  /** @type {Map<number, import("./pr.js").Thread[]>} */
  const at = new Map();
  const elsewhere = [];
  for (const t of threads) {
    const index = t.outdated || t.line === null ? -1
      : rows.findIndex((r) => (t.side === "LEFT" ? r.old === t.line && r.kind !== "add" : r.new === t.line && r.kind !== "del"));
    if (index < 0) { elsewhere.push(t); continue; }
    const list = at.get(index) ?? [];
    list.push(t);
    at.set(index, list);
  }
  return { at, elsewhere };
}

/**
 * A comment split around its ```suggestion block, if it has one.
 * @param {string} body
 * @returns {{ before: string, suggestion: string | null, after: string }}
 */
export function splitSuggestion(body) {
  const text = body.replace(/\r\n/g, "\n");
  const m = /^([ \t]*)(`{3,}|~{3,})suggestion[ \t]*\n([\s\S]*?)\n?^\1\2[ \t]*$/m.exec(text);
  if (!m) return { before: text, suggestion: null, after: "" };
  return { before: text.slice(0, m.index).trim(), suggestion: m[3], after: text.slice(m.index + m[0].length).trim() };
}

/**
 * Replaces lines start..end (1-based, inclusive) with a suggestion, keeping the
 * file's line endings.
 * @param {string} text @param {number} start @param {number} end @param {string} suggestion
 */
export function applySuggestion(text, start, end, suggestion) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (start < 1 || end < start || end > lines.length) throw new Error(`Lines ${start}–${end} aren't in the file.`);
  const replacement = suggestion === "" ? [] : suggestion.replace(/\r\n/g, "\n").split("\n");
  lines.splice(start - 1, end - start + 1, ...replacement);
  return lines.join(eol);
}

/**
 * Whether the working copy still has the lines the reviewer saw, judged by the
 * diff's new-side rows for that range.
 * @param {string} text the local file
 * @param {import("./diff.js").DiffRow[]} rows
 * @param {number} start @param {number} end
 */
export function linesMatch(text, rows, start, end) {
  const local = text.split(/\r?\n/);
  for (let n = start; n <= end; n++) {
    const row = rows.find((r) => r.new === n && r.kind !== "del");
    if (!row) return false;
    if (local[n - 1] === undefined || (untab(local[n - 1]) || " ") !== row.text) return false;
  }
  return true;
}

/** The lines a suggestion replaces, as the diff shows them. @param {import("./diff.js").DiffRow[]} rows @param {number} start @param {number} end */
export function linesOf(rows, start, end) {
  const out = [];
  for (let n = start; n <= end; n++) out.push(rows.find((r) => r.new === n && r.kind !== "del")?.text ?? "");
  return out;
}

/** "A", "M", "D", "R" for a GraphQL changeType. @param {string} type */
export function changeLetter(type) {
  return { ADDED: "A", DELETED: "D", RENAMED: "R", COPIED: "C" }[type] ?? "M";
}
