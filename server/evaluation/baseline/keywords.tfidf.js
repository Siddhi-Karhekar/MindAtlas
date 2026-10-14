// EVALUATION BASELINE - not used by the app.
//
// The keyword step of services/tfidf.js exactly as it was on `main` at commit
// f9472e8 (14 Oct 2026): a note's keywords are its 12 highest TF-IDF terms.
// The app now ranks keywords by TextRank weighted by IDF (tfidf.js,
// rankKeywords), but the baseline question generator (testEngine.tfidf.js)
// was measured on these, so the evaluation gives it these: evaluation/
// generate.mjs replaces the notes' keywords with tfidfKeywords() for the
// "tfidf" strategy only. Like the rest of this folder, it is kept unchanged
// apart from the import path. Do not fix or improve it.
import { tokenize } from "../../src/services/tfidf.js";

const tokenSet = (doc) => (doc instanceof Set ? doc : new Set(tokenize(doc)));

/**
 * The 12 highest TF-IDF terms of `text`, with idf from `corpusDocs` (raw text
 * strings or token sets), as computeTfidf returned them before TextRank.
 */
export function tfidfKeywords(text, corpusDocs = []) {
  const tokens = tokenize(text);
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
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

  return Object.entries(vector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term]) => term);
}
