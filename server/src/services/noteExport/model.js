// Notes -> one description of the file to write, which the Word writer
// (docx.js) and the PDF writer (pdf.js) both follow. Everything that decides
// what the download says and how it is coloured happens here, once, so the two
// formats cannot disagree with each other or with the screen.
//
// Three things can be downloaded:
//   - a note (typed, or one subtopic of a document): its title, then its text;
//   - a document that was split into subtopics: every subtopic in the order
//     and under the headings of the original, each main topic in its colour;
//   - a subject: every note and document in it, each starting a new page.
//
// The model:
//   { kind, title, titleColor, kicker, meta, fileName,
//     lead:     { terms, color } | null               a single note's key terms
//     index:    [{ id, text, level, color, strong }]  the contents list
//     elements: [ heading | keywords | para | label | list | table ] }
//
//   heading  { size 1-4, text, color, id?, outline, pageBreak?, rule? }
//            size 1 is the largest; `id` is set for headings the index links
//            to; `outline` is its depth in the file's bookmarks
//   keywords { terms, color }             a topic's key terms, under its title
//   para     { segments, color }          segments: [{ text, mark }]
//   label    { text, color }              a bold line over a list
//   list     { items, color }             items: [{ segments, ordered, marker, children }]
//   table    { rows, color }              rows[0] is the head when there are several

import { withContent } from "../noteView.js";
import { INK, PRIMARY, colorSections, flattenOutline, layoutContent, outlineTree, stableColorIndex, topicHex } from "./format.js";

const KEYWORDS_SHOWN = 8; // as in the reading pane
const MAX_HEADING = 4;
const idOf = (n) => String(n._id);
const isSplitParent = (n) => !n.parentNoteId && (n.childCount || 0) > 0;
const wordCount = (text) => String(text || "").split(/\s+/).filter(Boolean).length;
const plural = (n, word) => `${n.toLocaleString("en-GB")} ${word}${n === 1 ? "" : "s"}`;

/** A title as a file name: no characters Windows, macOS or Linux refuse. */
export function safeFileName(title) {
  const name = String(title || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 80)
    .trim();
  return name || "notes";
}

/** Today's date as a student would write it, in their time zone when given. */
export function dateLabel(now = new Date(), timeZone = "UTC") {
  const format = (tz) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(now);
  try {
    return format(timeZone || "UTC");
  } catch {
    return format("UTC"); // not a time zone this server knows
  }
}

// One builder per download: collects elements and index entries and hands
// out ids for the headings the index links to.
function builder() {
  const elements = [];
  const index = [];
  let ids = 0;
  return {
    elements,
    index,
    /** A heading that appears in the index (and the file's bookmarks). */
    topic({ text, size, color, level, strong = level === 0, pageBreak = false }) {
      const id = `topic${++ids}`;
      elements.push({ kind: "heading", size, text, color, id, outline: level, pageBreak, rule: size === 1 });
      // `strong`: a main topic, shown in its colour in the contents list
      index.push({ id, text, level, color, strong });
      return id;
    },
    push: (element) => elements.push(element),
  };
}

/**
 * One note's own text as elements.
 *   depth        how deep the note's title sits: -1 when the title is the
 *                file's title, 0 for a main topic, 1 below that ...
 *   colorIndex   the note's topic colour
 *   bySection    colour each top-level heading inside the note separately
 *   indexHeadings  list the note's own headings in the index (single notes)
 */
function addNoteBody(out, note, { depth, colorIndex, bySection = false, indexHeadings = false }) {
  const full = withContent(note);
  const blocks = layoutContent(full.content, (note.keywords || []).slice(0, KEYWORDS_SHOWN));
  const sections = colorSections(blocks, { baseIndex: colorIndex ?? 0, bySection });
  for (const section of sections) {
    const color = topicHex(section.colorIndex);
    for (const b of section.blocks) {
      if (b.type === "heading") {
        const size = Math.min(depth + 1 + Math.max(b.level || 1, 1), MAX_HEADING);
        if (indexHeadings && b.level <= 2) out.topic({ text: b.text, size, color, level: b.level - 1 });
        else out.push({ kind: "heading", size, text: b.text, color, outline: null, rule: size === 1 });
      } else if (b.type === "para") out.push({ kind: "para", segments: b.segments, color });
      else if (b.type === "label") out.push({ kind: "label", text: b.text, color });
      else if (b.type === "list") out.push({ kind: "list", items: b.items, color });
      else if (b.type === "table" && Array.isArray(b.rows) && b.rows.length) out.push({ kind: "table", rows: b.rows, color });
    }
  }
}

const topLevelHeadings = (note) => (withContent(note).content || []).filter((b) => b.type === "heading" && b.level === 1).length;

const addKeywords = (out, note, color) => {
  const terms = (note.keywords || []).slice(0, KEYWORDS_SHOWN);
  if (terms.length) out.push({ kind: "keywords", terms, color });
};

/**
 * A split document's subtopics, under the headings of the original.
 * `offset` moves the whole outline down (1 inside a subject, where the
 * document's own title is the top level).
 */
