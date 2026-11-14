// POSIX path helpers for paths on any machine (the app's own platform doesn't
// matter: a space on a Linux box has Linux paths). Pure, unit-tested in Node.

/**
 * @param {...string} parts
 * @returns {string}
 */
export function join(...parts) {
  const joined = parts.filter((p) => p !== "").join("/");
  return normalize(joined);
}

/**
 * Collapses "//", "/./" and "x/../"; keeps a leading "/".
 * @param {string} path
 */
export function normalize(path) {
  const absolute = path.startsWith("/");
  /** @type {string[]} */
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (seg === ".." && absolute) continue;
    else out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/") || (absolute ? "/" : ".");
}

/** @param {string} path */
export function basename(path) {
  const n = normalize(path);
  return n === "/" ? "/" : n.slice(n.lastIndexOf("/") + 1);
}

/** @param {string} path */
export function dirname(path) {
  const n = normalize(path);
  const i = n.lastIndexOf("/");
  return i < 0 ? "." : i === 0 ? "/" : n.slice(0, i);
}

/**
 * The part of `path` below `root`, or null when it isn't inside.
 * @param {string} root
 * @param {string} path
 * @returns {string | null}
 */
export function relative(root, path) {
  const r = normalize(root), p = normalize(path);
  if (p === r) return "";
  const prefix = r === "/" ? "/" : r + "/";
  return p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

/**
 * The file's extension without the dot, lower case ("" for none or dotfiles).
 * @param {string} path
 */
export function extension(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
