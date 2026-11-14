// POSIX shell helpers. Pure: no Herdr imports, unit-tested in Node.

/**
 * Quotes one value for a POSIX shell: wrapped in single quotes, each embedded
 * single quote closed, escaped and reopened.
 * @param {string | number} value
 * @returns {string}
 */
export function quote(value) {
  const s = String(value);
  if (s !== "" && /^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Splits a NUL-separated stream (git -z, find -print0) into its fields, without
 * the empty string after the final NUL.
 * @param {string} text
 * @returns {string[]}
 */
export function splitNul(text) {
  if (!text) return [];
  const parts = text.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** The record separator our multi-part scripts print between sections. */
export const SECTION = "\x1e";

/**
 * Splits a script's output into the sections it separated with a line holding
 * only the record separator (printf '\036\n').
 * @param {string} text
 * @returns {string[]}
 */
export function splitSections(text) {
  return text.split(`\n${SECTION}\n`);
}
