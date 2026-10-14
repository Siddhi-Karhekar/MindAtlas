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
function topKeywords(vector, tf) {
  // each word's keyword: a plural joins its singular when the note uses both
  const keyOf = new Map();
  for (const w of Object.keys(tf).sort((a, b) => a.length - b.length || (a < b ? -1 : 1))) {
    const singular = singularsOf(w).find((x) => Object.hasOwn(tf, x));
    keyOf.set(w, singular ? keyOf.get(singular) : w);
  }
  const keywords = new Map(); // key -> { weight, shown }, in order of first use
  for (const [word, weight] of Object.entries(vector)) {
    const key = keyOf.get(word);
    if (/^\d+$/.test(key)) continue;
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
export function computeTfidf(text, corpusDocs = []) {
  const tokens = tokenize(text);
  const tf = termFrequencies(tokens);
  const totalTerms = tokens.length || 1;

  const corpusTokenSets = corpusDocs.map(tokenSet);
  const numDocs = corpusTokenSets.length + 1; // include this doc itself

  const vector = {};
  for (const term of Object.keys(tf)) {
    const docsContainingTerm =
      1 + corpusTokenSets.filter((set) => set.has(term)).length;
    const idf = Math.log(numDocs / docsContainingTerm) + 1;
    const tfNorm = tf[term] / totalTerms;
    vector[term] = Number((tfNorm * idf).toFixed(6));
  }

  return { vector, keywords: topKeywords(vector, tf) };
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
