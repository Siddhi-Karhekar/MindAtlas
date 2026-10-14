// A note's meaning as one vector: the MiniLM sentence model (embeddings.js)
// applied to the whole note. Member 2's next-phase item 5: linking topics by
// what they are about rather than by the words they share, which is what
// "class" in IPv4 address classes and in class-imbalanced data needs.
//
// Not used by the graph yet. The link evaluation measures it first
// (docs/LINK_EVALUATION.md, "Sentence embeddings"); this is the one place
// the vector is worked out, so the graph would use exactly what was
// measured.
//
// The model reads at most 256 word pieces (about 200 words) at a time, and a
// topic is often longer, so each sentence is embedded on its own and the
// note's vector is their normalised mean: every sentence counts, and none is
// cut off. Chosen before any rating was looked at.

import { splitSentences } from "./keywordMap.js";
import { centroid } from "./embeddings.js";

/**
 * The normalised mean of the embeddings of `text`'s sentences, from
 * `embedder` (getEmbedder() in embeddings.js), or null for a text with no
 * sentences or when there is no embedder.
 */
export async function embedNoteText(text, embedder) {
  if (!embedder) return null;
  const sentences = splitSentences(text).filter((s) => /[a-z0-9]{2}/i.test(s));
  if (!sentences.length) return null;
  return centroid(await embedder.embed(sentences));
}
