import { callLLM, llmAvailable, parseJsonLoose } from "./llm.js";
import { tokenize } from "./tfidf.js";
import { topicWeight } from "./masteryEngine.js";

// Mirrors Diagram 3, step 1 of the architecture doc: an LLM drafts
// candidate questions, but every single one passes through a decision
// diamond first - "answer key supported by passage?" - before a student
// ever sees it. The model is only allowed to use the selected notes'
// own text as context (retrieval-augmented, never open-domain), and if
// it can't point to a passage that supports its own answer, the item is
// discarded here, server-side, not left for the student to catch.
//
// Two question types share this pipeline: "mcq" (unchanged from the
// original design) and "theory" (free-text / short-answer, added for
// mixed tests). Both go through the same grounding gate; only the shape
// of what's being verified differs (an options/correctAnswer pair for
// mcq, a modelAnswer + keyPoints rubric for theory).
//
// Every accepted question also carries a `difficulty` tier
// ("easy"|"medium"|"hard"). This is what routes/attempts.js's adaptive
// controller (adaptiveEngine.js) selects on - it does NOT feed the
// hallucination gate itself, since a mistagged difficulty doesn't make a
// question factually ungrounded. Callers ask for a bigger *pool* than
// they intend to deliver (see routes/tests.js) so the adaptive controller
// has real depth to pick from at each tier.

const DIFFICULTY_TIERS = ["easy", "medium", "hard"];

function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeDifficulty(d) {
  return DIFFICULTY_TIERS.includes(d) ? d : "medium";
}

function isSupportedByContext(excerpt, contextText) {
  const needle = normalize(excerpt);
  if (needle.length < 8) return false; // too short to meaningfully "support" anything
  return normalize(contextText).includes(needle);
}

// A topic's display label: "Document › Subtopic" for a subtopic of a split
// upload (set by routes/tests.js), the note title otherwise.
const labelOf = (n) => n?.topicLabel || n?.title;

