// Generated from lib/changes.js by scripts/build.mjs. Edit the source, not this copy.
// Everything the Changes panel shows, in one round trip, and the commands its
// buttons run. Pure, unit-tested in Node.
import { parseStatusV2, groupStatus, parseNumstatZ } from "./git.js";

/** git with flags that never write under .git while reading. */
const G = "git --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false";

/**
 * $1: the repo root. Sections, separated by \036: status, staged numstat,
 * unstaged numstat, the last 30 commits (sha \037 subject \037 when \037 author
 * per line), the full shas not on the upstream yet, and the remotes. Exit 3: not a repo.
 */
export const CHANGES_SCRIPT = String.raw`cd "$1" || exit 1
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3
${G} status --porcelain=v2 -z --branch --untracked-files=all
printf '\036'
${G} diff --cached --numstat -z -M
printf '\036'
${G} diff --numstat -z -M
printf '\036'
${G} log -n 30 --format='%H%x1f%s%x1f%ar%x1f%an' 2>/dev/null
printf '\036'
${G} rev-list '@{u}..HEAD' 2>/dev/null
printf '\036'
git remote 2>/dev/null
exit 0`;

/**
 * @typedef {object} ChangedFile
 * @property {string} path
 * @property {string | null} orig
 * @property {string} letter      A M D R C T U ?
 * @property {number} add
 * @property {number} del
 * @property {boolean} binary
 *
 * @typedef {{ sha: string, short: string, subject: string, when: string, author: string, pushed: boolean }} Commit
 *
 * @typedef {object} Changes
 * @property {import("./git.js").Branch} branch
 * @property {ChangedFile[]} staged
 * @property {ChangedFile[]} unstaged
 * @property {ChangedFile[]} untracked
 * @property {ChangedFile[]} conflicts
 * @property {Commit[]} commits
 * @property {number} count       distinct changed paths
 * @property {string[]} remotes   e.g. ["origin"]
 */

/**
 * @param {string} stdout
 * @returns {Changes}
 */
export function parseChanges(stdout) {
  const [status = "", staged = "", unstaged = "", log = "", ahead = "", remotes = ""] = stdout.split("\x1e");
  const { branch, entries } = parseStatusV2(status);
  const g = groupStatus(entries);
  const stagedStats = parseNumstatZ(staged);
  const unstagedStats = parseNumstatZ(unstaged);
  /** @param {import("./git.js").StatusEntry} e @param {string} letter @param {Map<string, { add: number, del: number, binary: boolean }>} stats @returns {ChangedFile} */
  const file = (e, letter, stats) => ({ path: e.path, orig: e.orig, letter, ...(stats.get(e.path) ?? { add: 0, del: 0, binary: false }) });
  /** @param {string} path @param {string} letter @returns {ChangedFile} */
  const plain = (path, letter) => ({ path, orig: null, letter, add: 0, del: 0, binary: false });
  const unpushed = new Set(ahead.split("\n").map((s) => s.trim()).filter(Boolean));
  const hasUpstream = branch.upstream !== null;
  /** @type {Commit[]} */
  const commits = [];
  for (const line of log.split("\n")) {
    const [sha, subject, when, author] = line.split("\x1f");
    if (!sha || sha.length < 7) continue;
    commits.push({ sha, short: sha.slice(0, 7), subject: subject ?? "", when: shortWhen(when ?? ""), author: author ?? "", pushed: hasUpstream && !unpushed.has(sha) });
  }
  const result = {
    branch,
    staged: g.staged.map((e) => file(e, e.x, stagedStats)),
    unstaged: g.unstaged.map((e) => file(e, e.y, unstagedStats)),
    untracked: g.untracked.map((e) => plain(e.path, "?")),
    conflicts: g.conflicts.map((e) => plain(e.path, "U")),
    commits,
    count: 0,
    remotes: remotes.split("\n").map((r) => r.trim()).filter(Boolean),
  };
  result.count = new Set([...result.staged, ...result.unstaged, ...result.untracked, ...result.conflicts].map((f) => f.path)).size;
  return result;
}

/**
 * "3 hours ago" -> "3h", "2 weeks ago" -> "2w".
 * @param {string} rel
 */
export function shortWhen(rel) {
  const m = /^(\d+) (second|minute|hour|day|week|month|year)s? ago/.exec(rel);
  if (!m) return rel;
  return `${m[1]}${{ second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" }[m[2]]}`;
}

/**
 * The git arguments behind each button. Paths are passed after "--" so a file
 * named like a flag stays a file.
 */
// Paths are literal: without --literal-pathspecs git reads "app/[id]/page.tsx" as
// a pattern that also matches "app/i/page.tsx", and Discard would hit both.
const LITERAL = "--literal-pathspecs";

export const ACTIONS = {
  /** @param {string[]} paths */ stage: (paths) => [LITERAL, "add", "--", ...paths],
  /**
   * @param {string[]} paths
   * @param {boolean} [initial] before the first commit there's no HEAD to restore from
   */
  unstage: (paths, initial = false) => (initial ? [LITERAL, "rm", "--cached", "-q", "--", ...paths] : [LITERAL, "restore", "--staged", "--", ...paths]),
  /** Throws away worktree edits to tracked files. @param {string[]} paths */ discard: (paths) => [LITERAL, "restore", "--worktree", "--", ...paths],
  /** Deletes untracked files (only the ones named). @param {string[]} paths */ clean: (paths) => [LITERAL, "clean", "-f", "--", ...paths],
  stageAll: () => ["add", "-A"],
  unstageAll: () => ["reset", "-q"],
  /** @param {string} message */ commit: (message) => ["commit", "-m", message],
  pull: () => ["pull", "--ff-only"],
  push: () => ["push"],
  /** First push of a branch with no upstream. @param {string} remote @param {string} branch */ publish: (remote, branch) => ["push", "-u", remote, branch],
};
