// Which parts of a note are worth asking about.
//
// A note's text is not all subject matter. An uploaded file also carries its
// title page, the college and department, "prepared by", a table of contents,
// running headers, references - and often the exercises at the end of the
// chapter ("Write a program ...", "Calculate the ..."). Every one of those has
// the note's words in it, so a question built from "a sentence containing the
// keyword" is as likely to come from them as from the subject itself.
//
// So questions are only ever built from STUDY SENTENCES, which have to get
// past three gates:
//   1. structure - they come from the note's paragraphs and list entries
//      (`content`), never from headings, labels, tables or the title;
//   2. rules - a complete statement of fact, not a question, an instruction, a
//      syllabus line, a fragment or page furniture (isQuestionWorthy);
//   3. meaning - when the embedding model is available (embeddings.js), the
//      sentence has to be about what the note is about. This is the gate that
//      catches what no rule anticipates.
// Without the model, gate 3 falls back to "mentions one of the note's key
// terms" (see studyFor in keyTerms.js).

import { blocksFromPlainText, normalizeContent } from "./documentStructure.js";
import { centroid, cosine } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Gate 2: rules
// ---------------------------------------------------------------------------

// Page furniture and administrative lines: never subject matter.
const BOILERPLATE = new RegExp(
  [
    "\\bpage\\s+\\d+\\b", "\\.{3,}", "…", "\\btable of contents\\b", "^contents\\b", "\\ball rights reserved\\b", "©",
    "\\bsemester\\s+[ivx\\d]+\\b", "\\blecture notes\\b", "\\bdepartment of\\b", "https?:\\/\\/", "\\bwww\\.",
    // who made the document, and where
    "\\b(?:college|institute|institution|university|polytechnic)\\s+of\\b", "\\b(?:prepared|submitted|compiled|presented|taught)\\s+(?:by|to)\\b",
    "\\b(?:asst\\.?|assistant|associate)\\s+prof", "\\bprof(?:essor)?\\.?\\s+[A-Z]", "\\bdr\\.\\s+[A-Z]", "\\broll\\s*(?:no|number)\\b",
    "\\bacademic\\s+year\\b", "\\b(?:19|20)\\d\\d\\s*[-–/]\\s*(?:19|20)?\\d\\d\\b", "\\bcourse\\s+(?:code|outcomes?|objectives?)\\b",
    "\\b(?:assignment|experiment|practical|tutorial)\\s+(?:no\\.?|number|\\d)", "\\b\\d+\\s*marks?\\b", "\\bdue\\s+(?:on|by|date)\\b",
    "[\\w.+-]+@[\\w-]+\\.[a-z]{2,}",
    // how the course is run, not what it teaches: notices to the class and
    // when or where an exam, lecture or lab takes place
    "^students?\\s+(?:should|must|shall|are|will|need|have\\s+to)\\b", "\\bthis\\s+course\\b",
    "\\b(?:exam(?:ination)?s?|quiz(?:zes)?|viva|lectures?|lab(?:oratory)?\\s+sessions?)\\b[^.]{0,60}\\bwill\\s+be\\s+(?:held|conducted|scheduled)\\b",
  ].join("|"),
  "i"
);

// Verbs that open an instruction or exercise. Only verbs that are rarely the
// first word of a statement are listed: "Design", "State", "List", "Use",
// "Note", "Name", "Study" and "Test" also start ordinary sentences as nouns
// ("State machines ...", "List scheduling ..."), so they are left out.
const IMPERATIVE_START = new RegExp(
  "^(?:" +
    [
      "write", "convert", "explain", "implement", "describe", "calculate", "compute", "define",
      "discuss", "compare", "solve", "develop", "prove", "derive", "encrypt", "decrypt",
      "determine", "identify", "illustrate", "outline", "enumerate", "evaluate", "perform",
      "simulate", "construct", "create", "mention", "justify", "differentiate", "distinguish",
      "analyse", "analyze", "find", "give", "draw", "sketch", "demonstrate", "elaborate",
      "summarize", "summarise", "classify", "estimate", "verify", "execute", "run", "install",
      "configure", "consider", "suppose", "assume", "let", "show", "fill", "choose", "attempt",
      "tabulate", "list out", "write down", "briefly", "refer", "see", "submit",
      "state the", "list the", "name the",
    ].join("|") +
    ")(?=[\\s,:])",
  "i"
);

