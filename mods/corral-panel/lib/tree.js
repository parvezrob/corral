// Generated from lib/tree.js by scripts/build.mjs. Edit the source, not this copy.
// The Files tree: one script lists every open folder and the git status in a
// single round trip (it matters over Tailscale), and pure functions turn that
// into the rows on screen. Pure, unit-tested in Node.
import { splitNul } from "./sh.js";
import { parseStatusV2, statusLetter } from "./git.js";

/** Most entries listed per folder. */
export const PER_FOLDER = 2000;

/**
 * $1: the root; $2...: folders below it to list ("" is the root itself).
 * Prints NUL-separated tokens: ">folder", then "d:name" / "f:name" / "l:name"
 * (a link to a folder) per entry, and finally "#git" followed by
 * `git status --porcelain=v2 -z --branch` when the root is in a work tree.
 * Reads only: no git lock, no index refresh.
 */
export const LIST_SCRIPT = String.raw`root=$1; shift
for d in "$@"; do
  printf '>%s\0' "$d"
  dir=$root; [ -n "$d" ] && dir="$root/$d"
  n=0
  for p in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    name=$` + "{p##*/}" + String.raw`
    [ "$name" = .git ] && continue
    if [ -L "$p" ] && [ -d "$p" ]; then k=l; elif [ -d "$p" ]; then k=d; else k=f; fi
    printf '%s:%s\0' "$k" "$name"
    n=$((n+1)); [ "$n" -ge ${PER_FOLDER} ] && break
  done
done
if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '#git\0'
  git -C "$root" --no-optional-locks -c core.fsmonitor=false status --porcelain=v2 -z --branch --untracked-files=all 2>/dev/null
fi`;

/**
 * @typedef {{ name: string, dir: boolean, link: boolean }} Entry
 * @typedef {{ folders: Map<string, Entry[]>, marks: Map<string, string>, branch: import("./git.js").Branch | null, git: boolean }} Listing
 */

/**
 * @param {string} stdout
 * @returns {Listing}
 */
export function parseListing(stdout) {
  /** @type {Map<string, Entry[]>} */
  const folders = new Map();
  const tokens = splitNul(stdout);
  /** @type {Entry[] | null} */
  let current = null;
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "#git") break;
    if (t.startsWith(">")) { current = []; folders.set(t.slice(1), current); continue; }
    if (!current || t[1] !== ":") continue;
    current.push({ name: t.slice(2), dir: t[0] === "d" || t[0] === "l", link: t[0] === "l" });
  }
  for (const list of folders.values()) list.sort(byFolderThenName);
  const git = i < tokens.length;
  /** @type {Map<string, string>} */
  const marks = new Map();
  let branch = null;
  if (git) {
    const status = parseStatusV2(tokens.slice(i + 1).join("\0") + "\0");
    branch = status.branch;
    for (const e of status.entries.slice(0, 20000)) {
      if (e.kind === "ignored") continue;
      const letter = statusLetter(e);
      marks.set(e.path, letter === "?" ? "A" : letter);
    }
  }
  return { folders, marks, branch, git };
}

/** @param {Entry} a @param {Entry} b */
function byFolderThenName(a, b) {
  return Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Folders that hold a change get a dot, so a collapsed tree still shows where
 * the work is.
 * @param {Map<string, string>} marks  path -> letter
 * @returns {Set<string>}
 */
export function changedFolders(marks) {
  const out = new Set();
  for (const path of marks.keys()) {
    let i = path.lastIndexOf("/");
    while (i > 0) {
      const folder = path.slice(0, i);
      if (out.has(folder)) break;
      out.add(folder);
      i = folder.lastIndexOf("/");
    }
  }
  return out;
}

/**
 * @typedef {object} Row
 * @property {string} path    relative to the root
 * @property {string} name
 * @property {number} depth
 * @property {boolean} dir
 * @property {boolean} open
 * @property {string} mark    a file's letter, "•" for a folder holding changes, or ""
 */

/**
 * The visible rows: the root's entries, and the entries of every open folder
 * under them, depth first.
 * @param {Map<string, Entry[]>} folders
 * @param {Set<string>} open
 * @param {Map<string, string>} marks
 * @param {Set<string>} [dirty]  changedFolders(marks)
 * @returns {Row[]}
 */
export function visibleRows(folders, open, marks, dirty = changedFolders(marks)) {
  /** @type {Row[]} */
  const rows = [];
  /** @param {string} prefix @param {number} depth */
  const walk = (prefix, depth) => {
    for (const e of folders.get(prefix) ?? []) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      const isOpen = e.dir && open.has(path);
      rows.push({ path, name: e.name, depth, dir: e.dir, open: isOpen, mark: e.dir ? (dirty.has(path) ? "•" : "") : marks.get(path) ?? "" });
      if (isOpen && depth < 64) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}
