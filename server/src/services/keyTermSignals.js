// What, besides the note's own text, says a term is a key term:
//
//   student   terms the student added to the note (`note.termMarks.add`) -
//             always key terms - or took away (`termMarks.remove`) - never
//   ai        terms the AI suggested for the note (`note.aiTerms`, made by
//             aiKeyTerms.js when the note was saved), each found word for
//             word in the note; ignored once the note's text has changed
//   syllabus  terms of the subject's syllabus (`subject.syllabus`, attached
//             to the note as `note.syllabus` by whoever loads it, see
//             withSyllabus) that the note uses
//
// keyTerms.extractTerms reads these as marks, like a heading or bold type:
// a marked term is accepted even when said once, and ranks higher.
// Everything that caches a note's terms or concept records includes
// signalsFingerprint(note), so a change to any of them is seen at once.

import crypto from "node:crypto";

/** A short fingerprint of a note's text, to tell whether AI terms still apply. */
export function textFingerprint(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex").slice(0, 16);
}

// "Unit 3: Memory Management - paging, page table, TLB; segmentation."
// -> ["memory management", "paging", "page table", "tlb", "segmentation"]
const NUMBERING = /^\s*(?:(?:unit|module|chapter|part|topic|section|week)\s*[-:.]?\s*[\divxlc]+\b\s*[-:.)]?|\d+(?:\.\d+)*[.)]?|[ivxlc]+[.)]|[a-z][.)]|[-*•])\s*/i;
const MAX_SYLLABUS_PHRASES = 400;

export function parseSyllabus(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || "").split(/[\n;,•]+|\s[-–—]\s|:\s|\(|\)/)) {
    let p = raw.replace(NUMBERING, "").replace(/\s+/g, " ").trim().replace(/[.:]+$/, "");
    // "Kirchhoff's laws (KCL, KVL)" and "maxima and minima" stay whole terms, but
    // "prevention, detection and recovery" was already split at its commas:
    // a list's last "and" splits too, when both sides are short
    const parts = /\band\b/i.test(p) && p.split(/\s+/).length > 4 ? p.split(/\s+and\s+/i) : [p];
    for (let q of parts) {
      q = q.trim();
      const words = q.split(/\s+/).filter(Boolean);
      if (!words.length || words.length > 6 || q.length < 2) continue;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
      if (out.length >= MAX_SYLLABUS_PHRASES) return out;
    }
  }
  return out;
}

const syllabusCache = new Map();
function syllabusPhrases(text) {
  const key = String(text || "");
  if (!key) return [];
  if (!syllabusCache.has(key)) {
    if (syllabusCache.size > 200) syllabusCache.clear();
    syllabusCache.set(key, parseSyllabus(key));
  }
  return syllabusCache.get(key);
}

const strings = (list, max = 60) =>
  (Array.isArray(list) ? list : [])
    .filter((x) => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max);

/**
 * The signals of one note: { added: [term], removed: [term], ai: [{ term,
 * importance 1-3 }], syllabus: [phrase] }. AI terms count only while the note's
 * text is the text they were suggested for.
 */
export function signalsOf(note) {
  const marks = note?.termMarks || {};
  const aiStored = note?.aiTerms;
  const aiValid = aiStored && Array.isArray(aiStored.terms) && aiStored.fingerprint === textFingerprint(note?.rawText);
  return {
    added: strings(marks.add),
    removed: strings(marks.remove),
    ai: aiValid
      ? aiStored.terms
          .filter((t) => t && typeof t.term === "string")
          .slice(0, 40)
          .map((t) => ({ term: t.term.trim(), importance: [1, 2, 3].includes(t.importance) ? t.importance : 2 }))
      : [],
    syllabus: syllabusPhrases(note?.syllabus),
  };
}

/** Changes whenever any signal of the note changes ("" when it has none). */
export function signalsFingerprint(note) {
  const s = signalsOf(note);
  if (!s.added.length && !s.removed.length && !s.ai.length && !s.syllabus.length) return "";
  return crypto.createHash("sha1").update(JSON.stringify(s)).digest("hex").slice(0, 12);
}

/** Notes with their subject's syllabus attached (copies; the stored notes are not changed). */
export function withSyllabus(notes, subject) {
  const syllabus = typeof subject?.syllabus === "string" && subject.syllabus.trim() ? subject.syllabus : null;
  if (!syllabus) return notes;
  return notes.map((n) => (n ? { ...n, syllabus } : n));
}
