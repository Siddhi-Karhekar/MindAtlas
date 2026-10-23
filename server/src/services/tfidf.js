// A note's terms, in two forms (text -> { vector, keywords }):
//   - vector: TF-IDF weights over every term, a stand-in for the MiniLM
//     sentence embedding in the architecture doc's "dual extraction" step.
//     Similarity, and so every link (graphEngine.js), is computed from it.
//   - keywords: the note's 12 highest-scoring words by TF-IDF, with a word's
//     singular and plural counted as one keyword (topKeywords, below). The
//     keyword map and the graph page show them, and the question generator's
//     older single-keyword path asks about them. Linking compares the vector's
//     own top terms instead (graphEngine.js, linkTerms, which says why).
// Zero external ML dependencies, so it runs anywhere with no model download -
// the interface is what a real embedding call would return, so swapping in
// @xenova/transformers or a hosted embedding API later only touches this
// file.

import { nounFilter } from "./posTags.js";
import { yake } from "./keyphraseScores.js";

// YAKE for the keywords (KEYWORDS_YAKE=on): each candidate keyword's TF-IDF
// weight is scaled by its YAKE rank in the note (x0.75 to x1.25), so a word
// the note itself treats as central ranks higher even when the subject has no
// other notes to compare against. Off by default: see docs/KEYTERMS.md.
// How link vectors are weighted: "tfidf" (default) or "bm25" (LINK_WEIGHTING=bm25).
// The link thresholds (graphEngine.js) were chosen on TF-IDF similarities; BM25
// changes the scale, so it stays off until it is scored on the rated pairs
// (docs/KEYTERMS.md, "BM25"). Changing it needs `npm run relink`.
export const linkWeighting = () => (/^bm25$/i.test(String(process.env.LINK_WEIGHTING || "").trim()) ? "bm25" : "tfidf");
const keywordsYake = () => /^(?:on|true|1|yes)$/i.test(String(process.env.KEYWORDS_YAKE || "").trim());
function yakeWordRanks(text, words) {
  const runs = String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => {
      const out = [];
      let run = [];
      let first = true;
      for (const m of sentence.matchAll(/[A-Za-z0-9][A-Za-z0-9'-]*|[^\sA-Za-z0-9]+/g)) {
        const raw = m[0];
        const lower = raw.toLowerCase();
        if (!/^[a-z0-9]/i.test(raw) || STOPWORDS.has(lower) || lower.length <= 2 || /^\d+$/.test(lower)) {
          if (run.length) out.push(run);
          run = [];
        } else run.push({ raw, lower, start: first });
        first = false;
      }
      if (run.length) out.push(run);
      return out;
    });
  return yake(runs, words, (w) => w);
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "of", "to", "in",
  "on", "for", "with", "as", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "at", "by", "from", "into",
  "about", "than", "which", "who", "whom", "what", "when", "where", "why",
  "how", "not", "no", "can", "could", "will", "would", "should", "may",
  "might", "must", "shall", "do", "does", "did", "has", "have", "had", "i",
  "you", "he", "she", "we", "they", "them", "his", "her", "their", "our",
  "your", "my", "me", "us", "also", "each", "such", "there", "here", "up",
  "out", "over", "under", "again", "further", "once", "very", "just",
  // slide-deck continuation markers ("Paging (cont.)")
  "cont", "contd", "continued",
]);

export function tokenize(text) {
  // formula commands (\frac, \int, \alpha) are notation, not key terms
  return (text.replace(/\\[a-zA-Z]+/g, " ").toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) || []).filter(
    (t) => !STOPWORDS.has(t) && t.length > 2
  );
}

/**
 * A crude stem, only for telling whether two words are forms of one word:
 * "processes"/"process", "frames"/"frame", "waiting"/"wait". Never shown.
 */
export function stem(word) {
  let w = String(word || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 4) {
    w = w.replace(/(?:ing|ed)$/, "").replace(/(ss|x|z|ch|sh)es$/, "$1").replace(/([^s])s$/, "$1");
  }
  return w.slice(0, 6);
}

