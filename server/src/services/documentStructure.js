// Turns one long uploaded document into a parent note plus one child note per
// subtopic.
//
// Why this exists: a 20-page PDF used to become a single note, so every
// question generated from it carried the same topic, and the feedback could
// only ever say "Unit 3 needs attention" - never *which part* of Unit 3. With
// the document split along its own headings, each child note is a topic in its
// own right (questions, mastery and feedback are all keyed on note ids), so the
// same downstream code becomes subtopic-specific without changing its logic.
//
// Input is a flat list of blocks produced by the extractors in
// documentText.js:
//   { type: "title", text }                    the document's own title
//   { type: "heading", level: 1..9, text }     (1 = most important)
//   { type: "label", text }                    a run-in label ("Advantages:")
//   { type: "para", text, strong? }
//   { type: "item", text, depth, ordered, marker?, strong? }   a list entry
//   { type: "table", text, rows }
// `strong` lists the terms the author set in bold. Only headings decide where
// a document is split; everything else is body. The body blocks are kept on
// each note as its `content`, so the reading pane can show the same structure
// the author wrote - headings, bullets, numbering - instead of flat text.
// Everything here is deterministic and rule-based - no ML, no LLM - so the same
// file always splits the same way and the split can be explained in a demo.

import { computeTfidf } from "./tfidf.js";

// A section shorter than this is merged into its neighbour rather than kept as
// its own subtopic: too little text to generate a grounded question from.
export const MIN_SECTION_WORDS = 25;
// A document shorter than this is never split - it is already one topic.
export const MIN_DOC_WORDS_TO_SPLIT = 150;
// Upper bound on subtopics per document, so a 90-slide deck does not become 90
// notes. Beyond it, the smallest sections are merged into neighbours.
export const MAX_SECTIONS = 30;
// When choosing which heading level to split at, prefer the FINEST level whose
// sections still average at least this many words: finer headings mean more
// specific topics (and more specific feedback), but a level whose sections
// average only a sentence or two is too thin to generate grounded questions
// from. The coarser heading each section sits under is kept as its `group`.
const MIN_AVG_SECTION_WORDS = 60;
// No headings at all: long text is still chunked, at paragraph boundaries,
// into parts of roughly this size, each titled by its own top keywords.
const FALLBACK_CHUNK_WORDS = 450;
const FALLBACK_MIN_DOC_WORDS = 900;

// Sections whose heading marks them as navigation / back-matter rather than a
// subtopic. Their text stays in the parent note; they just are not topics.
const NON_TOPIC_TITLES =
  /^(table of contents|contents|index|outline|agenda|overview of (this )?(lecture|session|unit)|references|bibliography|acknowledg(e)?ments?|thank you!?|thanks!?|questions\??|any questions\??|q\s*&\s*a)$/i;

export function countWords(text) {
  return (String(text || "").match(/\S+/g) || []).length;
}

function cleanHeading(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[\s:–—-]+$/, "")
    .trim();
}

// "Deadlocks (cont.)", "Paging - continued", "Scheduling II" -> same key, so
// consecutive slides/pages that continue one heading collapse into one topic.
function continuationKey(title) {
  return cleanHeading(title)
    .toLowerCase()
    .replace(/\((cont(inued|d)?\.?|contd\.?)\)$/i, "")
    .replace(/[-–—:,]?\s*(cont(inued|d)?\.?)$/i, "")
    .replace(/\s+(\(?\d+\)?|i{1,3}|iv|v)$/i, "")
    .trim();
}

function sectionWords(s) {
  return countWords(s.body.map((b) => b.text).join(" "));
}

// A section folded into its neighbour keeps its title as a sub-heading there.
const headingBlock = (s) => ({ type: "heading", level: s.level, text: s.title });

/**
 * Blocks -> the plain text a note stores as `rawText`. Blocks are separated by
 * a blank line; a block marked `tight` (lines of one slide) follows the
 * previous one on the next line instead.
 */
