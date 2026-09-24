// Reference textbooks: chunk a whole book into page-range passages, index each
// passage with TF-IDF, and link every note to the passages that cover the
// same material. A textbook is never turned into notes - at hundreds of pages
// it would swamp the knowledge graph and the test generator - it sits beside
// the notes as grounded reference material ("see Dhamdhere, Assemblers,
// pp. 105-107") that later work (summaries, question drafting) can pull
// context from.
//
// Everything here is rule-based and dependency-free, matching the rest of
// the prototype (CONTRIBUTING.md §0). Reuses tokenize/cosineSimilarity from
// tfidf.js but keeps its own document frequencies, computed over the book's
// chunks, so the knowledge graph's per-subject TF-IDF is left untouched.

import { tokenize, cosineSimilarity } from "./tfidf.js";
import { joinLines, tidy } from "./documentText.js";

const TARGET_CHUNK_CHARS = 2500;
const MAX_PAGES_PER_CHUNK = 4;
const VECTOR_TERMS = 200; // keep the strongest terms per chunk - bounds storage
const MIN_LINK_SCORE = 0.08;
const MAX_REFS_PER_NOTE = 3;

// Running page headers in printed books look like "Assemblers 105" (odd
// pages: chapter title, page number) or "106 Systems Programming" (even
// pages: page number, book title).
function parseRunningHeader(text) {
  let m = text.match(/^(\d{1,4})\s+([A-Za-z][^\d]{2,60})$/);
  if (!m) {
    m = text.match(/^([A-Za-z][^\d]{2,60}?)\s+(\d{1,4})$/);
    if (m) m = [m[0], m[2], m[1]];
  }
  if (!m || /^(chapter|part|preface|contents)\b/i.test(m[2].trim())) return null;
  return { page: Number(m[1]), title: m[2].trim() };
}

// A chapter's first page: "CHAPTER 4" followed by its title on one or two
// short lines ("Macros and" / "Macro Preprocessors").
function chapterOpening(lines) {
  const i = lines.slice(0, 2).findIndex((l) => /^chapter\s*\d+$/i.test(l.text.trim()));
  if (i < 0) return null;
  const title = [];
  for (const l of lines.slice(i + 1, i + 3)) {
    if (l.text.length > 40 || /[.,;:]$/.test(l.text) || /^\d/.test(l.text)) break; // body text or a numbered section
    title.push(l.text.trim());
  }
  return { skip: i + 1 + title.length, title: title.join(" ") || null };
}

// Contents / index pages list nearly every term in the book next to a page
// number; left in, they would "match" every note. Skip pages where most
// lines end in a page number.
function looksLikeContentsOrIndex(lines) {
  if (lines.length < 8) return false;
  const numbered = lines.filter((l) => /\d{1,4}\s*$/.test(l.text)).length;
  return numbered / lines.length > 0.5;
}

const SECTION_RE = /^(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)\s*([A-Z][^.]{2,70})$/;

/**
 * pages: [{ pageNumber, lines: [{ text, y }] }] (see extractPdfPages).
 * Returns { chunks: [{ chapter, pdfPages:[from,to], printedPages:[from,to]|null,
 * sections, text }], skippedPages }.
 */
export function chunkPages(pages) {
  // Pass 1: find running headers, and learn which header title is the book's
  // own name (it repeats on every other page) versus a chapter name.
  const headers = pages.map((p) => (p.lines[0] ? parseRunningHeader(p.lines[0].text) : null));
  const titleCounts = new Map();
  for (const h of headers) if (h) titleCounts.set(h.title, (titleCounts.get(h.title) || 0) + 1);
  const [bookTitle, bookTitleCount] = [...titleCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  const isBookTitle = (t) => bookTitleCount >= pages.length * 0.15 && t === bookTitle;

  // Printed page = PDF page + a fixed offset (front matter). Scanned headers
  // are often misread, so trust the offset most headers agree on over any
  // single header's number.
  const offsets = new Map();
  headers.forEach((h, i) => {
    if (h) offsets.set(h.page - pages[i].pageNumber, (offsets.get(h.page - pages[i].pageNumber) || 0) + 1);
  });
  const [offset, offsetVotes] = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0] || [0, 0];
  const agreed = offsetVotes >= Math.max(3, pages.length * 0.1);
  const printedPageOf = (p, h) => {
    if (agreed) return p.pageNumber + offset >= 1 ? p.pageNumber + offset : null;
    return h?.page ?? null;
  };

  const prepared = [];
  let chapter = null;
  let skippedPages = 0;
  pages.forEach((p, i) => {
    const h = headers[i];
    const opening = chapterOpening(p.lines);
    let lines = p.lines;
    if (opening) {
      if (opening.title) chapter = opening.title;
      lines = lines.slice(opening.skip);
    } else if (h) {
      if (!isBookTitle(h.title)) chapter = h.title;
      lines = lines.slice(1);
    }
    if (!lines.length || looksLikeContentsOrIndex(lines)) {
      skippedPages++;
      return;
    }
    const text = tidy(joinLines(lines));
    if (!text) {
      skippedPages++;
      return;
    }
    const sections = lines.map((l) => l.text.match(SECTION_RE)).filter(Boolean).map((m) => `${m[1]} ${m[2].trim()}`);
    prepared.push({ pdfPage: p.pageNumber, printedPage: printedPageOf(p, h), chapter, sections, text });
  });

  // Pass 2: group consecutive pages into passages, never across a chapter change.
  const chunks = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    const printed = cur.pages.map((p) => p.printedPage).filter((n) => n !== null);
    chunks.push({
      chapter: cur.chapter,
      pdfPages: [cur.pages[0].pdfPage, cur.pages[cur.pages.length - 1].pdfPage],
      printedPages: printed.length ? [Math.min(...printed), Math.max(...printed)] : null,
      sections: [...new Set(cur.pages.flatMap((p) => p.sections))].slice(0, 6),
      text: cur.pages.map((p) => p.text).join("\n\n"),
    });
    cur = null;
  };
  for (const p of prepared) {
    const contiguous = cur && p.pdfPage === cur.pages[cur.pages.length - 1].pdfPage + 1;
    if (cur && (!contiguous || p.chapter !== cur.chapter || cur.pages.length >= MAX_PAGES_PER_CHUNK || cur.chars >= TARGET_CHUNK_CHARS)) {
      close();
    }
    if (!cur) cur = { chapter: p.chapter, pages: [], chars: 0 };
    cur.pages.push(p);
    cur.chars += p.text.length;
  }
  close();
  return { chunks, skippedPages };
}