// Counts in an object with no prototype: in a plain {}, the word
// "constructor" starts out as Object's constructor function, and a note using
// it got a weight of NaN and a NaN similarity to every note, so no links.
function termFrequencies(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

/**
 * The distinct terms of a document. A caller that compares many texts against
 * the same documents (every section of an upload against its siblings) calls
 * this once per document and passes the sets as the corpus, instead of having
 * every document tokenised again for every section.
 */
export const tokenSet = (doc) => (doc instanceof Set ? doc : new Set(tokenize(doc)));

// ---------------------------------------------------------------------------
// Singular and plural
// ---------------------------------------------------------------------------

const pluralsOf = (w) => [`${w}s`, `${w}es`, ...(w.endsWith("y") ? [`${w.slice(0, -1)}ies`] : [])];
// the words `w` could be the plural of, in the order they are tried
const singularsOf = (w) =>
  [w.endsWith("s") && w.slice(0, -1), w.endsWith("es") && w.slice(0, -2), w.endsWith("ies") && `${w.slice(0, -3)}y`].filter(Boolean);

/**
 * Whether two keywords are one word, in singular and plural: "cell" /
 * "cells", "class" / "classes", "query" / "queries". Only plurals, so nothing
 * is merged that a reader would tell apart - unlike stem(), whose six-letter
 * cut makes "distributed" and "distribution", or "relational" and "relative",
 * one word.
 */
export function sameWord(a, b) {
  return a === b || pluralsOf(a).includes(b) || pluralsOf(b).includes(a);
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------
// A note's keywords are its highest TF-IDF terms, as they always were, with
// two changes (Oct 2026):
//   - A word's singular and plural are one keyword, weighted by both forms'
//     TF-IDF weights added together. "cell" and "cells" used to take two of
//     the 12 slots (50 slots across the 117 topics of the link evaluation's
//     notes). The keyword is shown in the form the note uses most (ties: the
//     shorter), which always occurs in the note - the keyword map, the
//     question generator and the highlighting rely on that.
//   - Numbers ("100", "1024") are never keywords: on their own they name
//     nothing.
// A note with neither keeps exactly the keywords it had.
// TextRank (Mihalcea & Tarau, 2004) was tried in their place and not kept
// (commit 208d805); docs/LINK_EVALUATION.md, "Keywords and TextRank", has
// the numbers.
// Weighted by IDF it gave fewer weak words (function words, common verbs),
// but fewer of its keywords were words of the notes' own key terms
// (keyTerms.js), notes lost their central words ("missing", "values" and
// "binning" from Data Cleaning), and related notes in different subjects kept
// far fewer words in common. TF-IDF is a strong baseline for this; the
// keyword-extraction literature found the same (Hasan & Ng, 2010).

const KEYWORDS = 12;

/**
 * The top keywords from a note's TF-IDF `vector` and term counts `tf` (see
 * above), highest first; ties keep the order the note first uses them.
 */
function topKeywords(vector, tf, keep = () => true) {
  // each word's keyword: a plural joins its singular when the note uses both
  const keyOf = new Map();
  for (const w of Object.keys(tf).sort((a, b) => a.length - b.length || (a < b ? -1 : 1))) {
    const singular = singularsOf(w).find((x) => Object.hasOwn(tf, x));
    keyOf.set(w, singular ? keyOf.get(singular) : w);
  }
  const keywords = new Map(); // key -> { weight, shown }, in order of first use
  for (const [word, weight] of Object.entries(vector)) {
    const key = keyOf.get(word);
    if (/^\d+$/.test(key) || !keep(key)) continue;
    const k = keywords.get(key);
    if (!k) keywords.set(key, { weight, shown: word });
    else {
      k.weight += weight;
      if (tf[word] > tf[k.shown] || (tf[word] === tf[k.shown] && word.length < k.shown.length)) k.shown = word;
    }
  }
  return [...keywords.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, KEYWORDS)
    .map((k) => k.shown);
}

/**
 * Compute a TF-IDF vector and top keywords for `text`, using `corpusDocs`
 * (the subject's other notes: raw text strings, or their tokenSet()s) to
 * derive document frequency / idf. It returns exactly these two fields,
 * because callers save the whole result onto the note.
 */
export function computeTfidf(text, corpusDocs = [], { nounsOnly = true, weighting = linkWeighting() } = {}) {
  const tokens = tokenize(text);
  const tf = termFrequencies(tokens);
  const totalTerms = tokens.length || 1;

  const corpusTokenSets = corpusDocs.map(tokenSet);
  const numDocs = corpusTokenSets.length + 1; // include this doc itself
  // BM25 needs the corpus's average length: from the texts given (a corpus
  // passed as token sets counts its distinct words, the closest it can tell)
  const avgLength =
    weighting === "bm25" ? (corpusDocs.reduce((n, d) => n + (d instanceof Set ? d.size : tokenize(d).length), 0) + tokens.length) / numDocs || 1 : 0;

  const vector = {};
  for (const term of Object.keys(tf)) {
    const docsContainingTerm =
      1 + corpusTokenSets.filter((set) => set.has(term)).length;
    if (weighting === "bm25") {
      // Okapi BM25 (k1 = 1.2, b = 0.75): a word's weight grows with its count
      // but saturates, and a long note's counts are discounted against the
      // average length - where TF-IDF grows without limit
      const idf = Math.log(1 + (numDocs - docsContainingTerm + 0.5) / (docsContainingTerm + 0.5));
      const k1 = 1.2;
      const b = 0.75;
      const f = tf[term];
      vector[term] = Number(((idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokens.length) / avgLength))).toFixed(6));
      continue;
    }
    const idf = Math.log(numDocs / docsContainingTerm) + 1;
    const tfNorm = tf[term] / totalTerms;
    vector[term] = Number((tfNorm * idf).toFixed(6));
  }

  // keywords are things, not "any", "called" or "solve": with the tagger
  // (posTags.js), a word the text uses mostly as another part of speech is
  // left out of the keywords. The vector - what links are computed from -
  // keeps every word, so links do not change.
  let ranked = vector;
  if (keywordsYake()) {
    const ranks = yakeWordRanks(text, Object.keys(vector));
    ranked = Object.fromEntries(Object.entries(vector).map(([w, x]) => [w, ranks.has(w) ? x * (0.75 + 0.5 * ranks.get(w)) : x]));
  }
  return { vector, keywords: topKeywords(ranked, tf, nounsOnly ? nounFilter(text) : undefined) };
}

export function cosineSimilarity(vecA, vecB) {
  const terms = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  let dot = 0, magA = 0, magB = 0;
  for (const t of terms) {
    // own weights only: vectors are plain objects, and "constructor" is
    // inherited by every one of them (see termFrequencies)
    const a = Object.hasOwn(vecA, t) ? vecA[t] : 0;
    const b = Object.hasOwn(vecB, t) ? vecB[t] : 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