export function blocksToText(blocks) {
  let out = "";
  for (const b of blocks || []) {
    const t = String(b?.text || "").trim();
    if (!t) continue;
    out += out ? (b.tight ? "\n" : "\n\n") + t : t;
  }
  return out;
}

// Headings deeper than this inside one note all render the same size.
const MAX_CONTENT_LEVELS = 4;
const MAX_LIST_DEPTH = 3;

/**
 * Body blocks -> the `content` a note stores for display.
 * Heading levels come from the source ("Heading 3", a 13pt PDF line, "###")
 * and mean nothing on their own inside one note, so they are re-ranked: the
 * most important heading present becomes level 1, the next 2, and so on. List
 * depths are tidied the same way, so a list never starts indented and never
 * jumps two levels at once.
 */
export function normalizeContent(blocks, { title = null } = {}) {
  let list = (blocks || []).filter((b) => b && b.type !== "title" && String(b.text || "").trim());
  // a leading heading that only repeats the note's own title is dropped
  const same = (a, b) => cleanHeading(a).toLowerCase() === cleanHeading(b).toLowerCase();
  if (title) {
    const at = list.slice(0, 3).findIndex((b) => b.type === "heading" && same(b.text, title));
    if (at >= 0) list = list.filter((_, i) => i !== at);
  }

  const levels = [...new Set(list.filter((b) => b.type === "heading").map((b) => b.level))].sort((a, b) => a - b);
  const rank = new Map(levels.map((l, i) => [l, Math.min(i + 1, MAX_CONTENT_LEVELS)]));

  const out = [];
  let prevDepth = -1; // depth of the previous item in the current run, -1 = no run
  let base = 0;
  for (const b of list) {
    const text = String(b.text).trim();
    const strong = (b.strong || []).filter((t) => t && text.includes(t));
    if (b.type === "item") {
      const raw = Math.max(0, b.depth || 0);
      if (prevDepth < 0) base = raw;
      const depth = Math.min(MAX_LIST_DEPTH, Math.max(0, raw - base), prevDepth + 1);
      prevDepth = depth;
      const item = { type: "item", text, depth, ordered: Boolean(b.ordered) };
      if (b.marker) item.marker = b.marker;
      if (strong.length) item.strong = strong;
      out.push(item);
      continue;
    }
    prevDepth = -1;
    if (b.type === "heading") out.push({ type: "heading", level: rank.get(b.level), text: cleanHeading(text) });
    else if (b.type === "label") out.push({ type: "label", text });
    else if (b.type === "table" && Array.isArray(b.rows)) out.push({ type: "table", text, rows: b.rows });
    else out.push(strong.length ? { type: "para", text, strong } : { type: "para", text });
  }
  return out;
}

/**
 * Pick the heading level to split at: the finest level that yields between 2
 * and MAX_SECTIONS sections averaging at least MIN_AVG_SECTION_WORDS words,
 * otherwise the coarsest level that yields at least 2. Null if no level does.
 *
 * The average is over the text that actually sits under headings of that
 * level. A document where only one chapter uses third-level headings ("Lock
 * modes", two bullets) is split at its second level, and those few third-level
 * headings stay inside their note as sub-headings instead of becoming
 * two-line notes of their own.
 */