/** True when the sentence states something, rather than asking or instructing. */
export function isStatement(sentence) {
  const s = String(sentence || "").trim().replace(/^[("'“‘]+/, "");
  // a question from the notes, not a fact to ask about
  if (/\?["')\]”’]?$/.test(s)) return false;
  // a fragment: prose sentences start with a capital or a digit. A first word
  // with a capital inside it ("iPhone", "eBPF") still counts as a start.
  if (!/^(?:[A-Z0-9]|[a-z]+[A-Z])/.test(s)) return false;
  // an exercise or lab task
  if (IMPERATIVE_START.test(s)) return false;
  // a syllabus line: a capitalised title, a colon, then a list of topics
  const colon = s.indexOf(":");
  if (colon > 0) {
    const head = s.slice(0, colon).trim().split(/\s+/);
    const capitalised = head.filter((w) => /^[A-Z]/.test(w)).length;
    const commas = (s.slice(colon).match(/,/g) || []).length;
    if (head.length >= 2 && head.length <= 8 && capitalised >= 2 && commas >= 2) return false;
  }
  return true;
}

/**
 * True for a sentence that is subject matter a question can be built from.
 * `listEntry`: the text is a whole list entry, which is allowed to end without
 * a full stop ("Shared lock: the transaction can read the item").
 */
export function isQuestionWorthy(sentence, { listEntry = false } = {}) {
  const s = String(sentence || "").trim();
  if (/\n\s*\n/.test(s)) return false; // spans several paragraphs: a split went wrong
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 6 || words.length > 60) return false;
  // a complete sentence, not a heading or list line
  if (!/[.!?]["')\]]?$/.test(s) && !(listEntry && words.length >= 8)) return false;
  if (BOILERPLATE.test(s)) return false;
  // a numbered heading glued onto the sentence ("... 1.1 Network Topologies A
  // network topology describes ..."), as older or messier extraction produces
  if (/(^|\s)\d+(\.\d+)+\.?\s+[A-Z]/.test(s)) return false;
  // Headings, titles and tables of contents are Mostly Capitalised Words;
  // prose is mostly lower-case words.
  const alpha = words.filter((w) => /[a-z]/i.test(w));
  const lower = alpha.filter((w) => /^[("']?[a-z]/.test(w)).length;
  if (alpha.length === 0 || lower / alpha.length < 0.5) return false;
  if (!isStatement(s)) return false;
  return true;
}

/** Lighter check for a quoted phrase (an LLM's excerpt): not page furniture or a heading. */
export function isContentExcerpt(excerpt) {
  const e = String(excerpt || "").trim();
  if (BOILERPLATE.test(e)) return false;
  const words = e.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length >= 4 && words.filter((w) => /^[("']?[a-z]/.test(w)).length / words.length < 0.4) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Gate 1: structure
// ---------------------------------------------------------------------------

/** A note's display blocks: stored `content`, or worked out for an older note. */
export function blocksOf(note) {
  if (Array.isArray(note?.content) && note.content.length) return note.content;
  return normalizeContent(blocksFromPlainText(note?.rawText || "", { ocr: note?.sourceType === "image" }), { title: note?.title });
}

// Line breaks are joined line by line (split, trim, join) and not with a
// pattern such as /\s*\n\s*/, which on a long run of spaces retries from every
// one of them.
const splitSentences = (text) =>
  String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Candidate sentences, in reading order, that pass gates 1 and 2:
 *   { text, kind: "para" | "item", section, lead }
 * `section` is the nearest heading or label above ("Lock modes"); `lead` is
 * the term a list entry opens with ("Shared lock"), if any.
 */
export function candidateSentences(note) {
  const out = [];
  const seen = new Set();
  let section = null;
  for (const b of blocksOf(note)) {
    if (b.type === "heading" || b.type === "label") {
      section = String(b.text || "").replace(/:\s*$/, "");
      continue;
    }
    if (b.type !== "para" && b.type !== "item") continue; // tables are cells, not statements
    const listEntry = b.type === "item";
    const parts = splitSentences(b.text);
    // a list entry is one statement when it is one sentence
    const units = listEntry && parts.length <= 1 ? [b.text.trim()] : parts;
    for (const text of units) {
      if (seen.has(text) || !isQuestionWorthy(text, { listEntry: listEntry && units.length === 1 })) continue;
      seen.add(text);
      const lead = text.match(/^([A-Z0-9(][^:.!?]{1,48}?):\s+\S/)?.[1];
      out.push({ text, kind: b.type, section, lead: lead && lead.split(/\s+/).length <= 5 ? lead : null });
    }
  }
  return out;
}

/** Everything a question may quote from: the note's plain text and its display text. */
export function quotableText(note) {
  const display = blocksOf(note)
    .filter((b) => b.type !== "table")
    .map((b) => b.text)
    .join("\n");
  return `${note?.rawText || ""}\n${display}`;
}

// ---------------------------------------------------------------------------
// Gate 3: meaning
// ---------------------------------------------------------------------------

// A sentence stays when it is close enough to what the note is about. Two
// reference points are used, because either alone can be fooled: the note's
// own description (title, where it sits in its document, its headings), and
// the centre of all its sentences.
// Measured with all-MiniLM-L6-v2 on a note with administrative lines mixed in:
// against the centre, subject sentences scored 0.41-0.80 and administrative
// ones 0.21-0.28; against the description, 0.23-0.63 and 0.09-0.13. The bar
// sits in that gap. A sentence can also stay by being typical of its own note
// (at least 60% of the note's median closeness to the centre), so a note whose
// sentences are all only loosely related is judged against itself.
const RELEVANCE_FLOOR = 0.3;
const TYPICAL_FRACTION = 0.6;
const MIN_KEPT_FRACTION = 0.5;

/** What the note says it is about, in a line: for the model to compare against. */
export function topicDescriptor(note) {
  const headings = blocksOf(note)
    .filter((b) => b.type === "heading")
    .map((b) => b.text)
    .slice(0, 8);
  const trail = [note?.parentTopic, ...(Array.isArray(note?.path) ? note.path : []), note?.title].filter(Boolean);
  return [...new Set([...trail, ...headings])].join(". ");
}

/**
 * Score each sentence for relevance and drop the off-topic ones.
 * Returns the kept sentences with `relevance` (0..1) and `vector` set.
 */
export async function keepRelevant(note, sentences, embedder) {
  if (!embedder || sentences.length === 0) return sentences;
  const vectors = await embedder.embed([topicDescriptor(note), ...sentences.map((s) => s.text)]);
  const [topic, ...rest] = vectors;
  const centre = centroid(rest);
  const toCentre = rest.map((v) => cosine(v, centre));
  const median = [...toCentre].sort((a, b) => a - b)[Math.floor(toCentre.length / 2)] || 0;
  const scored = sentences.map((s, i) => {
    const toTopic = cosine(rest[i], topic);
    const relevance = Math.max(toTopic, 0.6 * toCentre[i] + 0.4 * toTopic);
    return { ...s, vector: rest[i], relevance: Number(relevance.toFixed(4)), typical: toCentre[i] >= median * TYPICAL_FRACTION };
  });
  let kept = scored.filter((s) => s.relevance >= RELEVANCE_FLOOR && s.typical);
  // Never let the gate empty a note: if it would drop more than half, the note
  // is simply loose-knit, and the closest half is kept instead.
  const minKeep = Math.ceil(scored.length * MIN_KEPT_FRACTION);
  if (kept.length < minKeep) kept = [...scored].sort((a, b) => b.relevance - a.relevance).slice(0, minKeep);
  const order = new Map(sentences.map((s, i) => [s.text, i]));
  return kept.sort((a, b) => order.get(a.text) - order.get(b.text));
}