/** Split a plain-text / .docx textbook (no pages) into passages of roughly equal size. */
export function chunkPlainText(text) {
  const paragraphs = tidy(text).split(/\n{2,}/);
  const chunks = [];
  let buf = "";
  for (const para of paragraphs) {
    if (buf && buf.length + para.length > TARGET_CHUNK_CHARS) {
      chunks.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  if (buf) chunks.push(buf);
  return chunks.map((t, i) => ({ chapter: null, pdfPages: null, printedPages: null, sections: [], text: t, part: i + 1 }));
}

// Null-prototype objects: a plain {} already "has" keys like "constructor",
// which is an ordinary word in programming notes.
const counter = () => Object.create(null);
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : 0);

function termCounts(text) {
  const counts = counter();
  for (const t of tokenize(text)) counts[t] = (counts[t] || 0) + 1;
  return counts;
}

function weigh(counts, df, numDocs, limit) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const entries = Object.entries(counts).map(([term, c]) => [
    term,
    (c / total) * (Math.log((numDocs + 1) / (own(df, term) + 1)) + 1),
  ]);
  const kept = limit ? entries.sort((a, b) => b[1] - a[1]).slice(0, limit) : entries;
  return Object.fromEntries(kept.map(([t, w]) => [t, Number(w.toFixed(6))]));
}

/**
 * Add a TF-IDF vector to every chunk. Returns { chunks, df, numDocs } - df
 * and numDocs are stored with the textbook so notes uploaded later can be
 * vectorised against the same statistics (see vectorForQuery).
 */
export function indexChunks(chunks) {
  const counts = chunks.map((c) => termCounts(c.text));
  const df = counter();
  for (const c of counts) for (const term of Object.keys(c)) df[term] = own(df, term) + 1;
  const numDocs = chunks.length;
  return {
    chunks: chunks.map((c, i) => ({ ...c, vector: weigh(counts[i], df, numDocs, VECTOR_TERMS) })),
    df,
    numDocs,
  };
}

export function vectorForQuery(text, textbook) {
  return weigh(termCounts(text), textbook.df || {}, textbook.numDocs || 1);
}

/** Human-readable location of a chunk, e.g. "Assemblers · pp. 105–107". */
export function chunkLabel(chunk) {
  const [a, b] = chunk.printedPages || chunk.pdfPages || [];
  const where = a == null ? (chunk.part ? `part ${chunk.part}` : "") : a === b ? `p. ${a}` : `pp. ${a}–${b}`;
  return [chunk.chapter, where].filter(Boolean).join(" · ");
}

/**
 * The best-matching passages across a subject's textbooks for one note's text.
 * textbooks: [{ textbook, chunks }]. Returns up to MAX_REFS_PER_NOTE refs,
 * strongest first, each small enough to store on the note.
 */
export function findReferences(noteText, textbooks) {
  const scored = [];
  for (const { textbook, chunks } of textbooks) {
    const query = vectorForQuery(noteText, textbook);
    for (const chunk of chunks) {
      const score = cosineSimilarity(query, chunk.vector);
      if (score >= MIN_LINK_SCORE) scored.push({ textbook, chunk, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_REFS_PER_NOTE)
    .map(({ textbook, chunk, score }) => ({
      textbookId: textbook._id,
      textbookTitle: textbook.title,
      chunkId: chunk._id,
      label: chunkLabel(chunk),
      sections: chunk.sections || [],
      score: Number(score.toFixed(4)),
    }));
}
