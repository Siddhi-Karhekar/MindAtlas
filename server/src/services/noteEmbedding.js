// A note's meaning as one vector: the MiniLM sentence model (embeddings.js)
// applied to the whole note. Member 2's next-phase item 5: linking topics by
// what they are about rather than by the words they share, which is what
// "class" in IPv4 address classes and in class-imbalanced data needs.
//
// The knowledge graph uses it for cross-subject links (graphEngine.js,
// decideLink), and the link evaluation measured exactly this
// (docs/LINK_EVALUATION.md, "Sentence embeddings"). Everything here is
// optional: without the model there are no vectors, and the graph links by
// TF-IDF alone, as it always did.
//
// The model reads at most 256 word pieces (about 200 words) at a time, and a
// topic is often longer, so each sentence is embedded on its own and the
// note's vector is their normalised mean: every sentence counts, and none is
// cut off. Chosen before any rating was looked at. Each sentence is embedded
// on its own (embeddings.js, `alone`): batched, the 8-bit model's vectors
// shift with their batch, and a stored vector must not depend on which
// other notes happened to be embedded with it.

import crypto from "node:crypto";
import { findEmbeddings, saveEmbedding } from "../models/NoteEmbedding.js";
import { isSplitParent } from "../models/Note.js";
import { splitSentences } from "./keywordMap.js";
import { centroid } from "./embeddings.js";

// Stored to six decimal places: a change of a millionth cannot move a link.
const DECIMALS = 6;

/** Fingerprint of the text a vector is made from, whitespace aside. */
export const textHash = (text) =>
  crypto.createHash("sha256").update(String(text || "").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

/**
 * The normalised mean of the embeddings of `text`'s sentences, from
 * `embedder` (getEmbedder() in embeddings.js), or null for a text with no
 * sentences or when there is no embedder.
 */
export async function embedNoteText(text, embedder) {
  if (!embedder) return null;
  const sentences = splitSentences(text).filter((s) => /[a-z0-9]{2}/i.test(s));
  if (!sentences.length) return null;
  // each sentence alone, so a note's vector depends on its text only
  return centroid(await embedder.embed(sentences, { alone: true }));
}

/**
 * `notes` with their embeddings attached, for linking: each gets `embedding`
 * and `embeddingModel` when it has a usable vector, and is left as it is
 * otherwise. A stored vector is usable when it was made from the note's
 * current text (and, with an `embedder`, by the same model). Each note in
 * `compute` that has no usable vector gets one worked out, when there is an
 * embedder, and saved unless `save` is false (a dry run). Split documents
 * are never linked, so never embedded. Returns { notes, computed }.
 */
export async function withEmbeddings(notes, { embedder = null, compute = [], save = true } = {}) {
  const stored = await findEmbeddings(notes.map((n) => n._id));
  const wanted = new Set(compute.map((n) => String(n._id)));
  let computed = 0;
  const out = [];
  for (const note of notes) {
    const id = String(note._id);
    const hash = textHash(note.rawText);
    let row = stored.get(id);
    if (row && (row.textHash !== hash || (embedder && row.model !== embedder.model))) row = null;
    if (!row && embedder && wanted.has(id) && !isSplitParent(note)) {
      const vector = await embedNoteText(note.rawText, embedder);
      if (vector) {
        row = { model: embedder.model, textHash: hash, vector: vector.map((x) => Number(x.toFixed(DECIMALS))) };
        if (save) await saveEmbedding({ noteId: id, ownerId: note.ownerId, ...row });
        stored.set(id, row);
        computed += 1;
      }
    }
    out.push(row ? { ...note, embedding: row.vector, embeddingModel: row.model } : note);
  }
  return { notes: out, computed };
}
