// A note as the client reads and edits it.
//
// Two small things live here because more than one route needs them:
//   - withContent: every note leaves the API with formatted `content` and a
//     `path`, including notes saved before those fields existed;
//   - contentToEditText: a note's content written back out as text a student
//     can edit - the same light markdown the typed-note box accepts, so an
//     edited note goes through exactly the path a new typed note does.

import { blocksFromPlainText, normalizeContent, restoredTable, splitInlineBullets } from "./documentStructure.js";
import { keyTermDetailsFor } from "./keyTerms.js";
import { withSyllabus } from "./keyTermSignals.js";
import { isSplitParent } from "../models/Note.js";

/**
 * A note with `content` and `path` always present. Notes saved before those
 * fields existed get them worked out here from what they do have, so old notes
 * are formatted the same way as new ones.
 */
export function withContent(note) {
  if (!note) return note;
  const content =
    Array.isArray(note.content) && note.content.length
      ? // saved before entries run together on one line were split apart
        // ("• Fast • Cheap"), and before lists stopped at three levels
        // ...and before flattened comparison tables were put back into rows
        note.content.flatMap(splitInlineBullets).map((b) => (b.type === "item" && b.depth > 2 ? { ...b, depth: 2 } : b.type === "para" ? restoredTable(b.text) || b : b))
      : normalizeContent(blocksFromPlainText(note.rawText, { ocr: note.sourceType === "image" }), { title: note.title });
  const path = Array.isArray(note.path) && note.path.length ? note.path : note.sectionGroup ? [note.sectionGroup] : [];
  return { ...note, content, path };
}

/**
 * A note as the API sends it: with content and path, without what only the
 * server uses - the TF-IDF vector (large, and of no use to a client) and the
 * owner's id (always the caller's own).
 */
export function publicNote(note) {
  if (!note) return note;
  // (the concept records are served on their own: GET /api/notes/:id/concepts)
  // (`syllabus` is the subject's, attached for key terms; `aiTerms` is shown as keyTermDetails)
  // eslint-disable-next-line no-unused-vars
  const { vector, ownerId, concepts, syllabus, aiTerms, ...rest } = withContent(note);
  return rest;
}

/**
 * Notes with `keyTerms`: the whole terms ("bus topology", "data link layer")
 * the reading pane highlights and lists under a note's title, and downloads
 * mark the same way. `subjectNotes` are all the notes of the subject, so a
 * word every note uses ranks lower. (`keywords` stay the single TF-IDF words
 * the knowledge graph links notes by.)
 */
//
// Also `keyTermDetails` ([{ term, sources: ["you" | "ai" | "syllabus" |
// "notes"] }]: where each shown term came from) and `keyTermMarks` ({ add,
// remove }: the terms the student added or took away). `subject`, when given,
// brings its syllabus into the ranking (services/keyTermSignals.js).
export function withKeyTerms(notes, subjectNotes = notes, { subject = null } = {}) {
  const corpus = withSyllabus((subjectNotes || []).filter((n) => !isSplitParent(n)), subject);
  return notes.map((n) => {
    if (!n) return n;
    const details = keyTermDetailsFor(withSyllabus([n], subject)[0], corpus);
    const marks = n.termMarks || {};
    return {
      ...n,
      keyTerms: details.map((t) => t.term),
      keyTermDetails: details,
      keyTermMarks: { add: Array.isArray(marks.add) ? marks.add : [], remove: Array.isArray(marks.remove) ? marks.remove : [] },
    };
  });
}

/** Any other record as the API sends it: without the owner's id. */
export function publicDoc(doc) {
  if (!doc) return doc;
  // eslint-disable-next-line no-unused-vars
  const { ownerId, ...rest } = doc;
  return rest;
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Put the author's bold back: the first use of each term, longest term first
// so "exclusive lock" is not split by "lock".
function withBold(text, strong = []) {
  let out = String(text);
  // capped: each term is a pass over the text (content written before the cap in normalizeContent)
  for (const term of [...strong].slice(0, 40).sort((a, b) => b.length - a.length)) {
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
    else if (b.type === "label") chunks.push([b.text.endsWith(':') ? b.text : `${b.text}:`]);
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
