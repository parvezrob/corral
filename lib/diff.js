// Unified diff to rows the viewer can draw one by one (a virtual list draws only
// the rows on screen). Pure, unit-tested in Node.

/**
 * @typedef {object} DiffRow
 * @property {"hunk" | "add" | "del" | "ctx" | "note"} kind
 * @property {number | null} old   line number on the old side
 * @property {number | null} new   line number on the new side
 * @property {string} text
 */

/** Rows and characters beyond these are cut, with a note saying so. */
export const LIMITS = { rows: 20000, chars: 2000 };

/**
 * Text draws a tab as nothing: pad each one to the next 4-column stop.
 * @param {string} text
 */
export function untab(text) {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) out += ch === "\t" ? " ".repeat(4 - (out.length % 4)) : ch;
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  const t = untab(text);
  return t.length > LIMITS.chars ? `${t.slice(0, LIMITS.chars)} … (line cut)` : t || " ";
}

/**
 * Parses `git diff` output for one file (headers are skipped).
 * @param {string} diff
 * @returns {DiffRow[]}
 */
export function parseDiff(diff) {
  /** @type {DiffRow[]} */
  const rows = [];
  let old = 0, now = 0, inHunk = false;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (rows.length >= LIMITS.rows) {
      rows.push({ kind: "note", old: null, new: null, text: `Diff cut at ${LIMITS.rows.toLocaleString("en")} lines` });
      break;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      old = Number(hunk[1]); now = Number(hunk[2]); inHunk = true;
      rows.push({ kind: "hunk", old: null, new: null, text: line });
      continue;
    }
    if (!inHunk) {
      if (/^Binary files /.test(line)) rows.push({ kind: "note", old: null, new: null, text: "Binary file changed" });
      continue;
    }
    const c = line[0];
    if (c === "+") rows.push({ kind: "add", old: null, new: now++, text: clip(line.slice(1)) });
    else if (c === "-") rows.push({ kind: "del", old: old++, new: null, text: clip(line.slice(1)) });
    else if (c === " " || line === "") rows.push({ kind: "ctx", old: old++, new: now++, text: clip(line.slice(1)) });
    else if (c === "\\") rows.push({ kind: "note", old: null, new: null, text: line.slice(2) });
  }
  return rows;
}

/**
 * A whole new file as diff rows (untracked files have no git diff).
 * @param {string} text
 * @returns {DiffRow[]}
 */
export function addedFileRows(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  /** @type {DiffRow[]} */
  const rows = [{ kind: "hunk", old: null, new: null, text: `@@ -0,0 +1,${lines.length} @@ new file` }];
  for (let i = 0; i < lines.length && rows.length < LIMITS.rows; i++) rows.push({ kind: "add", old: null, new: i + 1, text: clip(lines[i]) });
  if (lines.length + 1 > LIMITS.rows) rows.push({ kind: "note", old: null, new: null, text: `File cut at ${LIMITS.rows.toLocaleString("en")} lines` });
  return rows;
}

/**
 * Widest row in characters, for the horizontal scroll width.
 * @param {DiffRow[]} rows
 */
export function widestRow(rows) {
  let w = 0;
  for (const r of rows) if (r.text.length > w) w = r.text.length;
  return w;
}