function chooseSplitLevel(blocks) {
  const levels = [...new Set(blocks.filter((b) => b.type === "heading").map((b) => b.level))].sort((a, b) => a - b);
  const counts = levels.map((level) => {
    // headings exactly at this level are the would-be subtopics; the coarser
    // ones above them become groups and only survive if they have intro text
    const own = [];
    let cur = null;
    for (const b of blocks) {
      if (b.type === "heading" && b.level === level) {
        // "Paging" + "Paging (cont.)" will be collapsed into one subtopic
        const key = continuationKey(b.text);
        if (!cur || cur.key !== key) own.push((cur = { words: 0, key }));
      } else if (b.type === "heading" && b.level < level) cur = null;
      else if (cur) cur.words += countWords(b.text);
    }
    return {
      level,
      count: blocks.filter((b) => b.type === "heading" && b.level <= level).length,
      leaves: own.length,
      avgWords: own.length ? own.reduce((n, o) => n + o.words, 0) / own.length : 0,
    };
  });
  const usable = counts.filter((c) => c.count >= 2);
  if (usable.length === 0) return null;
  const good = usable.filter((c) => c.leaves >= 2 && c.leaves <= MAX_SECTIONS && c.avgWords >= MIN_AVG_SECTION_WORDS);
  return good.length ? good[good.length - 1].level : usable[0].level;
}

function finalizeSections(raw) {
  // 1. collapse consecutive continuations of the same heading
  const collapsed = [];
  for (const s of raw) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && continuationKey(prev.title) === continuationKey(s.title)) {
      prev.body.push(...s.body);
    } else {
      collapsed.push({
        title: s.title,
        group: s.group || null,
        path: s.path || [],
        level: s.level,
        groupIntro: Boolean(s.groupIntro),
        body: [...s.body],
      });
    }
  }

  // 2. navigation / back-matter sections are not topics
  const topical = collapsed.filter((s) => !NON_TOPIC_TITLES.test(cleanHeading(s.title)));

  // 3. merge sections too short to stand alone into the previous one (or the
  //    next one, for a short opening section). A short run of text sitting
  //    directly under a chapter heading (before its first sub-heading) is an
  //    introduction to what follows, so it goes forward, not backward.
  for (let i = 0; i < topical.length; i++) {
    const s = topical[i];
    if (!s.groupIntro || sectionWords(s) >= MIN_SECTION_WORDS) continue;
    const next = topical[i + 1];
    if (next && s.body.length) next.body.unshift(...s.body);
    s.body = [];
  }
  const merged = [];
  for (const s of topical.filter((x) => !(x.groupIntro && x.body.length === 0))) {
    if (sectionWords(s) >= MIN_SECTION_WORDS || merged.length === 0) {
      merged.push(s);
    } else {
      merged[merged.length - 1].body.push(headingBlock(s), ...s.body);
    }
  }
  if (merged.length > 1 && sectionWords(merged[0]) < MIN_SECTION_WORDS) {
    const first = merged.shift();
    merged[0].body.unshift(headingBlock(first), ...first.body);
  }

  // 4. cap the count: repeatedly fold the smallest section into its smaller
  //    neighbour, keeping the bigger section's title
  while (merged.length > MAX_SECTIONS) {
    let idx = 0;
    merged.forEach((s, i) => {
      if (sectionWords(s) < sectionWords(merged[idx])) idx = i;
    });
    const left = merged[idx - 1];
    const right = merged[idx + 1];
    const into = !left ? right : !right ? left : sectionWords(left) <= sectionWords(right) ? left : right;
    const small = merged[idx];
    const keep = sectionWords(into) >= sectionWords(small) ? into : small;
    // Both parts stay readable: the second always opens with its own title as
    // a sub-heading, and so does the first when it is not the one whose title
    // the merged section keeps.
    const [first, second] = into === left ? [into, small] : [small, into];
    const body = [...(first === keep ? [] : [headingBlock(first)]), ...first.body, headingBlock(second), ...second.body];
    Object.assign(into, { title: keep.title, group: keep.group, path: keep.path, level: keep.level, body });
    merged.splice(idx, 1);
  }

  // 5. unique titles, tidy text
  const seen = new Map();
  return merged
    .map((s) => {
      let title = cleanHeading(s.title) || "Untitled section";
      const key = title.toLowerCase();
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) title = `${title} (${n})`;
      return {
        title,
        group: s.group ? cleanHeading(s.group) : null,
        // every heading above this subtopic, outermost first: ["Unit 3", "Memory"]
        path: (s.path || []).map(cleanHeading).filter(Boolean),
        text: blocksToText(s.body),
        content: normalizeContent(s.body),
      };
    })
    .filter((s) => countWords(s.text) > 0);
}

