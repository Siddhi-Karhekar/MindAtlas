// A note as the client reads and edits it.
//
// Two small things live here because more than one route needs them:
//   - withContent: every note leaves the API with formatted `content` and a
//     `path`, including notes saved before those fields existed;
//   - contentToEditText: a note's content written back out as text a student
//     can edit - the same light markdown the typed-note box accepts, so an
//     edited note goes through exactly the path a new typed note does.

import { blocksFromPlainText, normalizeContent } from "./documentStructure.js";

/**
 * A note with `content` and `path` always present. Notes saved before those
 * fields existed get them worked out here from what they do have, so old notes
 * are formatted the same way as new ones.
 */
export function withContent(note) {
  if (!note) return note;
  const content =
    Array.isArray(note.content) && note.content.length
      ? note.content
      : normalizeContent(blocksFromPlainText(note.rawText, { ocr: note.sourceType === "image" }), { title: note.title });
  const path = Array.isArray(note.path) && note.path.length ? note.path : note.sectionGroup ? [note.sectionGroup] : [];
  return { ...note, content, path };
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Put the author's bold back: the first use of each term, longest term first
// so "exclusive lock" is not split by "lock".
function withBold(text, strong = []) {
  let out = String(text);
  for (const term of [...strong].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\w*])${escapeRe(term)}(?![\\w*])`);
    out = out.replace(re, (m) => `**${m}**`);
  }
  return out;
}

/**
 * Display blocks -> editable text. Reading it back with blocksFromPlainText
 * gives the same structure: "#" headings by level, "-" bullets indented two
 * spaces per level, numbered entries with their own numbers, "Label:" lines,
 * tables as "| a | b |" rows, and **bold** key terms.
 */
export function contentToEditText(content) {
  const chunks = [];
  let list = null; // the lines of the list being written
  for (const b of content || []) {
    if (b.type === "item") {
      if (!list) chunks.push((list = []));
      const marker = b.ordered ? b.marker || "1." : "-";
      list.push(`${"  ".repeat(b.depth || 0)}${marker} ${withBold(b.text, b.strong)}`);
      continue;
    }
    list = null;
    if (b.type === "heading") chunks.push([`${"#".repeat(Math.min(Math.max(b.level || 1, 1), 6))} ${b.text}`]);
    else if (b.type === "label") chunks.push([/:$/.test(b.text) ? b.text : `${b.text}:`]);
    else if (b.type === "table" && Array.isArray(b.rows) && b.rows.length) {
      const row = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, "/")).join(" | ")} |`;
      const [head, ...body] = b.rows;
      chunks.push([row(head), `|${head.map(() => "---").join("|")}|`, ...body.map(row)]);
    } else chunks.push([withBold(b.text, b.strong)]);
  }
  return chunks.map((lines) => lines.join("\n")).join("\n\n");
}

/** The text to put in the editor for this note. */
export function editTextFor(note) {
  // a typed note is edited as it was typed; anything else from its structure
  if (note.sourceType === "typed") return String(note.rawText || "");
  return contentToEditText(withContent(note).content);
}