function addDocumentBody(out, children, { offset = 0 } = {}) {
  for (const node of flattenOutline(outlineTree(children))) {
    const depth = node.depth + offset;
    const color = topicHex(node.colorIndex);
    out.topic({ text: node.title, size: Math.min(depth + 1, 3), color, level: Math.min(depth, 2), strong: node.depth === 0 });
    if (!node.item) continue; // a heading that only groups the topics under it
    addKeywords(out, node.item, color);
    addNoteBody(out, node.item, { depth, colorIndex: node.colorIndex });
  }
}

// Text from a PDF or a photo can carry characters a Word file may not contain
// at all (control characters make Word refuse to open it) and line breaks in
// the middle of a paragraph. Every string in the model goes through here.
export function cleanText(text) {
  return (
    String(text ?? "")
      .replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, "")
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "") // half of a surrogate pair
      .replace(/\t/g, " ")
  );
}

const cleanDeep = (value) => {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(cleanDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v)]));
  return value;
};

const finish = (out, model) => {
  const cleaned = cleanDeep({
    ...model,
    // a contents list of one line is not worth a page
    index: out.index.length >= 2 ? out.index : [],
    elements: out.elements,
  });
  return { ...cleaned, fileName: safeFileName(cleaned.title) };
};

/** A typed note or a single subtopic. `parent` and `siblings` for a subtopic. */
export function noteModel({ note, subject = null, parent = null, siblings = [], date = "" }) {
  const out = builder();
  let colorIndex = stableColorIndex(note._id);
  let trail = [];
  if (parent) {
    // a subtopic wears its main topic's colour, as it does on screen
    const node = flattenOutline(outlineTree(siblings.length ? siblings : [note])).find((n) => n.item && idOf(n.item) === idOf(note));
    if (node) {
      colorIndex = node.colorIndex;
      trail = node.trail;
    }
  }
  const bySection = !parent;
  const manySections = bySection && topLevelHeadings(note) >= 2;
  const color = topicHex(colorIndex);
  addNoteBody(out, note, { depth: -1, colorIndex, bySection, indexHeadings: true });
  const terms = (note.keywords || []).slice(0, KEYWORDS_SHOWN);
  return finish(out, {
    kind: "note",
    // the note's key terms sit under its title, above the contents list
    lead: terms.length ? { terms, color: manySections ? PRIMARY : color } : null,
    title: note.title,
    // several topics in one note: the title belongs to none of them
    titleColor: manySections ? INK : color,
    kicker: [subject?.name, parent?.title, ...trail].filter(Boolean).join("  ›  "),
    meta: [plural(wordCount(note.rawText), "word"), date].filter(Boolean).join("  ·  "),
  });
}

/** A document that was split into subtopics, whole. */
export function documentModel({ parent, children, subject = null, date = "" }) {
  const out = builder();
  addDocumentBody(out, children);
  const words = children.reduce((n, c) => n + wordCount(c.rawText), 0);
  return finish(out, {
    kind: "document",
    title: parent.title,
    titleColor: INK,
    kicker: subject?.name || "",
    meta: [plural(children.length, "topic"), plural(words, "word"), date].filter(Boolean).join("  ·  "),
  });
}

/** Every note and document of a subject, oldest first, each on a new page. */
export function subjectModel({ subject, notes, date = "" }) {
  const out = builder();
  const childrenOf = new Map();
  for (const n of notes) {
    if (!n.parentNoteId) continue;
    const key = String(n.parentNoteId);
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n);
  }
  for (const kids of childrenOf.values()) kids.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const ids = new Set(notes.map(idOf));
  // a subtopic whose document is missing is kept as a note of its own
  const top = notes.filter((n) => !n.parentNoteId || !ids.has(String(n.parentNoteId))).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  let words = 0;
  top.forEach((n, i) => {
    const children = childrenOf.get(idOf(n)) || [];
    if (isSplitParent(n) && children.length) {
      out.topic({ text: n.title, size: 1, color: PRIMARY, level: 0, pageBreak: i > 0 });
      addDocumentBody(out, children, { offset: 1 });
      words += children.reduce((sum, c) => sum + wordCount(c.rawText), 0);
    } else {
      const colorIndex = stableColorIndex(n._id);
      // a note holding several topics is coloured topic by topic, and its
      // title belongs to none of them - as on screen
      const color = topLevelHeadings(n) >= 2 ? PRIMARY : topicHex(colorIndex);
      out.topic({ text: n.title, size: 1, color, level: 0, pageBreak: i > 0 });
      addKeywords(out, n, color);
      addNoteBody(out, n, { depth: 0, colorIndex, bySection: true });
      words += wordCount(n.rawText);
    }
  });
  return finish(out, {
    kind: "subject",
    title: subject.name,
    titleColor: INK,
    kicker: "All notes",
    meta: [plural(top.length, "note"), plural(words, "word"), date].filter(Boolean).join("  ·  "),
  });
}
