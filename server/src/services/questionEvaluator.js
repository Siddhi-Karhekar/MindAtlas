// The unified quality evaluation layer: one decision for every question,
// whoever wrote it (the AI, the rule-based writer, or the rules standing in
// for the AI). It runs AFTER the existing gates in testEngine.generateQuestions
// - grounding (the excerpt is in the notes), questionQuality.validateQuestion
// (~40 format and validity rules), reported questions and MCQ suitability -
// and adds what those do not check:
//
//   ambiguity     a vague qualifier with no criterion ("most important",
//                 "generally"); material the student is not given ("the
//                 figure above"); an abbreviation the notes never use; two
//                 options that mean the same ("LAN" and "Local Area Network");
//                 a wrong option the notes ALSO make true (filled into the
//                 blank or put as the subject it gives a sentence the notes
//                 say); a wrong option that is a kind of the answer, or the
//                 answer a kind of it ("SHA-2" beside "SHA-512")
//   computation   a numerical question's answer is worked out again from its
//                 formula, and no wrong option may equal it
//   checker       the AI checker's verdict, when it ran (testEngine
//                 verifyWithLLM): it answers each question from the source on
//                 its own, and a different answer, a second defensible
//                 option, missing context, or "better as theory" rejects
//
// Each of those is a HARD rule: one failure rejects. Softer qualities are
// scored from 0 to 1 and combined (weights below); a question below
// ACCEPT_SCORE is rejected as `quality:low-score`, and one whose wrong
// options score below WEAK_DISTRACTORS as `distractors:weak`.
//
//   importance    the source sentence's question-worthiness (worthiness.js)
//                 and whether the answer is one of the note's key terms
//   suitability   how sure the classifier is that the source suits this type
//   clarity       one question, a stem of sensible length, no double negative
//   correctness   how the key was established: recomputed or confirmed by
//                 the checker (1), checked against the passage (0.85), only
//                 the writer's word (0.7)
//   distractors   each wrong option: same form as the answer, the same kind
//                 of thing (conceptRelations.kinship), similar length, from
//                 the subject
//   uniqueness    wrong options not named in the very passage that supports
//                 the answer
//   cognitive     recall < understand < apply / analyse
//   difficulty    the label fits the level ("hard" recall is mislabelled)
//   novelty       not a near-copy of a question the student had before
//   originality   the stem is not the source sentence copied
//
// Returned as { decision: "accept" | "revise" | "reject", score, criteria,
// problems: [{ code, severity, detail }], cognitiveLevel, question } where
// `question` carries any repair (decision "revise": accepted after a safe
// rewording, e.g. "best describes" -> "describes"). Stored with every question
// (`quality`) so the admin page and the evaluation scripts can read it.
//
// The weights and thresholds are provisional. They are not ground truth:
// docs/QUESTION_QUALITY.md describes calibrating them on human-rated
// questions (`npm run eval:benchmark`).

import { stem, tokenize } from "./tfidf.js";
import { classifyText } from "./suitability.js";
import { normalizeText } from "./questionQuality.js";
import { isHypernymPair, kinship } from "./conceptRelations.js";
import { termKey, termPattern } from "./keyTerms.js";
import { recompute } from "./numerical.js";

export const EVALUATOR_VERSION = "eval-v1";
const envNumber = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : fallback;
};
export const ACCEPT_SCORE = () => envNumber("QUALITY_MIN_SCORE", 0.55);
export const WEAK_DISTRACTORS = () => envNumber("QUALITY_MIN_DISTRACTORS", 0.45);

const WEIGHTS = {
  importance: 0.2,
  suitability: 0.1,
  grounding: 0.05,
  clarity: 0.1,
  correctness: 0.15,
  distractors: 0.2,
  uniqueness: 0.08,
  cognitive: 0.05,
  difficulty: 0.02,
  novelty: 0.02,
  originality: 0.03,
};
const THEORY_WEIGHTS = { importance: 0.3, suitability: 0.15, grounding: 0.1, clarity: 0.2, cognitive: 0.15, difficulty: 0.05, novelty: 0.05 };

