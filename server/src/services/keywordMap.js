import { tokenize } from "./tfidf.js";

// A note's keyword map: the note, its top keywords, and for each keyword the
// words it appears alongside and the sentences it appears in. Ported from the
// per-note graph in the Digital Second Brain prototype (note -> keywords ->
// related words), with two changes: keyword importance comes from the note's
// own stored TF-IDF weights rather than a raw word count, and each keyword
// carries the sentences it came from, so a student can see it in context.
// Rule-based and pure: no LLM, no database.

const SUB_KEYWORDS = 5; // related words shown per keyword
const SENTENCES = 3; // example sentences per keyword
const EXCERPT = 240; // longest sentence shown before trimming around the keyword

export function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// "cell" and "cells" are one idea, so a keyword's own plural is never offered
// as a word it appears with.
const sameWord = (a, b) => a === b || a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;

// A long sentence (common in PDF text) trimmed to a window around the keyword.
function excerpt(sentence, keyword) {
  if (sentence.length <= EXCERPT) return sentence;
  const at = Math.max(0, sentence.toLowerCase().search(new RegExp(`\\b${keyword.replace(/[^a-z0-9]/g, "\\$&")}`)));
  const start = Math.max(0, Math.min(at - 80, sentence.length - EXCERPT));
  return `${start > 0 ? "…" : ""}${sentence.slice(start, start + EXCERPT).trim()}${start + EXCERPT < sentence.length ? "…" : ""}`;
}

/**
 * Returns one entry per keyword, in the note's own keyword order (strongest
 * first): { keyword, weight, subKeywords, sentences }.
 *   weight      - 0..1, the keyword's TF-IDF weight relative to the note's
 *                 strongest keyword (rank order for notes stored without one)
 *   subKeywords - up to five words that appear in the same sentences, most
 *                 frequent first (ties: first to appear); never another of the
 *                 note's top keywords, which are already on the map
 *   sentences   - up to three sentences from the note that use the keyword
 *   sentenceCount - how many sentences use it in all; related words come from
 *                 all of them, so the page can say "3 of 5 sentences"
 */
export function buildKeywordMap(note) {
  const keywords = note.keywords || [];
  const vector = note.vector || {};
  const sentences = splitSentences(note.rawText).map((text) => ({ text, tokens: tokenize(text) }));
  const maxWeight = Math.max(0, ...keywords.map((k) => vector[k] || 0));

  return keywords.map((keyword, rank) => {
    const containing = sentences.filter((s) => s.tokens.includes(keyword));

    const counts = new Map();
    let position = 0;
    for (const s of containing) {
      for (const t of s.tokens) {
        position += 1;
        if (keywords.some((k) => sameWord(k, t))) continue;
        const c = counts.get(t);
        counts.set(t, c ? { count: c.count + 1, first: c.first } : { count: 1, first: position });
      }
    }
    const subKeywords = [...counts.entries()]
      .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
      .slice(0, SUB_KEYWORDS)
      .map(([t]) => t);

    const weight = maxWeight > 0 ? (vector[keyword] || 0) / maxWeight : 1 - rank / Math.max(1, keywords.length);
    return {
      keyword,
      weight: Number(weight.toFixed(3)),
      subKeywords,
      sentences: containing.slice(0, SENTENCES).map((s) => excerpt(s.text, keyword)),
      sentenceCount: containing.length,
    };
  });
}