/**
 * Split on headings. Returns { docTitle, sections } where sections is [] when
 * the document has no usable heading structure.
 */
function splitOnHeadings(blocks) {
  let working = blocks.filter((b) => b.text && b.text.trim());
  let docTitle = null;

  // A lone top-level heading at the very start, with every other heading
  // below it, is the document's title rather than a section of it.
  // Short lines before it (a course code, an author line) don't disqualify it.
  const explicit = working.find((b) => b.type === "title");
  if (explicit) docTitle = cleanHeading(explicit.text);
  working = working.filter((b) => b.type !== "title");
  const headings = working.filter((b) => b.type === "heading");
  const firstIdx = working.findIndex((b) => b.type === "heading");
  const lead = firstIdx > 0 ? working.slice(0, firstIdx) : [];
  if (!docTitle && headings.length >= 2 && firstIdx >= 0 && countWords(lead.map((b) => b.text).join(" ")) < 40) {
    const top = working[firstIdx].level;
    const sameLevel = headings.filter((h) => h.level <= top).length;
    if (sameLevel === 1) {
      docTitle = cleanHeading(working[firstIdx].text);
      working = working.filter((_, i) => i !== firstIdx);
    }
  }

  const level = chooseSplitLevel(working);
  if (level === null) return { docTitle, sections: [] };

  const raw = [];
  let current = null;
  // the headings above the split level that the current position sits under,
  // outermost first - a subtopic's place in the document's outline
  const above = [];
  const intro = [];
  for (const b of working) {
    if (b.type === "heading" && b.level < level) {
      while (above.length && above[above.length - 1].level >= b.level) above.pop();
      current = { title: b.text, group: null, path: above.map((a) => a.text), level: b.level, groupIntro: true, body: [] };
      above.push({ level: b.level, text: b.text });
      raw.push(current);
    } else if (b.type === "heading" && b.level === level) {
      current = {
        title: b.text,
        group: above.length ? above[above.length - 1].text : null,
        path: above.map((a) => a.text),
        level,
        body: [],
      };
      raw.push(current);
    } else if (current) {
      current.body.push(b); // sub-headings stay inside their section, as headings
    } else {
      intro.push(b);
    }
  }
  if (intro.length) {
    const introWords = countWords(intro.map((b) => b.text).join(" "));
    if (introWords >= MIN_SECTION_WORDS * 2) raw.unshift({ title: "Introduction", path: [], level, body: intro });
    // a stray line or two (a "Contents" label, an author line) stays only in
    // the parent note; a real paragraph is kept with the first subtopic
    else if (raw[0] && introWords >= 8) raw[0].body.unshift(...intro);
  }

  return { docTitle, sections: finalizeSections(raw) };
}

/**
 * No headings: chunk long text at paragraph boundaries and name each chunk
 * after its most distinctive keywords (TF-IDF against the other chunks, so the
 * names differ from each other).
 */
function splitIntoParts(blocks) {
  const body = blocks.filter((b) => b.text.trim());
  const total = countWords(body.map((b) => b.text).join(" "));
  if (total < FALLBACK_MIN_DOC_WORDS) return [];

  const chunks = [];
  let cur = [];
  let words = 0;
  for (const b of body) {
    cur.push(b);
    words += countWords(b.text);
    // never cut in the middle of a list
    if (words >= FALLBACK_CHUNK_WORDS && b.type !== "item") {
      chunks.push(cur);
      cur = [];
      words = 0;
    }
  }
  if (cur.length) {
    if (chunks.length && words < FALLBACK_CHUNK_WORDS / 3) chunks[chunks.length - 1].push(...cur);
    else chunks.push(cur);
  }
  if (chunks.length < 2) return [];

  const texts = chunks.map((c) => blocksToText(c));
  return texts.map((text, i) => {
    const others = texts.filter((_, j) => j !== i);
    const { keywords } = computeTfidf(text, others);
    const label = keywords.slice(0, 3).join(", ");
    return {
      title: `Part ${i + 1}${label ? ` — ${label}` : ""}`,
      group: null,
      path: [],
      text,
      content: normalizeContent(chunks[i]),
    };
  });
}

