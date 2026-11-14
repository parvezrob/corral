// Fuzzy file-name matching for "Find files". Pure, unit-tested in Node.

/** Lists every file of a root, NUL-separated, relative paths. Git's view when it's a repo (tracked and untracked, not ignored), else find. $1: root. */
export const FILES_SCRIPT = String.raw`cd "$1" || exit 1
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git --no-optional-locks ls-files -z --cached --others --exclude-standard 2>/dev/null | head -c 8000000
else
  find . -name .git -prune -o -name node_modules -prune -o -type f -print0 2>/dev/null | head -c 8000000 | sed -z 's#^\./##'
fi`;

/**
 * Scores how well `query` matches `path`: its characters must appear in order.
 * Higher is better; null means no match. Matches in the file name, at word
 * starts and in runs score more; shorter paths win ties.
 * @param {string} query  lower case, no spaces
 * @param {string} path
 * @returns {number | null}
 */
export function score(query, path) {
  if (!query) return 0;
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  let qi = 0, total = 0, run = 0, prev = -2;
  for (let i = 0; i < p.length && qi < query.length; i++) {
    if (p[i] !== query[qi]) { run = 0; continue; }
    let s = 1;
    if (i === prev + 1) { run++; s += 2 * run; } else run = 0;
    const before = i === 0 ? "/" : p[i - 1];
    if (before === "/" || before === "-" || before === "_" || before === "." || before === " ") s += 4;
    if (i >= nameStart) s += 3;
    total += s;
    prev = i;
    qi++;
  }
  if (qi < query.length) return null;
  return total * 100 - p.length;
}

/**
 * The best `limit` paths for a query, best first.
 * @param {string} query
 * @param {string[]} paths
 * @param {number} [limit]
 * @returns {string[]}
 */
export function rank(query, paths, limit = 200) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  /** @type {[number, string][]} */
  const hits = [];
  for (const path of paths) {
    const s = score(q, path);
    if (s !== null) hits.push([s, path]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  return hits.slice(0, limit).map((h) => h[1]);
}

/**
 * Searches file contents with ripgrep (or grep). $1: root, $2: the text,
 * literal. Prints path NUL line NUL text NUL per hit, at most 5 hits per file
 * and 500 in all.
 */
export const CONTENT_SCRIPT = String.raw`cd "$1" || exit 1
if command -v rg >/dev/null 2>&1; then
  rg --fixed-strings --smart-case --line-number --no-heading --color never --max-count 5 --max-columns 300 --max-columns-preview --null -e "$2" . 2>/dev/null
else
  grep -rInF --null --exclude-dir=.git --exclude-dir=node_modules -m 5 -e "$2" . 2>/dev/null
fi | head -n 500`;

/**
 * Parses CONTENT_SCRIPT output: "path\0line:text" per line (both rg and grep
 * with --null print that shape).
 * @param {string} stdout
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function parseContentHits(stdout) {
  const out = [];
  for (const raw of stdout.split("\n")) {
    const nul = raw.indexOf("\0");
    if (nul < 0) continue;
    const path = raw.slice(0, nul).replace(/^\.\//, "");
    const rest = raw.slice(nul + 1);
    const colon = rest.indexOf(":");
    const line = Number(rest.slice(0, colon));
    if (!Number.isInteger(line)) continue;
    out.push({ path, line, text: rest.slice(colon + 1).trim().slice(0, 300) });
  }
  return out;
}
