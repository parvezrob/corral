// Splits markdown into prose and fenced code, so the viewer can render prose
// with Herdr's markdown view and code with the editor (which highlights it).
// Pure, unit-tested in Node.

/**
 * @typedef {{ kind: "text", text: string } | { kind: "code", lang: string, code: string }} Block
 */

/**
 * @param {string} source
 * @returns {Block[]}
 */
export function splitMarkdown(source) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let prose = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const flush = () => {
    const text = prose.join("\n").replace(/^\n+|\n+$/g, "");
    if (text) blocks.push({ kind: "text", text });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/.exec(lines[i]);
    if (!open) { prose.push(lines[i]); continue; }
    flush();
    const [, indent, fence, lang] = open;
    /** @type {string[]} */
    const code = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).exec(lines[j]);
      if (close) break;
      code.push(indent ? lines[j].replace(new RegExp(`^ {0,${indent.length}}`), "") : lines[j]);
    }
    blocks.push({ kind: "code", lang: lang.toLowerCase(), code: code.join("\n") });
    i = j; // the closing fence (or the end, when the fence never closes)
  }
  flush();
  return blocks;
}
