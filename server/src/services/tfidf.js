// TF-IDF keyword extraction + a TF-IDF-weighted vector used as a stand-in
// for the MiniLM sentence embedding in the architecture doc's "dual
// extraction" step. Zero external ML dependencies, so it runs anywhere
// with no model download - the interface (text -> {keywords, vector}) is
// exactly what a real embedding call would return, so swapping in
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
]);

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) || []).filter(
    (t) => !STOPWORDS.has(t) && t.length > 2
  );
}

function termFrequencies(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

/**
 * Compute a TF-IDF vector and top keywords for `text`, using `corpusDocs`
 * (an array of raw text strings - the subject's other notes) to derive
 * document frequency / idf.
 */
export function computeTfidf(text, corpusDocs = []) {
  const tokens = tokenize(text);
  const tf = termFrequencies(tokens);
  const totalTerms = tokens.length || 1;

  const corpusTokenSets = corpusDocs.map((doc) => new Set(tokenize(doc)));
  const numDocs = corpusTokenSets.length + 1; // include this doc itself

  const vector = {};
  for (const term of Object.keys(tf)) {
    const docsContainingTerm =
      1 + corpusTokenSets.filter((set) => set.has(term)).length;
    const idf = Math.log(numDocs / docsContainingTerm) + 1;
    const tfNorm = tf[term] / totalTerms;
    vector[term] = Number((tfNorm * idf).toFixed(6));
  }

  const keywords = Object.entries(vector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term]) => term);

  return { vector, keywords };
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
