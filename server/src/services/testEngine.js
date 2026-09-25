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
  const prompt = `You are drafting multiple-choice questions for a student's self-test, using ONLY the notes below as source material. Do not use any outside knowledge - every question's correct answer must be directly supported by a verbatim short excerpt from these notes. Aim for a roughly even mix of easy, medium, and hard questions across the set, and spread the questions across as many different ### sections as possible - each section is a separate topic the student is assessed on.

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

function nounLikeKeywords(note) {
  const nouny = note.keywords.filter((k) => hasNounEvidence(k, note.rawText));
  // only narrow the list when at least two remain (one easy, one hard band);
  // a note with almost no noun evidence keeps its full keyword list.
  return nouny.length >= 2 ? nouny : note.keywords;
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
function pickDistractors(note, notes, keyword, sentence) {
  const sentenceNorm = normalize(sentence);
  const noteTextNorm = normalize(note.rawText);
  const corpusText = notes.map((n) => n.rawText).join(" ");
  const answerShape = isVerbish(keyword);

  // "atom" / "atoms" / "atomic" share a stem: as distractors for each other
  // they are near-duplicates that are unfair or confusing, so words sharing
  // a 4+ letter prefix with the answer are skipped.
  const sharesStem = (w) => w.slice(0, 4) === keyword.slice(0, 4);
  const usable = (w) =>
    w !== keyword && !sharesStem(w) && !sentenceNorm.includes(w) && isVerbish(w) === answerShape;
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

  const picked = [];
  for (const tier of tiers) {
    for (const w of shuffle(tier)) {
      if (picked.length === 3) break;
      if (!picked.includes(w)) picked.push(w);
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

    const sentences = note.rawText.split(/(?<=[.!?])\s+/);
    const sentence = sentences.find((s) => normalize(s).includes(keyword)) || sentences[0] || note.rawText;
    const blanked = sentence.replace(new RegExp(keyword, "i"), "_____");

    const options = shuffle([...pickDistractors(note, notes, keyword, sentence), keyword]);

    drafts.push({
      topicId: note._id,
      topic: labelOf(note),
      prompt: `Fill in the blank: "${blanked}"`,
      options,
      correctAnswer: keyword,
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
  const prompt = `You are drafting short-answer / theory questions for a student's self-test, using ONLY the notes below as source material. Each question should require a 1-4 sentence written explanation, not a single word. Aim for a roughly even mix of easy, medium, and hard questions across the set, and spread the questions across as many different ### sections as possible - each section is a separate topic the student is assessed on.

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

    const wanted = DIFFICULTY_TIERS[i % DIFFICULTY_TIERS.length];
    const picked = pickUnusedKeyword(note, wanted, Math.floor(i / notes.length), used);
    if (!picked) continue;
    const { keyword: primary, difficulty } = picked;
    used.add(`${note._id}|${primary}`);
    const keyPoints = [...new Set([primary, ...note.keywords])].slice(0, 4);

    const sentences = note.rawText.split(/(?<=[.!?])\s+/);
    const sentence = sentences.find((s) => normalize(s).includes(primary)) || sentences[0] || note.rawText;

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

function isValidDraft(d, type, contextText) {
  if (!d?.prompt || !isSupportedByContext(d.supportingExcerpt, contextText)) return false;
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
