// How question text is read for display: the small, safe subset of markup a
// question, an option or an answer may carry, whichever writer produced it.
//   ```code```          a block of code or pseudocode, shown as written
//   `code`              code inside a sentence
//   **bold**            emphasis (the AI is asked not to use it, but notes do)
//   $x^2$, $$...$$      formulas: left in the text for MathText (KaTeX)
//   line breaks         kept: steps, a matrix, two lines of code
// Nothing here produces HTML: the pieces are rendered as React text, so a
// question can never inject markup. Unknown syntax is shown as written.

/** Text -> blocks: [{ type: "code", text }] and [{ type: "lines", lines: [[segment]] }]. */
export function parseRichText(input) {
  const text = String(input ?? "").replace(/\r\n?/g, "\n");
  const blocks = [];
  const fence = /```[ \t]*([A-Za-z0-9+#-]*)[ \t]*\n?([\s\S]*?)```/g;
  let last = 0;
  for (const m of text.matchAll(fence)) {
    if (m.index > last) pushLines(blocks, text.slice(last, m.index));
    blocks.push({ type: "code", lang: m[1] || null, text: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) pushLines(blocks, text.slice(last));
  return blocks;
}

function pushLines(blocks, chunk) {
  const lines = chunk.split("\n");
  // trim blank lines at the edges of a chunk, keep the ones inside
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length) blocks.push({ type: "lines", lines: lines.map(parseInline) });
}

/**
 * One line -> segments: { type: "text" | "code" | "bold", text }. A formula's
 * "$...$" stays inside a text segment, whole: `code` and ** are not looked for
 * inside a formula, so "$a**b$" or "$`x`$" are not taken apart.
 */
export function parseInline(line) {
  const out = [];
  const push = (type, t) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.type === type && type === "text") prev.text += t;
    else out.push({ type, text: t });
  };
  const s = String(line ?? "");
  let i = 0;
  let buf = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "$") {
      // a formula: copy through to its closing $ (or $$), untouched
      const dbl = s.startsWith("$$", i);
      const end = s.indexOf(dbl ? "$$" : "$", i + (dbl ? 2 : 1));
      if (end > i) {
        buf += s.slice(i, end + (dbl ? 2 : 1));
        i = end + (dbl ? 2 : 1);
        continue;
      }
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        push("text", buf);
        buf = "";
        push("code", s.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) {
        push("text", buf);
        buf = "";
        push("bold", s.slice(i + 2, end));
        i = end + 2;
        continue;
      }
    }
    buf += c;
    i++;
  }
  push("text", buf);
  return out;
}
