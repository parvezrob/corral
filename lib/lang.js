// Which editor grammar a file gets. Herdr's editor highlights these ids (checked
// against version 0.1.15): js, rust, python, go, json, yaml, bash, c, cpp, java,
// ruby, sql. TypeScript has no grammar of its own; the JavaScript one reads most
// of it. Pure, unit-tested in Node.
import { basename, extension } from "./paths.js";

/** @type {Record<string, string>} */
const BY_EXTENSION = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js", svelte: "js", vue: "js",
  rs: "rust",
  py: "python", pyi: "python",
  go: "go",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml", toml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ksh: "bash",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  java: "java", kt: "java", kts: "java",
  rb: "ruby", rake: "ruby",
  sql: "sql",
};

/** @type {Record<string, string>} */
const BY_NAME = {
  dockerfile: "bash", makefile: "bash", justfile: "bash", ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".env": "bash",
  gemfile: "ruby", rakefile: "ruby",
};

/** Fence names people write, mapped to grammar ids. */
/** @type {Record<string, string>} */
const FENCE = { javascript: "js", typescript: "js", ts: "js", tsx: "js", jsx: "js", node: "js", rs: "rust", py: "python", shell: "bash", sh: "bash", zsh: "bash", console: "bash", yml: "yaml", toml: "yaml", golang: "go", "c++": "cpp", rb: "ruby", jsonc: "json" };

/**
 * @param {string} path
 * @returns {string} a grammar id, or "text" for none
 */
export function languageFor(path) {
  const name = basename(path).toLowerCase();
  return BY_NAME[name] ?? BY_EXTENSION[extension(path)] ?? "text";
}

/**
 * @param {string} fence  the word after ``` in markdown
 * @returns {string}
 */
export function languageForFence(fence) {
  const f = fence.toLowerCase();
  return FENCE[f] ?? (Object.values(BY_EXTENSION).includes(f) ? f : BY_EXTENSION[f] ?? "text");
}

/** @param {string} path */
export function isMarkdown(path) {
  return ["md", "markdown", "mdx", "mdown"].includes(extension(path));
}

/**
 * Editor colors for each syntax role, from theme colors.
 * @param {Record<string, string>} t
 */
export function syntaxColors(t) {
  return { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi1, operator: t.muted };
}
