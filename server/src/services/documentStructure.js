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
//   { type: "heading", level: 1..9, text }   (1 = most important)
//   { type: "para", text }
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
  return countWords(s.body.join("\n\n"));
}

/**
 * Pick the heading level to split at: the finest level that yields between 2
 * and MAX_SECTIONS sections averaging at least MIN_AVG_SECTION_WORDS words,
 * otherwise the coarsest level that yields at least 2. Null if no level does.
 */
function chooseSplitLevel(blocks, totalWords) {
  const levels = [...new Set(blocks.filter((b) => b.type === "heading").map((b) => b.level))].sort((a, b) => a - b);
  const counts = levels.map((level) => ({
    level,
    count: blocks.filter((b) => b.type === "heading" && b.level <= level).length,
    // headings exactly at this level are the would-be subtopics; the coarser
    // ones above them become groups and only survive if they have intro text
    leaves: blocks.filter((b) => b.type === "heading" && b.level === level).length,
  }));
  const usable = counts.filter((c) => c.count >= 2);
  if (usable.length === 0) return null;
  const good = usable.filter(
    (c) => c.leaves >= 2 && c.leaves <= MAX_SECTIONS && totalWords / c.leaves >= MIN_AVG_SECTION_WORDS
  );
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
      collapsed.push({ title: s.title, group: s.group || null, groupIntro: Boolean(s.groupIntro), body: [...s.body] });
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
      merged[merged.length - 1].body.push(s.title, ...s.body);
    }
  }
  if (merged.length > 1 && sectionWords(merged[0]) < MIN_SECTION_WORDS) {
    const first = merged.shift();
    merged[0].body.unshift(first.title, ...first.body);
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
    if (into === left) {
      into.body.push(small.title, ...small.body);
    } else {
      into.body.unshift(small.title, ...small.body);
    }
    into.title = keep.title;
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
      const text = s.body.map((p) => p.trim()).filter(Boolean).join("\n\n");
      return { title, group: s.group ? cleanHeading(s.group) : null, text };
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

  const totalWords = countWords(working.map((b) => b.text).join(" "));
  const level = chooseSplitLevel(working, totalWords);
  if (level === null) return { docTitle, sections: [] };

  const raw = [];
  let current = null;
  let group = null; // the most recent heading above the split level
  const intro = [];
  for (const b of working) {
    if (b.type === "heading" && b.level < level) {
      group = b.text;
      current = { title: b.text, group: null, groupIntro: true, body: [] };
      raw.push(current);
    } else if (b.type === "heading" && b.level === level) {
      current = { title: b.text, group, body: [] };
      raw.push(current);
    } else if (current) {
      current.body.push(b.text); // sub-headings stay inside their section's text
    } else {
      intro.push(b.text);
    }
  }
  if (intro.length) {
    if (countWords(intro.join(" ")) >= MIN_SECTION_WORDS * 2) raw.unshift({ title: "Introduction", body: intro });
    // a stray line or two (a "Contents" label, an author line) stays only in
    // the parent note; a real paragraph is kept with the first subtopic
    else if (raw[0] && countWords(intro.join(" ")) >= 8) raw[0].body.unshift(...intro);
  }

  return { docTitle, sections: finalizeSections(raw) };
}

/**
 * No headings: chunk long text at paragraph boundaries and name each chunk
 * after its most distinctive keywords (TF-IDF against the other chunks, so the
 * names differ from each other).
 */
function splitIntoParts(blocks) {
  const paras = blocks.map((b) => b.text.trim()).filter(Boolean);
  const total = countWords(paras.join(" "));
  if (total < FALLBACK_MIN_DOC_WORDS) return [];

  const chunks = [];
  let cur = [];
  let words = 0;
  for (const p of paras) {
    cur.push(p);
    words += countWords(p);
    if (words >= FALLBACK_CHUNK_WORDS) {
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

  const texts = chunks.map((c) => c.join("\n\n"));
  return texts.map((text, i) => {
    const others = texts.filter((_, j) => j !== i);
    const { keywords } = computeTfidf(text, others);
    const label = keywords.slice(0, 3).join(", ");
    return { title: `Part ${i + 1}${label ? ` — ${label}` : ""}`, text };
  });
}

/**
 * Main entry point. Returns
 *   { docTitle, sections: [{ title, text }], method }
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

export function blocksFromPlainText(text) {
  const blocks = [];
  const paras = String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const para of paras) {
    const lines = para.split("\n");
    let buf = [];
    const flush = () => {
      if (buf.length) blocks.push({ type: "para", text: buf.join(" ").trim() });
      buf = [];
    };
    for (const line of lines) {
      const md = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (md) {
        flush();
        blocks.push({ type: "heading", level: md[1].length, text: md[2] });
      } else if (lines.length <= 2 && looksLikeHeadingLine(line)) {
        flush();
        blocks.push({ type: "heading", level: 2 + numberedDepth(line), text: line.trim() });
      } else if (/^\s*([-=])\1{2,}\s*$/.test(line) && buf.length === 1) {
        // setext-style heading: "Title\n=====" / "Title\n-----"
        const title = buf.pop();
        blocks.push({ type: "heading", level: line.trim()[0] === "=" ? 1 : 2, text: title });
      } else {
        buf.push(line.trim());
      }
    }
    flush();
  }
  return blocks.filter((b) => b.text);
}