function buildContext(notes) {
  return notes.map((n) => `### ${labelOf(n)}\n${n.rawText}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// MCQ generation (unchanged behavior, renamed for symmetry with theory)
// ---------------------------------------------------------------------------

async function generateMcqWithLLM(notes, mcqCount) {
  const context = buildContext(notes);
  const prompt = `You are drafting multiple-choice questions for a student's self-test, using ONLY the notes below as source material. Do not use any outside knowledge - every question's correct answer must be directly supported by a verbatim short excerpt from these notes. Aim for a roughly even mix of easy, medium, and hard questions across the set, and spread the questions across as many different ### sections as possible - each section is a separate topic the student is assessed on. Ask only about the subject matter itself - never about titles, headers, footers, page numbers, course codes, the table of contents, authors, references or other document metadata, and never quote such text as the supportingExcerpt. In a fill-in-the-blank question, blank the whole technical term (for example "continuous integration", never just "integration"), and make every option a complete term of the same kind and similar length.

NOTES:
${context}

Return a JSON array of exactly ${mcqCount} objects, each shaped like:
{
  "topic": "<the exact ### heading of the section this question is drawn from>",
  "prompt": "<the question text>",
  "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
  "correctAnswer": "<must exactly match one of the options>",
  "supportingExcerpt": "<a short verbatim quote from the notes above that supports the correct answer>",
  "difficulty": "<one of: easy, medium, hard>"
}
Return ONLY the JSON array, no other text.`;

  const raw = await callLLM(prompt);
  const parsed = parseJsonLoose(raw);
  if (!Array.isArray(parsed)) return null;
  return parsed;
}

// Zero-dependency fallback so the whole feature is runnable and testable
// without a GROQ_API_KEY - see server/.env.example. Builds a "fill in the
// blank" MCQ per note by blanking out that note's top TF-IDF keyword in a
// sentence that actually contains it, with distractors drawn from other
// notes' keywords. Deterministic, always grounded by construction (the
// supporting excerpt IS the sentence the blank came from).
//
// Difficulty here is a cheap heuristic, not a calibrated estimate - see
// the feasibility report's Section 5E for why full IRT calibration isn't
// attempted yet. It's assigned tier-FIRST, round-robin (easy, medium,
// hard, easy, medium, hard, ...) across the requested count, and then a
// keyword is picked from the corresponding band of that note's TF-IDF
// ranking: top third for "easy" (the note's most central/obvious terms),
// bottom third for "hard" (its most obscure ones), middle third
// otherwise. Deciding the tier up front and picking a matching keyword,
// rather than picking a keyword and classifying it after the fact, is
// what guarantees the pool actually has hard items for the staircase
// controller to escalate to - a small note with very few distinct
// keywords is the one case where the three bands can't help overlapping,
// which just means the note itself doesn't support much difficulty
// spread.
// TF-IDF has no part-of-speech information, so its top keywords include
// verbs and adjectives ("form", "consists", "charged") that make poor
// fill-in-the-blank answers and even poorer distractors. Without adding an
// NLP dependency, a cheap proxy for "this is a noun" is positional: nouns
// turn up right after a determiner or preposition ("the nucleus", "of
// protons", "by electrons"), verbs and adjectives mostly do not.
const NOUN_LEAD = "(?:the|a|an|of|its|their|by|between|in|and|these|those|each|when|whereas|with|from|into|through|among)";

function hasNounEvidence(word, text) {
  return new RegExp(`\\b${NOUN_LEAD}\\s+${word}\\b`, "i").test(text);
}

// ---------------------------------------------------------------------------
// Which text is worth asking about
// ---------------------------------------------------------------------------
// A note's raw text is not all subject matter. An uploaded PDF also carries
// its title page, table of contents, running headers ("CS302 Computer
// Networks - Department of ... Page 1"), course codes and references. Those
// lines contain the note's keywords too ("Networks", "protocols"), so a naive
// "first sentence containing the keyword" pick turned them into nonsense
// questions. Questions are only ever built from sentences that pass this
// filter: real prose sentences, not headings, lists of titles or page furniture.

const BOILERPLATE =
  /\bpage\s+\d+\b|\bpage\s+\d+\s+of\s+\d+|\.{3,}|…|\btable of contents\b|^contents\b|\ball rights reserved\b|©|\bsemester\s+[ivx\d]+\b|\blecture notes\b|\bdepartment of\b|https?:\/\/|\bwww\./i;

/** True for a sentence that is subject matter a question can be built from. */
export function isQuestionWorthy(sentence) {
  const s = String(sentence || "").trim();
  if (/\n\s*\n/.test(s)) return false; // spans several paragraphs: a split went wrong
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 6 || words.length > 60) return false;
  if (!/[.!?]["')\]]?$/.test(s)) return false; // a complete sentence, not a heading or list line
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

// A question has to be built from a statement of fact. Uploaded notes also
// hold exercises ("Write a program ...", "Convert the plaintext ..."), the
// notes' own questions ("What is the key space ...?"), syllabus lines
// ("Foundations of X: topic, topic, topic.") and fragments cut off by a page
// or column break ("and application layers into one, so ..."). Blanking a word
// in any of those gives a question that makes no sense.

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
      "tabulate", "list out", "write down", "briefly",
    ].join("|") +
    ")(?=[\\s,:])",
  "i"
);

/** True when the sentence states something, rather than asking or instructing. */
export function isStatement(sentence) {
  const s = String(sentence || "").trim().replace(/^[("'\u201c\u2018]+/, "");
  // a question from the notes, not a fact to ask about
  if (/\?["')\]\u201d\u2019]?$/.test(s)) return false;
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

const sentenceCache = new WeakMap();
/** The note's question-worthy sentences, in order. */
function contentSentences(note) {
  if (sentenceCache.has(note)) return sentenceCache.get(note);
  const out = String(note.rawText || "")
    .split(/\n\s*\n/) // paragraphs first, so a heading line never glues onto a sentence
    .flatMap((p) => p.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/))
    .map((x) => x.trim())
    .filter(isQuestionWorthy);
  sentenceCache.set(note, out);
  return out;
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// whole words only: "one" must not match inside "backbone", nor "network"
// inside "networks"
const wholeWord = (w) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(w)}(?![A-Za-z0-9])`, "i");

/** First content sentence that uses `keyword` as a whole word, or null. */
function sentenceFor(note, keyword) {
  const re = wholeWord(keyword);
  const all = new RegExp(re.source, "gi");
  const hits = contentSentences(note).filter((s) => re.test(s));
  // prefer a sentence that uses the word once: one blank reads as a question,
  // four blanks of the same word read as a puzzle
  return hits.find((s) => (s.match(all) || []).length === 1) || hits[0] || null;
}

// ---------------------------------------------------------------------------
// Blank the whole term, not one word of it
// ---------------------------------------------------------------------------
// TF-IDF keywords are single words, but many subject terms are several words.
// Blanking only "integration" in "continuous integration" leaves
// "continuous _____": it asks about half a term and hints at the answer. So
// the keyword is widened to the whole term it belongs to in its sentence. A
// neighbouring word joins the term when the note treats the pair as one term:
//   - the longer phrase occurs at least twice in the note, or
//   - the neighbour is also one of the note's keywords and the phrase is used
//     like a noun ("the block cipher", "a block cipher"), or
//   - the phrase is spelled out before its acronym ("continuous integration (CI)").
// A term never crosses punctuation, a stop word or a generic word, and is
// at most MAX_TERM_WORDS words long.
const MAX_TERM_WORDS = 4;

const phraseRe = (words, flags = "gi") =>
  new RegExp(`(?<![A-Za-z0-9])${words.map(escapeRe).join("\\s+")}(?![A-Za-z0-9])`, flags);

// "Inter-Domain" contributes both I and D ("Classless Inter-Domain Routing" -> CIDR)
const initialsOf = (words) => words.flatMap((w) => w.split("-").filter(Boolean)).map((w) => w[0]).join("").toUpperCase();

function joinableWord(word) {
  const w = word.toLowerCase();
  return /^[a-z][a-z0-9-]*$/i.test(word) && tokenize(w).length === 1 && !GENERIC.has(w) && !/ly$/.test(w);
}

// A word the note uses as a verb ("encrypts a block", "shifts each letter")
// is never part of a term, even when the phrase repeats ("block cipher
// encrypts", "stream cipher encrypts").
function hasVerbEvidence(word, text) {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(word)}\\s+(?:the|a|an|each|every|its|their|this|these|those|all)\\b`, "i").test(text);
}

// `side` is the side the new word joins on. The main noun of an English term
// comes last and its modifiers come first ("data link layer"). On the left, a
// keyword joins when the note uses the whole phrase as a noun ("the block
// cipher"). On the right, a keyword joins only when the note also uses that
// word as the head of a noun phrase ("a cipher", "the physical layer"), since
// a word after the term is often its verb ("layer groups bits").
function isTermInNote(words, note, side) {
  const text = String(note.rawText || "");
  const added = side === "left" ? words[0] : words[words.length - 1];
  if (hasVerbEvidence(added, text)) return false;
  if ((text.match(phraseRe(words)) || []).length >= 2) return true;
  if (words.length >= 2 && new RegExp(`${phraseRe(words, "").source}\\s*\\(${initialsOf(words)}s?\\)`, "i").test(text)) return true;
  if (!(note.keywords || []).includes(added.toLowerCase())) return false;
  if (side === "left") return hasNounEvidence(words.map(escapeRe).join("\\s+"), text);
  // "a cipher", "the physical layer": the word heads a noun phrase somewhere
  return new RegExp(`\\b${NOUN_LEAD}\\s+(?:[A-Za-z-]+\\s+)?${escapeRe(added)}\\b`, "i").test(text);
}

/**
 * The whole term that `keyword` belongs to in `sentence`, as written there
 * ("continuous integration"), or the keyword itself when it stands alone.
 */
export function termFor(note, sentence, keyword) {
  const tokens = String(sentence || "").split(/\s+/).filter(Boolean);
  const core = (t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  const at = tokens.findIndex((t) => core(t).toLowerCase() === keyword.toLowerCase());
  if (at === -1) {
    // inside a compound like "TCP/IP": keep the keyword as the sentence writes it
    const m = sentence.match(wholeWord(keyword));
    return m ? m[0] : keyword;
  }
  // A term spelled out before its acronym is taken whole, however long:
  // "Classless Inter-Domain Routing (CIDR)".
  for (let end = at; end < Math.min(tokens.length - 1, at + MAX_TERM_WORDS); end++) {
    const acronym = tokens[end + 1].match(/^\(([A-Z]{2,})s?\)[.,;:]?$/);
    if (!acronym || !/[A-Za-z0-9]$/.test(tokens[end])) continue;
    for (let start = end; start >= Math.max(0, end - 5); start--) {
      const words = tokens.slice(start, end + 1).map(core);
      if (start <= at && initialsOf(words) === acronym[1]) {
        if (start === 0 && /^[A-Z][a-z]+$/.test(words[0]) && words.length > 1 && /^[a-z]/.test(words[1])) words[0] = words[0].toLowerCase();
        return words.join(" ");
      }
    }
  }
  // a token with punctuation in front ends the term on its left; with
  // punctuation after it, on its right
  const cleanLeft = (t) => !/^[^A-Za-z0-9]/.test(t);
  const cleanRight = (t) => !/[^A-Za-z0-9]$/.test(t);
  let lo = at;
  let hi = at;
  let grew = true;
  while (grew && hi - lo + 1 < MAX_TERM_WORDS) {
    grew = false;
    const words = tokens.slice(lo, hi + 1).map(core);
    const left = tokens[lo - 1];
    if (left && cleanLeft(tokens[lo]) && cleanRight(left) && cleanLeft(left) && joinableWord(core(left)) && isTermInNote([core(left), ...words], note, "left")) {
      lo -= 1;
      grew = true;
      continue;
    }
    const right = tokens[hi + 1];
    if (right && cleanRight(tokens[hi]) && cleanLeft(right) && joinableWord(core(right)) && isTermInNote([...words, core(right)], note, "right")) {
      hi += 1;
      grew = true;
    }
  }
  const words = tokens.slice(lo, hi + 1).map(core);
  // "Continuous" is only capitalised because it starts the sentence
  if (lo === 0 && /^[A-Z][a-z]+$/.test(words[0])) words[0] = words[0].toLowerCase();
  return words.join(" ");
}

/** A note's term for `word`, from the first content sentence that uses it. */
function termInNote(note, word) {
  const sentence = sentenceFor(note, word);
  return sentence ? termFor(note, sentence, word) : word;
}

/** `sentence` with every occurrence of `term` (and a leftover lone `keyword`) blanked. */
export function blankTerm(sentence, term, keyword) {
  const words = term.split(/\s+/);
  let out = sentence.replace(phraseRe(words), "_____");
  // an acronym straight after the blank spells out the answer's initials
  if (words.length >= 2) out = out.replace(new RegExp(`_____\\s*\\(${initialsOf(words)}s?\\)`, "g"), "_____");
  // blank every occurrence, so a second mention can't give the answer away
  return out.replace(new RegExp(wholeWord(keyword).source, "gi"), "_____");
}

// Frequent-but-empty words TF-IDF can still rank highly. As an answer they make
// a question trivial or meaningless ("_____ device is attached" -> "every").
const GENERIC = new Set([
  "every", "one", "two", "three", "four", "five", "many", "much", "more", "most", "less", "least", "other",
  "another", "some", "any", "all", "both", "either", "neither", "first", "second", "last", "next", "new",
  "same", "different", "such", "used", "use", "uses", "using", "called", "based", "example", "examples",
  "following", "given", "general", "type", "types", "way", "ways", "thing", "things", "part", "parts",
  "number", "numbers", "set", "case", "cases", "time", "times", "unit", "page", "chapter", "section",
  "notes", "lecture", "semester", "department", "introduction", "summary", "figure", "table",
]);

function nounLikeKeywords(note) {
  // only keywords that are real content words AND appear, as whole words, in
  // at least one question-worthy sentence - otherwise there is nothing sound
  // to blank them out of
  const askable = note.keywords.filter(
    (k) => !GENERIC.has(k) && !/^\d+$/.test(k) && sentenceFor(note, k) !== null
  );
  const nouny = askable.filter((k) => hasNounEvidence(k, note.rawText));
  // only narrow the list when at least two remain (one easy, one hard band);
  // a note with almost no noun evidence keeps its askable keyword list.
  return nouny.length >= 2 ? nouny : askable;
}

function keywordForTier(note, tier, i) {
  const keywords = nounLikeKeywords(note);
  const n = keywords.length;
  if (n === 0) return null;
  const bandSize = Math.max(1, Math.ceil(n / 3));
  const start = tier === "easy" ? 0 : tier === "hard" ? Math.max(0, n - bandSize) : Math.floor((n - bandSize) / 2);
  const span = Math.min(bandSize, n - start);
  return keywords[start + (i % span)];
}

// Words ending like a verb form or adverb ("creating", "attracted", "quickly")
// are poor distractors for a noun answer like "electrons" - they read as
// wrong at a glance, which makes the question trivially easy. Distractors
// are matched to the answer's rough word shape instead.
function isVerbish(word) {
  return /(ing|ed|ly)$/.test(word);
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

/**
 * Pick up to 3 distractors for a cloze MCQ whose answer is `keyword`,
 * blanked out of `sentence` in `note`. Every tier applies the same hard
 * rules:
 *   - never a word that appears in the source sentence (it would make the
 *     blank arguably correct, or hand the student a giveaway),
 *   - never a word-shape mismatch with the answer (see isVerbish), nor a
 *     near-duplicate of it (shared stem).
 * Within those rules, candidates are tried best-first:
 *   1. other notes' keywords with noun-position evidence that don't occur
 *      in this note at all (clearly wrong, same register as the answer),
 *   2. any other note's keyword with noun-position evidence,
 *   3. any keyword from any note with noun-position evidence,
 *   4. any content word (5+ letters) from the subject's notes, likewise,
 *   5. any remaining keyword.
 * Only if a tiny corpus still can't supply 3 are clearly-labelled
 * placeholders used, so the question always has 4 unique options.
 */
function pickDistractors(note, notes, keyword, sentence, answer = keyword) {
  const sentenceNorm = normalize(sentence);
  const noteTextNorm = normalize(note.rawText);
  const corpusText = notes.map((n) => n.rawText).join(" ");
  const answerShape = isVerbish(keyword);

  // "atom" / "atoms" / "atomic" share a stem: as distractors for each other
  // they are near-duplicates that are unfair or confusing, so words sharing
  // a 4+ letter prefix with the answer are skipped.
  const sharesStem = (w) => w.slice(0, 4) === keyword.slice(0, 4);
  const usable = (w) =>
    w !== keyword &&
    !GENERIC.has(w) &&
    !/^\d+$/.test(w) &&
    !sharesStem(w) &&
    !sentenceNorm.includes(w) &&
    isVerbish(w) === answerShape;
  const noun = (w) => hasNounEvidence(w, corpusText);

  const otherNoteKeywords = [...new Set(notes.filter((n) => n !== note).flatMap((n) => n.keywords))];
  const allKeywords = [...new Set(notes.flatMap((n) => n.keywords))];
  const contentWords = [...new Set(tokenize(corpusText).filter((w) => w.length >= 5))];

  const tiers = [
    otherNoteKeywords.filter((w) => usable(w) && noun(w) && !noteTextNorm.includes(w)),
    otherNoteKeywords.filter((w) => usable(w) && noun(w)),
    allKeywords.filter((w) => usable(w) && noun(w)),
    contentWords.filter((w) => usable(w) && noun(w)),
    allKeywords.filter(usable),
  ];

  // Each candidate word is widened to its own whole term, from the note it
  // comes from, so a two-word answer isn't the only two-word option. Terms
  // as long as the answer are preferred, so length gives nothing away.
  const answerLength = answer.split(/\s+/).length;
  const sourceOf = (w) =>
    notes.find((n) => n !== note && n.keywords.includes(w)) ||
    notes.find((n) => n.keywords.includes(w)) ||
    notes.find((n) => wholeWord(w).test(n.rawText || ""));
  const asTerm = (w) => {
    const source = sourceOf(w);
    const term = source ? termInNote(source, w) : w;
    return term.split(/\s+/).some((x) => sentenceNorm.includes(x.toLowerCase())) && term !== w ? w : term;
  };

  const picked = [];
  for (const tier of tiers) {
    const terms = shuffle(tier)
      .map(asTerm)
      .map((term, i) => ({ term, i, gap: Math.abs(term.split(/\s+/).length - answerLength) }))
      .sort((a, b) => a.gap - b.gap || a.i - b.i)
      .map((x) => x.term);
    for (const t of terms) {
      if (picked.length === 3) break;
      if (normalize(t) === normalize(answer)) continue;
      // no two distractors that are forms of one word ("network"/"networks")
      if (!picked.some((x) => normalize(x).slice(0, 5) === normalize(t).slice(0, 5))) picked.push(t);
    }
  }
  for (let i = 1; picked.length < 3; i++) picked.push(`${keyword}-related term ${i}`);
  return picked;
}

// Which note should each successive question be drawn from?
//
// The original rule was strict round-robin (`notes[i % notes.length]`), which
// spreads questions evenly no matter how the student is doing. Once mastery
// exists, an even spread is the wrong default: a test is more useful when it
// leans toward what the student is weak on, or what we have least evidence
// about.
//
// `masteryMap` may be empty (a first-ever test, or generation with no student
// context), in which case every weight is equal and this degrades to exactly
// the old round-robin. Allocation uses largest-remainder so the per-note counts
// sum to `count` without drift, and every note is guaranteed at least one
// question whenever there are enough to go round - leaning toward weakness must
// not become ignoring a topic outright, or the student never gets the chance to
// show they have improved on it.
function weightedNoteOrder(notes, count, masteryMap) {
  if (notes.length === 0 || count <= 0) return [];
  if (!masteryMap || masteryMap.size === 0) {
    return Array.from({ length: count }, (_, i) => notes[i % notes.length]);
  }

  const weights = notes.map((n) => topicWeight(n._id, masteryMap));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const guaranteed = count >= notes.length ? 1 : 0;
  const spare = count - guaranteed * notes.length;

  const exact = weights.map((w) => guaranteed + (spare * w) / total);
  const alloc = exact.map((x) => Math.floor(x));
  let remaining = count - alloc.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; remaining > 0; k++, remaining--) alloc[byRemainder[k % notes.length].i] += 1;

  // Interleave rather than emitting one note's questions in a block, so the
  // adaptive walk meets a mix of topics as it steps through difficulty tiers.
  const order = [];
  const left = [...alloc];
  while (order.length < count) {
    let progressed = false;
    for (let i = 0; i < notes.length; i++) {
      if (left[i] > 0) { order.push(notes[i]); left[i] -= 1; progressed = true; }
      if (order.length === count) break;
    }
    if (!progressed) break;
  }
  return order;
}

/**
 * Choose a keyword for `note` at the wanted tier that hasn't already been
 * used for a question, so a small note can't produce the same blank twice.
 * If the wanted tier is exhausted it falls back to the nearest other tier
 * and reports that tier as the question's difficulty, so the label stays
 * honest. Returns null when the note has no unused keyword left.
 */
function pickUnusedKeyword(note, wantedTier, startIndex, used) {
  const wantedIdx = DIFFICULTY_TIERS.indexOf(wantedTier);
  const tiersNearestFirst = [...DIFFICULTY_TIERS].sort(
    (a, b) => Math.abs(DIFFICULTY_TIERS.indexOf(a) - wantedIdx) - Math.abs(DIFFICULTY_TIERS.indexOf(b) - wantedIdx)
  );
  for (const tier of tiersNearestFirst) {
    for (let offset = 0; offset < 12; offset++) {
      const keyword = keywordForTier(note, tier, startIndex + offset);
      if (keyword && !used.has(`${note._id}|${keyword}`)) return { keyword, difficulty: tier };
    }
  }
  return null;
}

function generateMcqFallback(notes, mcqCount, masteryMap) {
  const drafts = [];
  const used = new Set(); // "note id|keyword" already turned into a question
  const order = weightedNoteOrder(notes, mcqCount, masteryMap);

  for (let i = 0; i < mcqCount; i++) {
    const note = order[i] || notes[i % notes.length];
    const wanted = DIFFICULTY_TIERS[i % DIFFICULTY_TIERS.length];
    const picked = pickUnusedKeyword(note, wanted, Math.floor(i / notes.length), used);
    if (!picked) continue; // this note is out of distinct questions; don't repeat one
    const { keyword, difficulty } = picked;
    used.add(`${note._id}|${keyword}`);

    // nounLikeKeywords only offers keywords that have such a sentence
    const sentence = sentenceFor(note, keyword);
    if (!sentence) continue;
    // the answer is the whole term ("continuous integration"), not one word of it
    const answer = termFor(note, sentence, keyword);
    const blanked = blankTerm(sentence, answer, keyword);

    const options = shuffle([...pickDistractors(note, notes, keyword, sentence, answer), answer]);

    drafts.push({
      topicId: note._id,
      topic: labelOf(note),
      prompt: `Fill in the blank: "${blanked}"`,
      options,
      correctAnswer: answer,
      supportingExcerpt: sentence,
      difficulty,
    });
  }

  return drafts;
}

// ---------------------------------------------------------------------------
// Theory / short-answer generation
// ---------------------------------------------------------------------------

async function generateTheoryWithLLM(notes, theoryCount) {
  const context = buildContext(notes);
  const prompt = `You are drafting short-answer / theory questions for a student's self-test, using ONLY the notes below as source material. Each question should require a 1-4 sentence written explanation, not a single word. Aim for a roughly even mix of easy, medium, and hard questions across the set, and spread the questions across as many different ### sections as possible - each section is a separate topic the student is assessed on. Ask only about the subject matter itself - never about titles, headers, footers, page numbers, course codes, the table of contents, authors, references or other document metadata, and never quote such text as the supportingExcerpt.

NOTES:
${context}

Return a JSON array of exactly ${theoryCount} objects, each shaped like:
{
  "topic": "<the exact ### heading of the section this question is drawn from>",
  "prompt": "<the open-ended question text, e.g. 'Explain ...' or 'Why does ...'>",
  "modelAnswer": "<a concise 1-4 sentence model answer, grounded in the notes>",
  "keyPoints": ["<short key phrase a good answer should mention>", "<another key phrase>", "..."],
  "supportingExcerpt": "<a short verbatim quote from the notes above that supports the model answer>",
  "difficulty": "<one of: easy, medium, hard>"
}
Include 2 to 4 keyPoints per question. Return ONLY the JSON array, no other text.`;

  const raw = await callLLM(prompt);
  const parsed = parseJsonLoose(raw);
  if (!Array.isArray(parsed)) return null;
  return parsed;
}

// Zero-dependency fallback, same spirit as the MCQ cloze fallback: ask the
// student to explain a note's top TF-IDF keyword in their own words, and
// use that note's top keywords as the grading rubric (keyPoints) for the
// deterministic keyword-overlap grader in gradingEngine.js. Grounded by
// construction - the supporting excerpt IS the sentence the keyword came
// from. Difficulty uses the same tier-first keywordForTier scheme as the
// MCQ fallback.
function generateTheoryFallback(notes, theoryCount, masteryMap) {
  const drafts = [];
  const used = new Set();
  const order = weightedNoteOrder(notes, theoryCount, masteryMap);

  for (let i = 0; i < theoryCount; i++) {
    const note = order[i] || notes[i % notes.length];
    if (!note.keywords?.length) continue;
    if (!contentSentences(note).length) continue; // nothing but headings / page furniture

    const wanted = DIFFICULTY_TIERS[i % DIFFICULTY_TIERS.length];
    const picked = pickUnusedKeyword(note, wanted, Math.floor(i / notes.length), used);
    if (!picked) continue;
    const { keyword: primary, difficulty } = picked;
    used.add(`${note._id}|${primary}`);
    const keyPoints = [...new Set([primary, ...note.keywords.filter((k) => !GENERIC.has(k))])].slice(0, 4);

    const sentence = sentenceFor(note, primary);
    if (!sentence) continue;

    drafts.push({
      topicId: note._id,
      topic: labelOf(note),
      prompt: `In your own words, explain what your notes on "${note.title}" say about "${primary}".`,
      modelAnswer: sentence,
      keyPoints,
      supportingExcerpt: sentence,
      difficulty,
    });
  }

  return drafts;
}

// ---------------------------------------------------------------------------
// Shared grounding gate + orchestration
// ---------------------------------------------------------------------------

// An LLM excerpt is often a phrase rather than a full sentence, so it gets a
// lighter check than isQuestionWorthy: just not page furniture or a heading.
function isContentExcerpt(excerpt) {
  const e = String(excerpt || "").trim();
  if (BOILERPLATE.test(e)) return false;
  const words = e.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length >= 4 && words.filter((w) => /^[("']?[a-z]/.test(w)).length / words.length < 0.4) return false;
  return true;
}

function isValidDraft(d, type, contextText) {
  if (!d?.prompt || !isSupportedByContext(d.supportingExcerpt, contextText)) return false;
  if (!isContentExcerpt(d.supportingExcerpt)) return false; // grounded, but in a header / title / contents line
  if (type === "mcq") {
    if (!Array.isArray(d.options) || d.options.length < 2 || !d.options.includes(d.correctAnswer)) return false;
    // duplicate options (case/whitespace-insensitive) make a question
    // ambiguous or unfair, so they fail the gate like any other malformed item.
    return new Set(d.options.map(normalize)).size === d.options.length;
  }
  if (type === "theory") {
    return Boolean(d.modelAnswer?.trim()) && Array.isArray(d.keyPoints) && d.keyPoints.length > 0;
  }
  return false;
}

// Which note did this draft actually come from? The LLM is asked to name the
// note title, but a model that paraphrases or invents a title would silently
// mis-attribute the question - and topicId is what a student's mastery history
// is keyed on, so a wrong answer here corrupts the record rather than just
// mislabelling one item. The supporting excerpt is a stronger signal than the
// claimed title, because the hallucination gate has already verified it appears
// verbatim in the source: whichever note contains it IS the source note.
// Title match is the fallback, and only then the first note.
function resolveSourceNote(draft, notes) {
  const excerpt = normalize(draft?.supportingExcerpt);
  if (excerpt.length >= 8) {
    const byExcerpt = notes.find((n) => normalize(n.rawText).includes(excerpt));
    if (byExcerpt) return byExcerpt;
  }
  const claimed = normalize(draft?.topic).replace(/^#+\s*/, "");
  if (claimed) {
    const byTitle =
      notes.find((n) => normalize(labelOf(n)) === claimed) || notes.find((n) => normalize(n.title) === claimed);
    if (byTitle) return byTitle;
  }
  return notes[0];
}

function toQuestionItem(d, type, marksPerQuestion, notes, contextText, generatedBy) {
  const supported = isValidDraft(d, type, contextText);
  const sourceNote = resolveSourceNote(d, notes);
  const base = {
    type,
    // topicId is the durable key (a note id); topic is the human-readable
    // label shown in the UI and refreshed from the note on every generation.
    topicId: d?.topicId || sourceNote?._id || null,
    topic: labelOf(sourceNote) || d?.topic || "General",
    // For a subtopic of a split upload: which document it belongs to, so the
    // feedback can group "Paging" and "Segmentation" under "Unit 3".
    subtopic: sourceNote?.parentNoteId ? sourceNote.title : null,
    parentTopicId: sourceNote?.parentTopicId || null,
    parentTopic: sourceNote?.parentTopic || null,
    prompt: d?.prompt,
    supportingExcerpt: d?.supportingExcerpt,
    difficulty: normalizeDifficulty(d?.difficulty),
    marks: marksPerQuestion,
    status: supported ? "accepted" : "discarded",
    generatedBy,
  };
  if (type === "mcq") {
    return { ...base, options: d?.options, answerKey: d?.correctAnswer };
  }
  // theory: reuse the "answerKey" field name for the model answer so the
  // existing forAttemptTaking() strip in routes/attempts.js hides it for
  // free without needing type-specific logic there.
  return { ...base, answerKey: d?.modelAnswer, keyPoints: d?.keyPoints };
}

async function generateBatch({ notes, count, generateLLM, generateFallback, masteryMap }) {
  if (count <= 0) return { drafts: [], generatedBy: "none" };

  let drafts = null;
  let generatedBy = "rule-based-fallback";

  if (llmAvailable()) {
    drafts = await generateLLM(notes, count, masteryMap);
    if (drafts) generatedBy = "llm";
  }
  if (!drafts || drafts.length === 0) {
    drafts = generateFallback(notes, count, masteryMap);
    generatedBy = "rule-based-fallback";
  }
  return { drafts, generatedBy };
}

/**
 * Generate `mcqCount` MCQs and `theoryCount` theory questions grounded in
 * `notes`, then apply the shared hallucination gate to every draft. Each
 * accepted item carries a difficulty tier for adaptiveEngine.js to select
 * on. Callers should ask for more than they intend to deliver (see
 * routes/tests.js) so there's a real pool to be adaptive over.
 * Returns { accepted, discarded, mcqGeneratedBy, theoryGeneratedBy }.
 */
export async function generateQuestions(notes, { mcqCount = 0, theoryCount = 0, marksPerQuestion, masteryMap = new Map() }) {
  const contextText = buildContext(notes);
  const accepted = [];
  const discarded = [];

  const [mcqBatch, theoryBatch] = await Promise.all([
    generateBatch({ notes, count: mcqCount, generateLLM: generateMcqWithLLM, generateFallback: generateMcqFallback, masteryMap }),
    generateBatch({ notes, count: theoryCount, generateLLM: generateTheoryWithLLM, generateFallback: generateTheoryFallback, masteryMap }),
  ]);

  for (const [type, batch] of [
    ["mcq", mcqBatch],
    ["theory", theoryBatch],
  ]) {
    for (const d of batch.drafts) {
      const item = toQuestionItem(d, type, marksPerQuestion, notes, contextText, batch.generatedBy);
      (item.status === "accepted" ? accepted : discarded).push(item);
    }
  }

  return {
    accepted,
    discarded,
    mcqGeneratedBy: mcqCount > 0 ? mcqBatch.generatedBy : "none",
    theoryGeneratedBy: theoryCount > 0 ? theoryBatch.generatedBy : "none",
  };
}