/**
 * Main entry point. Returns
 *   { docTitle, sections: [{ title, group, path, text, content }], method }
 * where `sections` has at least two entries when the document should be split,
 * and is empty when it should stay a single note. `method` says how the split
 * was found ("headings" | "chunks" | "none"), for the preview UI.
 */
export function segmentDocument(blocks) {
  const all = (blocks || []).filter((b) => b && typeof b.text === "string" && b.text.trim());
  const totalWords = countWords(all.map((b) => b.text).join(" "));
  if (totalWords < MIN_DOC_WORDS_TO_SPLIT) return { docTitle: null, sections: [], method: "none" };

  const byHeadings = splitOnHeadings(all);
  if (byHeadings.sections.length >= 2) {
    return { docTitle: byHeadings.docTitle, sections: byHeadings.sections, method: "headings" };
  }

  const parts = splitIntoParts(all);
  if (parts.length >= 2) return { docTitle: byHeadings.docTitle, sections: parts, method: "chunks" };

  return { docTitle: byHeadings.docTitle, sections: [], method: "none" };
}

// ---------------------------------------------------------------------------
// Plain text / Markdown -> blocks
// Used for .txt / .md uploads, typed notes and the text OCR reads from a photo.
// ---------------------------------------------------------------------------

const NUMBERED_HEADING = /^((chapter|unit|module|lecture|section|part|topic)\s+[\divxlc]+\b.*|\d+(\.\d+){1,3}\.?\s+\S.*)$/i;

/** A line that looks like a heading in otherwise unstructured text. */
export function looksLikeHeadingLine(line) {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  const words = countWords(t);
  if (words > 12) return false;
  if (/[.?!;,]$/.test(t) && !/^\d+(\.\d+)*\.?$/.test(t.split(/\s+/)[0])) return false;
  if (/\.{3,}|…/.test(t)) return false; // table-of-contents leader line
  if (!/[A-Za-z]{3,}/.test(t)) return false;
  return NUMBERED_HEADING.test(t);
}

function numberedDepth(t) {
  const m = t.trim().match(/^(\d+(?:\.\d+)*)/);
  if (m) return m[1].split(".").length;
  return 1; // "Chapter 3 ..." / "Unit 2 ..."
}

// Bullet glyphs as people type them and as Word, PowerPoint and PDF export
// them ("o" and "§" are what Word's bullet fonts turn into as plain text).
const BULLET_LINE = /^(\s*)(?:[-*+•◦▪▫‣⁃·●○■□➢➤►▶✓✔→–—]|[o§](?=\s{1,3}\S))\s+(\S.*)$/;
// "1." "2)" "(3)" "a)" "(b)" "iv)". A bare letter and a full stop ("A. Smith")
// is too often a name or an initial to count.
const ORDERED_LINE = /^(\s*)(\d{1,3}[.)]|\(\d{1,3}\)|\(?[a-zA-Z]\)|\(?[ivx]{2,4}\))\s+(\S.*)$/;

/** { indent, ordered, marker, text } if the line opens a list entry, else null. */
export function listLine(line) {
  const expanded = String(line).replace(/\t/g, "    ");
  let m = expanded.match(BULLET_LINE);
  if (m) return { indent: m[1].length, ordered: false, marker: null, text: m[2].trim() };
  m = expanded.match(ORDERED_LINE);
  if (m) return { indent: m[1].length, ordered: true, marker: m[2], text: m[3].trim() };
  return null;
}

