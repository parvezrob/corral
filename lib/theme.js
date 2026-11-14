// Theme colors, typed for the element API. Herdr's theme() returns plain
// strings; every value is a "#rrggbb[aa]" hex, which is what elements take.
import { theme } from "herdr";

/** @typedef {import("gpui-kit").Color} Color */

/** A fully transparent color (an invisible border that keeps its width). */
export const CLEAR = /** @type {Color} */ ("#00000000");

/**
 * Every theme color by name: background, surface, canvas, chrome, popover,
 * raised, hover, selected, border, input, foreground, muted, dim, accent,
 * accent_foreground, solid, solid_foreground, selection, working, blocked,
 * done, idle, unknown, ansi0..ansi15.
 * @returns {Record<string, Color>}
 */
export function colors() {
  return /** @type {Record<string, Color>} */ (theme());
}

/**
 * A theme color with an alpha, e.g. a tinted row background.
 * @param {Color} color  "#rrggbb"
 * @param {number} alpha 0..1
 * @returns {Color}
 */
export function alpha(color, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
  return /** @type {Color} */ (`${color.slice(0, 7)}${a}`);
}
