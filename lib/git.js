// Git output parsers. Pure: no Herdr imports, unit-tested in Node.
import { splitNul } from "./sh.js";

/**
 * Flags for every read-only git call: write nothing under .git (no index refresh,
 * no lock, no fsmonitor cookie). A folder watch would see such writes and start
 * the next refresh, forever.
 */
export const READ_ONLY = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

/**
 * @typedef {object} Branch
 * @property {string | null} head      branch name, null when detached
 * @property {string | null} oid       commit, null before the first commit
 * @property {string | null} upstream
 * @property {number} ahead
 * @property {number} behind
 */

/**
 * @typedef {object} StatusEntry
 * @property {string} path            repo-relative, as git prints it
 * @property {string | null} orig     the old path of a rename or copy
 * @property {"changed" | "renamed" | "conflict" | "untracked" | "ignored"} kind
 * @property {string} x               index (staged) state: one of . M T A D R C U
 * @property {string} y               worktree (unstaged) state
 */

/**
 * Parses `git status --porcelain=v2 -z --branch`.
 * @param {string} stdout
 * @returns {{ branch: Branch, entries: StatusEntry[] }}
 */
export function parseStatusV2(stdout) {
  /** @type {Branch} */
  const branch = { head: null, oid: null, upstream: null, ahead: 0, behind: 0 };
  /** @type {StatusEntry[]} */
  const entries = [];
  const fields = splitNul(stdout);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.startsWith("# ")) {
      const [key, ...rest] = f.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") branch.head = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]); }
      }
      continue;
    }
    const type = f[0];
    if (type === "1") {
      // 1 XY sub mH mI mW hH hI path
      const parts = f.split(" ");
      entries.push({ kind: "changed", x: parts[1][0], y: parts[1][1], path: parts.slice(8).join(" "), orig: null });
    } else if (type === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const parts = f.split(" ");
      entries.push({ kind: "renamed", x: parts[1][0], y: parts[1][1], path: parts.slice(9).join(" "), orig: fields[++i] ?? null });
    } else if (type === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = f.split(" ");
      entries.push({ kind: "conflict", x: parts[1][0], y: parts[1][1], path: parts.slice(10).join(" "), orig: null });
    } else if (type === "?") {
      entries.push({ kind: "untracked", x: "?", y: "?", path: f.slice(2), orig: null });
    } else if (type === "!") {
      entries.push({ kind: "ignored", x: "!", y: "!", path: f.slice(2), orig: null });
    }
  }
  return { branch, entries };
}

/**
 * Splits status entries into the groups the Changes panel shows. A file with
 * both staged and unstaged edits appears in both.
 * @param {StatusEntry[]} entries
 */
export function groupStatus(entries) {
  /** @type {StatusEntry[]} */ const staged = [];
  /** @type {StatusEntry[]} */ const unstaged = [];
  /** @type {StatusEntry[]} */ const untracked = [];
  /** @type {StatusEntry[]} */ const conflicts = [];
  for (const e of entries) {
    if (e.kind === "conflict") conflicts.push(e);
    else if (e.kind === "untracked") untracked.push(e);
    else if (e.kind !== "ignored") {
      if (e.x !== ".") staged.push(e);
      if (e.y !== ".") unstaged.push(e);
    }
  }
  return { staged, unstaged, untracked, conflicts };
}

/**
 * One letter for a file's state, as the panels show it: A M D R C T U ?.
 * `side` picks the index or worktree column; "any" prefers the worktree.
 * @param {StatusEntry} e
 * @param {"staged" | "unstaged" | "any"} [side]
 * @returns {string}
 */
export function statusLetter(e, side = "any") {
  if (e.kind === "conflict") return "U";
  if (e.kind === "untracked") return "?";
  const c = side === "staged" ? e.x : side === "unstaged" ? e.y : e.y !== "." ? e.y : e.x;
  return c === "." ? "" : c;
}

/**
 * Parses `git diff --numstat -z`: lines added and removed per path. Binary files
 * report "-" for both and come back with binary: true. Renames are keyed by the
 * new path.
 * @param {string} stdout
 * @returns {Map<string, { add: number, del: number, binary: boolean }>}
 */
export function parseNumstatZ(stdout) {
  const out = new Map();
  const fields = splitNul(stdout);
  for (let i = 0; i < fields.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!m) continue;
    let path = m[3];
    if (path === "") { i++; path = fields[++i] ?? ""; } // rename: "" NUL old NUL new
    const binary = m[1] === "-";
    const prev = out.get(path) ?? { add: 0, del: 0, binary: false };
    out.set(path, { add: prev.add + (binary ? 0 : Number(m[1])), del: prev.del + (binary ? 0 : Number(m[2])), binary: prev.binary || binary });
  }
  return out;
}