/**
 * Strip markdown emphasis from one block of text and report what was bold:
 * "**Paging** splits memory" -> { text: "Paging splits memory", strong: ["Paging"] }.
 */
export function inlineMarkdown(text) {
  const strong = [];
  const out = String(text)
    .replace(/(\*\*|__)(?=\S)([^*_\n]+?)(?<=\S)\1/g, (_, __, inner) => {
      strong.push(inner.trim());
      return inner;
    })
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
  return { text: out, strong, allBold: strong.length === 1 && strong[0] === out.trim() };
}

const endsLikeSentence = (t) => /[.?!;,]$/.test(t);

// A short line of its own that reads as a title: "MEMORY MANAGEMENT" or
// "Types of Networks". Used only for text that has no explicit headings.
function looksLikeTitleLine(t) {
  if (t.length > 70 || endsLikeSentence(t) || /:$/.test(t) || /\.{3,}|…/.test(t)) return null;
  const words = t.split(/\s+/);
  if (words.length > 8 || !/[A-Za-z]{3,}/.test(t)) return null;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) return "caps";
  if (!/^[A-Z0-9]/.test(t)) return null;
  const big = words.filter((w) => w.replace(/[^A-Za-z]/g, "").length > 3);
  const capped = big.filter((w) => /^[("']?[A-Z]/.test(w));
  return big.length > 0 && capped.length / big.length >= 0.6 ? "title" : null;
}

/**
 * Text that has no explicit headings still has a shape. Second pass over the
 * blocks of a plain-text document:
 *   - "1. Introduction" on its own line, followed by prose, is a numbered
 *     heading and not a one-entry list (only if the document does it at least
 *     twice, so a real numbered list of one is left alone);
 *   - a bold line of its own is a heading;
 *   - if the text still has no headings, a short title-like line of its own
 *     followed by prose is one (followed by a list, it is that list's label).
 */
export function inferHeadings(blocks, { numberedLevel = 3, boldLevel = 7, capsLevel = 7, titleLevel = 8 } = {}) {
  const isBody = (b) => b && (b.type === "para" || b.type === "item" || b.type === "label");
  const numbered = blocks
    .map((b, i) => ({ b, i }))
    .filter(
      ({ b, i }) =>
        b.type === "item" &&
        b.ordered &&
        b.alone &&
        /^\d+[.)]$/.test(b.marker || "") &&
        countWords(b.text) <= 10 &&
        !endsLikeSentence(b.text) &&
        blocks[i + 1]?.type === "para"
    );
  if (numbered.length >= 2) {
    for (const { b } of numbered) {
      Object.assign(b, { type: "heading", level: numberedLevel, text: `${b.marker.replace(")", ".")} ${b.text}` });
      delete b.ordered;
      delete b.marker;
      delete b.depth;
    }
  }
  for (const b of blocks) {
    if (b.type === "para" && b.boldLine && countWords(b.text) <= 10 && !endsLikeSentence(b.text)) {
      Object.assign(b, { type: "heading", level: boldLevel });
      delete b.strong;
    }
  }
  if (!blocks.some((b) => b.type === "heading")) {
    blocks.forEach((b, i) => {
      if (b.type !== "para" || !b.alone) return;
      const kind = looksLikeTitleLine(b.text);
      const next = blocks[i + 1];
      if (!kind || !isBody(next)) return;
      // over prose it heads a section; directly over a list ("Steps") it only
      // names that list, which is a label and never a place to split
      if (next.type === "para" && countWords(next.text) >= 10) {
        Object.assign(b, { type: "heading", level: kind === "caps" ? capsLevel : titleLevel });
      } else if (next.type === "item") b.type = "label";
    });
  }
  blocks.forEach((b) => {
    delete b.alone;
    delete b.boldLine;
  });
  return blocks;
}

// What Tesseract makes of a bullet glyph at the start of a line.
const OCR_BULLET = /^(\s*)(?:[e¢©®°«»>]|[*+~])\s+(?=[A-Z0-9(])/;

/**
 * Plain text -> blocks. `ocr: true` is for text read from a photo, where
 * bullets arrive as look-alike characters ("e Star topology").
 */
// "| State | Next |" rows of a markdown table -> rows of cells (the "|---|"
// ruler under the header row is dropped). Null if the lines are not a table.
function markdownTable(lines) {
  if (lines.length < 2 || !lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) return null;
  const rows = lines
    .filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().slice(1, -1).split("|").map((c) => inlineMarkdown(c.trim()).text));
  return rows.length ? rows : null;
}

export function blocksFromPlainText(text, { ocr = false } = {}) {
  const blocks = [];
  let source = String(text || "").replace(/\r\n?/g, "\n");
  if (ocr) source = source.split("\n").map((l) => l.replace(OCR_BULLET, "$1• ")).join("\n");
  const paras = source.split(/\n\s*\n/);
  for (const para of paras) {
    const lines = para.split("\n").filter((l) => l.trim());
    const rows = markdownTable(lines);
    if (rows) {
      blocks.push({ type: "table", rows, text: rows.map((r) => r.join(" | ")).join("\n") });
      continue;
    }
    let buf = [];
    let item = null; // the list entry that following wrapped lines belong to
    const flush = () => {
      if (buf.length) {
        const joined = buf.join(" ").trim();
        const { text: t, strong, allBold } = inlineMarkdown(joined);
        // "Advantages:" directly above a list is a label for it, not prose
        if (buf.length === 1 && /:$/.test(t) && countWords(t) <= 5 && /^[A-Z0-9(]/.test(t)) {
          blocks.push({ type: "label", text: t });
        } else {
          const b = { type: "para", text: t };
          if (allBold) b.boldLine = true;
          else if (strong.length) b.strong = strong;
          if (lines.length === 1) b.alone = true;
          blocks.push(b);
        }
      }
      buf = [];
    };
    const closeItem = () => {
      if (!item) return;
      const { text: t, strong } = inlineMarkdown(item.text);
      item.text = t;
      if (strong.length) item.strong = strong;
      item = null;
    };
    for (const line of lines) {
      const md = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      const li = md ? null : listLine(line);
      if (md) {
        flush();
        closeItem();
        blocks.push({ type: "heading", level: md[1].length, text: inlineMarkdown(md[2]).text });
      } else if (lines.length <= 2 && looksLikeHeadingLine(line)) {
        flush();
        closeItem();
        blocks.push({ type: "heading", level: 2 + numberedDepth(line), text: line.trim() });
      } else if (/^\s*([-=])\1{2,}\s*$/.test(line) && buf.length === 1) {
        // setext-style heading: "Title\n=====" / "Title\n-----"
        const title = buf.pop();
        blocks.push({ type: "heading", level: line.trim()[0] === "=" ? 1 : 2, text: inlineMarkdown(title).text });
      } else if (/^\s*([-=*_])\1{2,}\s*$/.test(line)) {
        flush(); // a horizontal rule: a break, not text
        closeItem();
      } else if (li) {
        flush();
        closeItem();
        item = {
          type: "item",
          text: li.text,
          depth: Math.floor(li.indent / 2),
          ordered: li.ordered,
          ...(li.marker ? { marker: li.marker } : {}),
          ...(lines.length === 1 ? { alone: true } : {}),
        };
        blocks.push(item);
      } else if (item) {
        item.text += ` ${line.trim()}`; // a long entry wrapped onto the next line
      } else {
        buf.push(line.trim());
      }
    }
    flush();
    closeItem();
  }
  return inferHeadings(blocks.filter((b) => b.text));
}