const BLANK = /_{3,}/g;
const HAS_BLANK = /_{3,}/;
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const stemsOf = (s) => new Set(tokenize(String(s ?? "")).map(stem));
const round = (x) => Number(Math.max(0, Math.min(1, x)).toFixed(3));
const share = (part, whole) => {
  if (!part.size) return 0;
  let n = 0;
  for (const w of part) if (whole.has(w)) n++;
  return n / part.size;
};
// stems in order, in pairs: "decreasing to increasing" and "increasing to
// decreasing" share every word and no pair
const bigramsOf = (s) => {
  const w = tokenize(String(s ?? "")).map(stem);
  return new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`));
};
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
};

// ---- what the whole build's notes provide, computed once per build
/**
 * Everything the evaluator compares against, built once per test build:
 *   contextText  everything a question may quote
 *   sentences    the study sentences of every note ({ text, suit, worth })
 *   terms        the notes' key terms
 *   relations    conceptRelations.buildRelations
 *   avoid        the student's earlier questions on these notes
 */
export function evaluationContext({ contextText = "", sentences = [], terms = [], relations = null, avoid = [], similarity = null, worthyAnswers = null } = {}) {
  const termByKey = new Map(terms.map((t) => [t.key, t]));
  const acronyms = new Map();
  for (const t of terms) if (t.abbr) acronyms.set(t.abbr.toUpperCase(), t.key);
  return {
    contextText,
    contextNorm: ` ${normalizeText(contextText)} `,
    // the raw text, for case-sensitive look-ups (abbreviations)
    contextRaw: String(contextText),
    vocabulary: stemsOf(contextText),
    // optional: (a, b) -> cosine of their meaning, when the embedding model ran
    similarity,
    worthyAnswers,
    sentences: sentences.map((s) => ({ ...s, norm: normalizeText(s.text), stems: stemsOf(s.text), bigrams: bigramsOf(s.text) })),
    termByKey,
    acronyms,
    relations,
    avoid: avoid.slice(-150).map((p) => stemsOf(p)),
  };
}

// an option as a term key, the way keyTerms.js writes keys ("SHA-2" -> "sha-2")
const keyOf = (option) =>
  termKey(
    String(option ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 /+-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

// ---- the cognitive level a question tests
const LEVELS = ["recall", "understand", "apply", "analyse"];
const LEVEL_VALUE = { recall: 0.5, understand: 0.75, apply: 0.95, analyse: 0.95 };
export function cognitiveLevelOf(q, type) {
  const p = clean(q?.prompt);
  if (LEVELS.includes(q?.cognitiveLevel)) return q.cognitiveLevel;
  if (type === "theory") {
    if (/^(?:define|state|list|name|mention|enumerate)\b/i.test(p) && !/\bexplain\b/i.test(p)) return "recall";
    if (/^(?:differentiate|distinguish|compare|contrast|why|justify|analy[sz]e|evaluate|examine)\b|\bhow does\b/i.test(p)) return "analyse";
    if (/^write the (?:steps|algorithm|procedure|method)\b/i.test(p)) return "apply";
    return "understand";
  }
  if (q?.form === "numerical" || q?.computation) return "apply";
  if (q?.form === "cloze" || q?.form === "acronym" || /^fill in the blank\b|\bstand for\b/i.test(p)) return "recall";
  if (/\bwhy\b|\bwhat (?:happens|would happen|will happen)\b|\bsuppose\b|\bconsider\b|\bgiven\b|\bif\b.*\b(?:then|which|what)\b|\bscenario\b/i.test(p)) return "apply";
  if (/\b(?:differs?|difference|distinguish|compared? (?:to|with))\b/i.test(p)) return "analyse";
  return "understand";
}

// ---- ambiguity in the stem
// "best describes" is safe to drop when exactly one option is right; "most
// important" and "generally" have no criterion the student could apply.
const REPAIRABLE_BEST = /\b(?:best|most accurately|most closely)\s+(describes?|defines?|explains?|represents?|matches|completes?|characteri[sz]es|summari[sz]es|described|defined|explained|represented)\b/gi;
// evaluative words with no stated criterion: which option is "best" is a matter of opinion
const VAGUE = /\b(?:best(?!-)|most important|most suitable|most appropriate|most likely|most significant|most efficient|most effective|most difficult|least important|hardest|easiest|worst|ideal(?:ly)?|preferred|recommended|mainly|primarily|in general)\b/i;
// frequency words: a statement that only holds "usually" is weaker ground for one right answer
const HEDGED = /\b(?:generally|usually|typically|often|commonly|normally|in most cases|sometimes)\b/i;
// "A decrypts the session key ...": a letter standing for a person or process the student is never introduced to
const UNNAMED_ACTOR = /(?:^|[.;:,]\s+|"|\band\s+)(?:[A-Z]|[A-Z]\d)\s+(?!is\b|are\b|was\b|has\b)[a-z]{3,}s\b/;
const MISSING_MATERIAL =
  /\b(?:the (?:above|below|following|given|shown) (?:figure|diagram|table|graph|chart|circuit|code|program|snippet|passage|paragraph|example|statement|scenario)|(?:shown|given) (?:above|below)|in the (?:figure|diagram|image|picture|table above)|according to the (?:passage|notes|text|author|lecture)|(?:the|your|these) notes|this (?:passage|paragraph|text|chapter)|as (?:discussed|mentioned|stated) (?:above|earlier|before))\b/i;
const NOT_ABBREVIATIONS = new Set("NOT EXCEPT TRUE FALSE ALL NONE AND OR NO YES II III IV VI VII VIII IX XI XII OK".split(" "));

function stemProblems(q, ctx, type, problems) {
  let prompt = clean(q?.prompt);
  // repair first: "Which of the following best describes ..." -> "... describes ..."
  const repaired = prompt.replace(REPAIRABLE_BEST, "$1");
  const revised = repaired !== prompt;
  prompt = repaired;
  const asked = prompt.replace(/^fill in the blank:\s*/i, "");
  if (VAGUE.test(asked)) problems.push({ code: "ambiguity:vague-qualifier", severity: "hard", detail: asked.match(VAGUE)[0] });
  if (UNNAMED_ACTOR.test(asked) && !/\b(?:user|process|node|host|station|party|sender|receiver|client|server|transaction|resource|thread|router|task|job)s?\s+[A-Z]\d?\b/i.test(asked)) {
    problems.push({ code: "context:unnamed-actor", severity: "hard", detail: asked.match(UNNAMED_ACTOR)[0].trim() });
  }
  // code in backticks makes "the following code" fine; nothing else does
  const mm = asked.match(MISSING_MATERIAL);
  if (mm && !(/code|program|snippet/i.test(mm[0]) && /`[^`]+`/.test(asked))) problems.push({ code: "context:missing-material", severity: "hard", detail: mm[0] });
  if ((asked.match(/\?/g) || []).length > 1) problems.push({ code: "clarity:two-questions", severity: "hard" });
  // an abbreviation the notes never use: the student cannot know what it stands for
  for (const a of new Set(asked.replace(/\$[^$]*\$|`[^`]*`/g, " ").match(/\b[A-Z][A-Z0-9]{1,6}s?\b/g) || [])) {
    const bare = a.replace(/s$/, "");
    // "P1", "R2", "T1": names a question gives the things in its own scenario
    if (NOT_ABBREVIATIONS.has(bare) || /^[IVX]+$/.test(bare) || /^[A-Z]\d{1,2}$/.test(bare)) continue;
    if (!new RegExp(`(?<![A-Za-z0-9])${bare}`).test(ctx.contextRaw)) problems.push({ code: "context:undefined-abbreviation", severity: "hard", detail: bare });
  }
  // a name the notes never mention ("designed by Ron Rivest"): a fact from
  // outside the notes, which the student was never given
  for (const m of asked.replace(/\$[^$]*\$|`[^`]*`|“[^”]*”|"[^"]*"/g, " ").matchAll(/(?<![.?!:]\s|^)\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
    if (!ctx.contextNorm.includes(` ${normalizeText(m[1])} `)) problems.push({ code: "grounding:unsupported-name", severity: "hard", detail: m[1] });
  }
  const negations = (asked.match(/\b(?:not|never|no|none|cannot|except)\b|n't\b/gi) || []).length;
  const soft = [];
  if (negations >= 2) soft.push("double-negative");
  if (HEDGED.test(asked)) soft.push("hedged");
  const words = asked.split(/\s+/).length;
  if (words > (type === "theory" ? 70 : 55)) soft.push("long-stem");
  if (type === "mcq" && words < 5) soft.push("short-stem");
  for (const s of soft) problems.push({ code: `clarity:${s}`, severity: "soft" });
  return { prompt, revised, clarity: round(1 - 0.25 * soft.length) };
}

// ---- options that are the same answer, or can both be defended
const initials = (s) =>
  clean(s)
    .split(/[\s-]+/)
    .filter((w) => w && !/^(?:of|and|the|for|in|on|to|a|an)$/i.test(w))
    .map((w) => w[0])
    .join("")
    .toUpperCase();
function equivalentOptions(a, b, ctx) {
  const [x, y] = [clean(a), clean(b)];
  if (!x || !y) return false;
  const acr = (s) => /^[A-Z][A-Z0-9]{1,7}s?$/.test(s);
  for (const [short, long] of [[x, y], [y, x]]) {
    if (acr(short) && !acr(long) && long.split(/\s+/).length >= 2) {
      const bare = short.replace(/s$/, "");
      if (initials(long) === bare || ctx.acronyms.get(bare) === keyOf(long)) return true;
    }
  }
  // the same words in another order or form ("encrypting data" / "data encryption")
  const [sa, sb] = [stemsOf(x), stemsOf(y)];
  return sa.size >= 2 && sa.size === sb.size && [...sa].every((w) => sb.has(w));
}

// The notes say something with a WRONG option in the right one's place.
function alsoTrueInNotes(q, ctx, form) {
  const answer = clean(q.answerKey);
  const others = (q.options || []).map(clean).filter((o) => o && o !== answer);
  const prompt = clean(q.prompt);
  const excerpt = normalizeText(q.supportingExcerpt);
  const hits = [];
  const blank = prompt.match(/"([^"]*_{3,}[^"]*)"/)?.[1] || (HAS_BLANK.test(prompt) ? prompt.replace(/^fill in the blank:\s*/i, "") : null);
  if (blank) {
    for (const o of others) {
      const text = blank.replace(/\ba\(n\)(?=\s)/gi, "a").replace(BLANK, ` ${o} `);
      const filled = stemsOf(text);
      const pairs = bigramsOf(text);
      const oPat = termPattern(o, "i");
      for (const s of ctx.sentences) {
        if (s.norm === excerpt || !oPat.test(s.text)) continue;
        // the filled statement is (almost) wholly something else the notes say
        if (share(filled, s.stems) >= 0.9 && share(pairs, s.bigrams) >= 0.75) hits.push({ option: o, sentence: s.text });
      }
    }
    return hits;
  }
  // "Which of the following <predicate>?": a wrong option the notes give the same predicate
  // "Which of the following <predicate>?", "Which protocol <predicate>?"
  const pred = prompt.match(/^which (?:one )?of the following\s+(.+?)\??$/i)?.[1] || prompt.match(/^which\s+(?!of\b)[a-z-]+(?:\s+[a-z-]+)?\s+((?:is|are|was|can|does|do|has|have|provides?|uses?|produces?|ensures?|allows?|connects?|maps?|stores?|handles?|delivers?|offers?|spans?|controls?|carries|carry)\b.+?)\??$/i)?.[1];
  if (pred && form !== "numerical") {
    const need = stemsOf(pred);
    const needPairs = bigramsOf(pred);
    if (need.size >= 3) {
      for (const o of others) {
        const oStems = stemsOf(o);
        const oPat = termPattern(o, "i");
        for (const s of ctx.sentences) {
          if (s.norm === excerpt || !oPat.test(s.text)) continue;
          const rest = new Set([...s.stems].filter((w) => !oStems.has(w)));
          if (share(need, rest) >= 0.75 && (needPairs.size < 2 || share(needPairs, s.bigrams) >= 0.6)) hits.push({ option: o, sentence: s.text });
        }
      }
    }
  }
  // "Which of the following describes X?": a wrong description the notes also give X
  if (form === "describe" && q.concept) {
    const t = ctx.termByKey.get(q.concept);
    const tPat = t ? termPattern(t.term, "i") : null;
    if (tPat) {
      for (const o of others) {
        const need = stemsOf(o);
        const pairs = bigramsOf(o);
        if (need.size < 3) continue;
        for (const s of ctx.sentences) if (tPat.test(s.text) && share(need, s.stems) >= 0.75 && (pairs.size < 2 || share(pairs, s.bigrams) >= 0.6)) hits.push({ option: o, sentence: s.text });
      }
    }
  }
  return hits;
}

// Nouns that name what their members are called: a layer is "the ... layer",
// a key "the ... key". A "Which layer ...?" stem whose options contain no
// layer at all ("port numbers") asks for one thing and offers another.
// (Not "condition", "algorithm", "property": "circular wait" is a condition,
// "quicksort" an algorithm, without saying so.)
const CATEGORY_NOUNS = new Set("layer topology key attack address register lock network".split(" ").map((w) => stem(w)));

// ---- wrong options
const shapeOf = (s) => (/^[-+]?\d+(?:\.\d+)?$/.test(clean(s)) ? "number" : /\d/.test(s) || /^[A-Z0-9/+.-]{2,}$/.test(clean(s)) ? "code" : clean(s).split(/\s+/).length > 4 ? "statement" : clean(s).split(/\s+/).length > 1 ? "phrase" : "word");
function distractorQuality(q, ctx, problems) {
  const answer = clean(q.answerKey);
  const others = (q.options || []).map(clean).filter((o) => o && o !== answer);
  if (!others.length) return 0;
  if (q.computation) return 0.9; // numbers from typical slips (numerical.js)
  const aKey = keyOf(answer);
  const implausible = new Set(q.verification?.status === "checked" ? q.verification.implausible || [] : []);
  const scores = others.map((o) => {
    const shape = shapeOf(o) === shapeOf(answer) ? 1 : 0;
    const oKey = keyOf(o);
    const statement = shapeOf(o) === "statement" || shapeOf(answer) === "statement";
    // in the notes as written (1); made of the notes' words (0.6); from
    // outside them (0.3) - fine for a real neighbouring concept, but no
    // evidence that it is one
    const stems = [...stemsOf(o)];
    const grounded = ctx.contextNorm.includes(` ${normalizeText(o)} `) ? 1 : stems.length && stems.every((w) => ctx.vocabulary.has(w)) ? 0.6 : 0.3;
    let kin = statement ? 0.6 : kinship(ctx.relations, aKey, oKey);
    // with the embedding model: how close in meaning the option is to the
    // answer - an unrelated word ("banana") is far, a synonym too near
    const sim = ctx.similarity ? ctx.similarity(answer, o) : null;
    if (typeof sim === "number" && kin === 0.5) kin = sim > 0.9 ? 0.3 : sim >= 0.35 ? 0.8 : sim >= 0.2 ? 0.5 : 0.1;
    const ratio = Math.max(o.length, 1) / Math.max(answer.length, 1);
    const len = ratio >= 0.5 && ratio <= 2 ? 1 : ratio >= 0.33 && ratio <= 3 ? 0.5 : 0;
    const score = 0.25 * shape + 0.4 * kin + 0.2 * len + 0.15 * grounded;
    // the AI checker found it implausible: no knowledgeable student would pick it
    return implausible.has(o) ? Math.min(score, 0.3) : score;
  });
  if (implausible.size >= 2) problems.push({ code: "verify:implausible-distractors", severity: "hard", detail: [...implausible].join(" / ") });
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (scores.filter((s) => s < 0.45).length >= 2) problems.push({ code: "distractors:implausible", severity: "soft", detail: `${scores.filter((s) => s < 0.45).length} weak` });
  return round(avg);
}

const sentenceFor = (excerpt, ctx) => {
  const e = normalizeText(excerpt);
  if (e.length < 8) return null;
  return ctx.sentences.find((s) => s.norm.includes(e) || (e.length > 30 && e.includes(s.norm))) || null;
};

/**
 * Evaluate one question that has passed the existing gates. `q` is the stored
 * shape (prompt, options, answerKey, supportingExcerpt, difficulty, form,
 * concept, generatedBy, computation?, verification?); `ctx` from
 * evaluationContext().
 */
export function evaluateQuestion(q, ctx, { type = q?.type } = {}) {
  const problems = [];
  const { prompt, revised, clarity } = stemProblems(q, ctx, type, problems);
  const question = { ...q, prompt };
  const source = sentenceFor(q.supportingExcerpt, ctx);
  const own = classifyText(q.supportingExcerpt || "");
  const level = cognitiveLevelOf(q, type);
  const criteria = { grounding: 1, clarity };

  // importance: is this worth asking (the source), and is the answer a key term
  const worth = source?.worth?.score ?? 0.6;
  criteria.importance = round(type === "mcq" ? 0.7 * worth + 0.3 * (ctx.termByKey.has(q.concept) || ctx.termByKey.has(keyOf(q.answerKey)) ? 1 : 0.5) : worth);
  criteria.cognitive = LEVEL_VALUE[level];
  criteria.difficulty = (level === "recall" && q.difficulty === "hard") || (level === "analyse" && q.difficulty === "easy") ? 0.5 : 1;
  const novelty = ctx.avoid.length ? 1 - Math.max(...ctx.avoid.map((a) => jaccard(a, stemsOf(prompt)))) : 1;
  criteria.novelty = round(novelty);

  if (type === "mcq") {
    const answer = clean(q.answerKey);
    const others = (q.options || []).map(clean).filter((o) => o && o !== answer);

    // a numerical question: the answer is worked out again here
    let computed = false;
    if (q.form === "numerical" || q.computation) {
      const again = recompute(q.computation);
      if (!again) problems.push({ code: "computation:cannot-recompute", severity: "hard" });
      else if (again !== answer) problems.push({ code: "computation:wrong-key", severity: "hard", detail: `${answer} != ${again}` });
      else if (others.includes(again)) problems.push({ code: "computation:distractor-equals-answer", severity: "hard" });
      else computed = true;
    }
    criteria.suitability = computed ? 1 : own.mcq ? own.confidence : 0.3;

    for (let i = 0; i < (q.options || []).length; i++) {
      for (let j = i + 1; j < q.options.length; j++) {
        if (equivalentOptions(q.options[i], q.options[j], ctx)) problems.push({ code: "mcq:equivalent-options", severity: "hard", detail: `${q.options[i]} / ${q.options[j]}` });
      }
    }
    // "Which layer ...?" answered with "port numbers": the options are not what the stem asks for
    const asksFor = prompt.match(/^which\s+(?!of\b|one\b|statement\b|option\b)([a-z-]+)\b/i)?.[1]?.toLowerCase();
    if (asksFor && CATEGORY_NOUNS.has(stem(asksFor))) {
      const codes = (q.options || []).every((o) => shapeOf(o) === "code" || shapeOf(o) === "word");
      const fits = (q.options || []).filter((o) => stemsOf(o).has(stem(asksFor))).length;
      if (!codes && fits === 0 && !stemsOf(answer).has(stem(asksFor))) problems.push({ code: "mcq:options-do-not-fit-stem", severity: "hard", detail: asksFor });
    }
    // a one-word answer the notes only happen to repeat ("sum", "device",
    // "stack"): frequency is not importance, and blanking it tests reading
    if (ctx.worthyAnswers && !computed && !/\s/.test(answer) && !/^[A-Z0-9][A-Z0-9/+.-]*$/.test(answer) && /^[a-z-]+$/i.test(answer) && !ctx.worthyAnswers.has(keyOf(answer))) {
      problems.push({ code: "importance:trivial-answer", severity: "hard", detail: answer });
    }
    const aKey = keyOf(answer);
    for (const o of others) if (isHypernymPair(ctx.relations, aKey, keyOf(o))) problems.push({ code: "mcq:option-overlaps-answer", severity: "hard", detail: o });
    // "Which of the following belongs to the SHA-2 family?" when the notes put
    // a wrong option in that family too
    const parents = (k) => [...(ctx.relations?.parentsOf.get(k) || [])];
    const inStem = (p) => termPattern(ctx.termByKey.get(p)?.term || p, "i").test(prompt);
    for (const o of others) {
      const shared = parents(aKey).filter((p) => parents(keyOf(o)).includes(p) && inStem(p));
      if (shared.length) problems.push({ code: "mcq:another-option-also-correct", severity: "hard", detail: `${o} (also ${shared[0]})` });
    }
    // "separate shared key" beside "shared secret key": most of the words, and the
    // same main noun - a student may read them as one thing
    const near = others.filter((o) => {
      const [x, y] = [aKey.split(" "), keyOf(o).split(" ")];
      if (x.length < 2 || y.length < 2 || x.at(-1) !== y.at(-1)) return false;
      const shared = x.filter((w) => y.includes(w)).length;
      const dx = x.filter((w) => !y.includes(w));
      const dy = y.filter((w) => !x.includes(w));
      // "symmetric" / "asymmetric", "blocking" / "non-blocking": opposites, the point of the question
      const opposite = dx.some((a) => dy.some((b) => a === `a${b}` || b === `a${a}` || a.replace(/^(?:non-?|un|in|a)/, "") === b || b.replace(/^(?:non-?|un|in|a)/, "") === a));
      return shared >= 2 && shared >= Math.min(x.length, y.length) - 1 && !opposite;
    });
    if (near.length) problems.push({ code: "uniqueness:near-synonym-option", severity: "soft", detail: near.join(" / ") });
    if (!computed) for (const h of alsoTrueInNotes(q, ctx, q.form)) problems.push({ code: "mcq:another-option-also-correct", severity: "hard", detail: h.option });

    // the independent AI checker, when it ran
    const v = q.verification;
    if (v?.status === "checked") {
      if (v.ambiguous) problems.push({ code: "verify:ambiguous", severity: "hard", detail: v.reason || null });
      if (v.format === "theory") problems.push({ code: "verify:better-as-theory", severity: "hard", detail: v.reason || null });
      if (v.defensible?.length > 1) problems.push({ code: "verify:multiple-correct", severity: "hard", detail: v.defensible.join(",") });
      if (v.answer && v.answer !== answer) problems.push({ code: "verify:key-mismatch", severity: "hard", detail: v.answer });
    }
    const agreed = v?.status === "checked" && v.answer === answer;
    criteria.correctness = computed || agreed ? 1 : q.generatedBy === "llm" ? 0.7 : 0.85;

    criteria.distractors = distractorQuality(q, ctx, problems);
    // wrong options the supporting passage itself names: often co-correct, or a giveaway
    const excerpt = ` ${normalizeText(q.supportingExcerpt)} `;
    const named = HAS_BLANK.test(prompt) ? 0 : others.filter((o) => normalizeText(o).length > 2 && excerpt.includes(` ${normalizeText(o)} `)).length;
    criteria.uniqueness = round(1 - 0.25 * named - 0.25 * near.length);
    if (named) problems.push({ code: "uniqueness:option-in-source", severity: "soft", detail: `${named}` });
    // how much of the stem is the source sentence copied
    const stemWords = stemsOf(prompt.replace(/^fill in the blank:\s*/i, ""));
    criteria.originality = round(1 - share(stemWords, stemsOf(q.supportingExcerpt)));
  } else {
    criteria.suitability = own.mcq ? 0.8 : 1; // theory-only material is what theory is for
    // answerable from the notes: what the AI says a full answer contains must
    // be in them (the rules' model answers are the notes' own sentences)
    if (q.generatedBy === "llm") {
      const model = stemsOf(q.answerKey);
      if (model.size >= 3 && share(model, ctx.vocabulary) < 0.75) problems.push({ code: "theory:answer-unsupported", severity: "hard", detail: String(Number(share(model, ctx.vocabulary).toFixed(2))) });
      const missing = (q.keyPoints || []).filter((k) => {
        const w = stemsOf(k);
        return w.size && share(w, ctx.vocabulary) < 0.6;
      });
      if (missing.length) problems.push({ code: "theory:key-point-unsupported", severity: "hard", detail: missing.join(" / ").slice(0, 120) });
    }
  }

  const weights = type === "mcq" ? WEIGHTS : THEORY_WEIGHTS;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const score = round(Object.entries(weights).reduce((t, [k, w]) => t + w * (criteria[k] ?? 1), 0) / total);
  if (type === "mcq" && criteria.distractors < WEAK_DISTRACTORS()) problems.push({ code: "distractors:weak", severity: "hard", detail: String(criteria.distractors) });
  if (score < ACCEPT_SCORE()) problems.push({ code: "quality:low-score", severity: "hard", detail: String(score) });
  const hard = problems.filter((p) => p.severity === "hard");
  const decision = hard.length ? "reject" : revised ? "revise" : "accept";
  return {
    decision,
    score,
    criteria: Object.fromEntries(Object.entries(criteria).map(([k, v]) => [k, round(v)])),
    problems,
    cognitiveLevel: level,
    sourceKind: q.computation ? "formula" : own.kind,
    classification: { kind: own.kind, confidence: own.confidence, reason: own.reason, role: own.role },
    question,
    version: EVALUATOR_VERSION,
  };
}
