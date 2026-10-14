// A note's terms, in two forms (text -> { vector, keywords }):
//   - vector: TF-IDF weights over every term, a stand-in for the MiniLM
//     sentence embedding in the architecture doc's "dual extraction" step.
//     Similarity, and so every link (graphEngine.js), is computed from it.
//   - keywords: the note's 12 key words, ranked by TextRank weighted by IDF
//     (rankKeywords, below). The keyword map shows them, cross-subject linking
//     counts the ones two notes share, and the question generator's older
//     single-keyword path asks about them.
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

function termFrequencies(tokens) {
  const tf = {};
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

/** A text's sentences: split at . ! ? and at line breaks, whitespace collapsed. */
export function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

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
// Keywords: TextRank weighted by IDF
// ---------------------------------------------------------------------------
// Until Oct 2026 the keywords were the note's 12 highest TF-IDF terms. That
// ranks by count, so a plural took a second slot ("cell" and "cells"), and
// among the many words a note uses once, the 12 were filled in the order
// the text happened to use them. TextRank (Mihalcea & Tarau, 2004) ranks a
// word by how central it is instead: every word is a node, two words are
// joined when they stand next to each other in a sentence, and PageRank runs
// on that graph, so a word scores highly when it sits beside many words that
// score highly themselves.
//   - Window 2: words adjacent once stopwords are removed, within a sentence.
//     The paper found the smallest window best. On the link evaluation's
//     notes (117 topics, docs/LINK_EVALUATION.md) it also gave the fewest
//     weak keywords - function words, common verbs and generic words by
//     keyTerms.js's own lists: 15.0% of keywords, against 16.2% with a
//     window of 3, 17.1% with 4 and 17.8% for TF-IDF. Chosen on that, before
//     the ratings were looked at.
//   - The TextRank score is multiplied by the word's IDF within the subject,
//     as in the vector, so a word every note in the subject uses ("data",
//     "used") does not win. Without it, on the same notes, 21.1% of keywords
//     were weak and 1,610 cross-subject pairs shared a keyword instead of 297.
//   - A word's singular and plural are one node and one keyword (sameWord),
//     shown in the form the note uses most (ties: the shorter). That form
//     always occurs in the note, which the keyword map, the question
//     generator and the highlighting rely on.
//   - Numbers ("100", "1024") are never keywords: on their own they name
//     nothing, and two notes "sharing" one says nothing.
// Known limit: TextRank needs words that co-occur. In a note of a few
// sentences most words appear once, the graph is a few short chains, and a
// word's score mostly reflects where it sits in its sentence, so a verb such
// as "holds" can rank highly. Telling verbs from nouns needs a part-of-speech
// tagger. The cheap stand-ins lose real terms: keeping only words that follow
// "the", "of" and the like dropped "cable", "media" and "interference" from a
// note on transmission media, and keyTerms.js's list of common verbs has
// "read", "write", "join" and "support" in it.

const KEYWORDS = 12;
const WINDOW = 2;
const DAMPING = 0.85;
const TOLERANCE = 1e-6; // PageRank stops once no score moves by more than this
const MAX_ROUNDS = 200; // (converges in far fewer)

/**
 * The top keywords of `text` (see above), with idf from `corpusSets` (the
 * subject's other notes as tokenSet()s). Exported so the link evaluation can
 * check the choice of window; everything else goes through computeTfidf.
 */
export function rankKeywords(text, corpusSets = [], { window = WINDOW } = {}) {
  const sentences = splitSentences(text).map(tokenize);

  // each word's node: a plural joins its singular when the note uses both
  const vocab = new Set(sentences.flat());
  const nodeOf = new Map();
  for (const w of [...vocab].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))) {
    const singular = singularsOf(w).find((s) => vocab.has(s));
    nodeOf.set(w, singular ? nodeOf.get(singular) : w);
  }

  const links = new Map(); // node -> Map(neighbour -> times side by side)
  const forms = new Map(); // node -> Map(word as written -> count), in order of first use
  const firstAt = new Map();
  let at = 0;
  for (const words of sentences) {
    const nodes = words.map((w) => nodeOf.get(w));
    words.forEach((w, i) => {
      const node = nodes[i];
      if (!links.has(node)) {
        links.set(node, new Map());
        forms.set(node, new Map());
        firstAt.set(node, at);
      }
      forms.get(node).set(w, (forms.get(node).get(w) || 0) + 1);
      at += 1;
    });
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < Math.min(nodes.length, i + window); j++) {
        const [a, b] = [nodes[i], nodes[j]];
        if (a === b) continue;
        links.get(a).set(b, (links.get(a).get(b) || 0) + 1);
        links.get(b).set(a, (links.get(b).get(a) || 0) + 1);
      }
    }
  }

  // PageRank on the weighted graph: each node passes its score to its
  // neighbours in proportion to how often they stand beside it
  const nodes = [...links.keys()];
  const outgoing = new Map(nodes.map((n) => [n, [...links.get(n).values()].reduce((s, w) => s + w, 0)]));
  let score = new Map(nodes.map((n) => [n, 1]));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = new Map();
    let moved = 0;
    for (const n of nodes) {
      let flow = 0;
      for (const [m, w] of links.get(n)) flow += (w / outgoing.get(m)) * score.get(m);
      const s = 1 - DAMPING + DAMPING * flow;
      moved = Math.max(moved, Math.abs(s - score.get(n)));
      next.set(n, s);
    }
    score = next;
    if (moved < TOLERANCE) break;
  }

  // idf as in the vector, but a note counts as using the word in either form
  const numDocs = corpusSets.length + 1;
  const idfOf = (node) => {
    const words = [...forms.get(node).keys()].flatMap((w) => [w, ...pluralsOf(w), ...singularsOf(w)]);
    const using = corpusSets.filter((set) => words.some((w) => set.has(w))).length;
    return Math.log(numDocs / (1 + using)) + 1;
  };
  const shown = (node) =>
    [...forms.get(node)].reduce((best, form) => (form[1] > best[1] || (form[1] === best[1] && form[0].length < best[0].length) ? form : best))[0];

  return nodes
    .filter((n) => !/^\d+$/.test(n))
    .map((n) => ({ word: shown(n), score: score.get(n) * idfOf(n), first: firstAt.get(n) }))
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, KEYWORDS)
    .map((k) => k.word);
}

/**
 * Compute a TF-IDF vector and the top keywords (TextRank weighted by IDF) for
 * `text`, using `corpusDocs` (the subject's other notes: raw text strings, or
 * their tokenSet()s) for document frequency / idf. The name dates from when
 * the keywords were the top TF-IDF terms too; routes, services, the
 * evaluation and tests all call it, so it stays. It returns exactly these two
 * fields, because callers save the whole result onto the note.
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

  return { vector, keywords: rankKeywords(text, corpusTokenSets) };
}

export function cosineSimilarity(vecA, vecB) {
  const terms = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  let dot = 0, magA = 0, magB = 0;
  for (const t of terms) {
    const a = vecA[t] || 0;
    const b = vecB[t] || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
