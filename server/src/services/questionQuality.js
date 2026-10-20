// The quality gate every question passes before a student sees it, whoever
// wrote it: the LLM, the rule-based generator, or the rules filling in for an
// LLM that failed. One schema, one set of checks (testEngine.js runs it on
// every draft after the grounding check).
//
// What is checked, and why each check exists:
//   clarity       the question is a real question: long enough, no leftover
//                 template text, balanced quotes and brackets, no doubled words
//   context       nothing the student has not been given: a question (or the
//                 sentence a blank sits in) may not open with "It", "This",
//                 "They", "These" ... - words that point back to a sentence
//                 the student never sees ("It has _____ feature.")
//   meaningful    a blank hides a concept: never an article, a preposition, a
//   blank         generic word or a verb form; one to six words
//   MCQ validity  exactly four distinct options; one correct answer that is
//                 one of them; no "all / none of the above"; no option inside
//                 another ("key" beside "public key"); the answer not printed
//                 in the question; no option that stands out by length or form
//   ambiguity     a wrong option put into the blank must not give a sentence
//                 the notes also say - then it would be right too
//   correctness   the answer is in the passage that supports it
//   alignment     the stored answer is exactly one of the options, after any
//                 repair and shuffle
//   theory        opens with a command word, names what it asks about, is not
//                 vague ("Explain the differences."), has a model answer and
//                 distinct key points
//   difficulty    one of easy / medium / hard
//
// Small faults are repaired (spacing, an answer differing from its option
// only in case, a fifth option, an unknown difficulty); anything else is
// rejected with the reasons, and the question is stored as discarded.

import { GENERIC, isContentWord, termKey } from "./keyTerms.js";
import { stem, tokenize } from "./tfidf.js";

const DIFFICULTIES = ["easy", "medium", "hard"];
const BLANK = /_{3,}/g;

export const normalizeText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[“”"‘’'`]/g, "")
    .replace(/[^\p{L}\p{N}_ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---- formatting
// What an LLM (or a PDF) can leave in a question that must never reach the
// screen: control characters (a "\frac" read as a form feed), HTML, entities,
// escapes printed as text ("\n", "\u00e9"), and formulas or code whose
// delimiters do not close. Small things are repaired; the rest rejects.
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
export function repairFormatting(text) {
  return String(text ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|span|b|strong|i|em|u|sup|sub|code|pre)(?:\s[^>]*)?>/gi, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e])
    // control characters (intended: "\frac" read as form feed + "rac")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/** The formatting faults of one piece of text, as reasons. */
export function formattingProblems(text) {
  const t = String(text ?? "");
  const reasons = [];
  // a "$" that opens a formula and never closes (prices like "$5" are not formulas)
  const dollars = (t.replace(/\\\$/g, "").match(/\$/g) || []).length;
  if (dollars % 2 && /\$[^$]*[\\^_{}=]/.test(t)) reasons.push("format:unclosed-formula");
  if ((t.match(/```/g) || []).length % 2 || (t.replace(/```/g, "").match(/`/g) || []).length % 2) reasons.push("format:unclosed-code");
  if (/\\[ntr](?![a-z])|\\u[0-9a-fA-F]{4}|\\"/.test(t)) reasons.push("format:escapes-as-text");
  if (/<\/?[a-z][^>]*>/i.test(t) && !/\$[^$]*<[^$]*\$/.test(t)) reasons.push("format:html");
  if (/^\s*[#>*-]\s|\*\*[^*]+$|^\*\*/m.test(t)) reasons.push("format:markdown");
  return reasons;
}

const cleanLines = (s) => repairFormatting(s).replace(/[ \t]+/g, " ");
const words = (s) => clean(s).split(" ").filter(Boolean);

// A sentence or question that opens by pointing back at something earlier.
// "IT" written in capitals is an acronym (information technology) unless a
// verb follows straight away, the way "It is ..." would read.
const POINTS_BACK =
  /^(?:(?:it|this|these|they|those|such|he|she|its|their|them|here|there|both|either|neither|the former|the latter|the above|the following|that)\b(?!-)|IT\s+(?:is|has|was|can|uses|provides|allows|does|will|may|must|also|then|helps)\b)/i;
export const opensWithReference = (text) => {
  const t = clean(text).replace(/^["“'(]+/, "");
  if (/^IT\b/.test(t)) return /^IT\s+(?:is|has|was|can|uses|provides|allows|does|will|may|must|also|then|helps)\b/.test(t);
  // "This/These <noun>" and "It ..." all depend on the sentence before
  return POINTS_BACK.test(t);
};

const FUNCTION_ANSWERS = new Set(
  "a an the of to in on for with as at by from into onto upon about than that this these those it its is are was were be been being and or but nor if then so not no can will would should may might must do does did has have had".split(" ")
);

const BROAD_DISTRACTORS = new Set("system systems data information item items thing things value values object objects element elements entity result results".split(" "));

const COMMAND = /^(?:define|explain|describe|state|list|differentiate|distinguish|compare|contrast|why|how|what|discuss|illustrate|justify|analy[sz]e|outline|give|write|identify|evaluate|examine|summari[sz]e|mention|name|enumerate)\b/i;
// "Explain the differences.", "Describe it.", "Discuss this topic."
const VAGUE_THEORY =
  /^(?:explain|describe|discuss|state|define|write about|give|list)\s+(?:the\s+|these\s+|this\s+|it\b|them\b)?(?:differences?|advantages?|disadvantages?|concepts?|topic|it|this|them|details|points|above|following)?\s*[.?]?$/i;

// ---- what a question asks about
// Words that say what KIND of thing is asked for but not WHICH thing:
// "Which of the following is a feature?" names no subject at all.
const STEM_FILLER = new Set(
  "which what who whom whose when where why how following option options statement statements true false correct incorrect right wrong best most least likely given above below select choose identify".split(" ")
);
// Content words of a stem that name its subject: not question words, not
// generic words ("feature", "type", "advantage"), not the negation.
function subjectWords(prompt) {
  const stem = clean(prompt).replace(BLANK, " ").replace(/^(?:fill in the blank|question)\s*:\s*/i, "");
  const tokens = tokenize(stem).filter((w) => !GENERIC.has(w) && !STEM_FILLER.has(w) && !/^(?:not|except|never)$/.test(w));
  // acronyms of two letters ("IP", "OS") are names too; tokenize drops them
  const acronyms = stem.match(/\b[A-Z][A-Z0-9]{1,}\b/g) || [];
  return [...new Set([...tokens, ...acronyms.map((a) => a.toLowerCase())])];
}

// A negative stem: "Which of the following is NOT ...", "... does not ...",
// "All of the following EXCEPT ...", "Which statement is false ...".
// Only a stem that asks the student to pick the odd one out counts: "What
// happens when a frame cannot be delivered?" is an ordinary question.
const NEGATIVE_PICK = /^(?:(?:which|what)\b[^?]*?\b(?:not|except|false|incorrect|untrue)\b|all of the following\b[^?]*\bexcept\b|.*\bis (?:not|NOT) (?:true|correct)\b)/i;
export const isNegativeStem = (prompt) => NEGATIVE_PICK.test(clean(prompt));
// In a fill-in-the-blank, what matters is the clause the blank sits in:
// "A switch does not repeat frames; it forwards them by _____" is fine,
// "IT does not contain _____" is not.
const NEGATION = /\b(?:not|never|cannot|no longer|neither|nor)\b|n['’]t\b/i;
export function blankIsNegated(sentence) {
  const clause = String(sentence || "")
    .split(/[;:,]|\s(?:but|whereas|while|although|however)\s/i)
    .find((c) => /_{3,}/.test(c));
  return Boolean(clause && NEGATION.test(clause));
}

/** True when every content word of `option` is in `passage` (stems compared). */
function optionIn(option, passage) {
  const need = [...stemsOf(option)];
  if (!need.length) return normalizeText(passage).includes(normalizeText(option));
  const have = stemsOf(passage);
  return need.every((s) => have.has(s));
}

const shapeOf = (s) => (/\d/.test(s) || /^[A-Z0-9/+.-]{2,}$/.test(clean(s)) ? "code" : words(s).length > 1 ? "phrase" : "word");

// One phrase inside another, as whole words: "key" in "public key".
// How two options are compared: by their words, except that a formula or code
// keeps its symbols ("$B + D$" and "$B - D$" are different answers).
const hasSymbols = (s) => /\$|`|[=+\-*/^<>≤≥≠×÷√∑∫]/.test(String(s));
const optionKey = (s) => (hasSymbols(s) ? String(s).toLowerCase().replace(/\s+/g, "") : normalizeText(s));

function phraseInside(small, big) {
  if (hasSymbols(small) || hasSymbols(big)) return false;
  const a = normalizeText(small);
  const b = normalizeText(big);
  if (!a || !b || a === b) return false;
  return ` ${b} `.includes(` ${a} `);
}

/**
 * True when the blank hides only part of a longer term:
 *   "Partially _____: after the final statement ..." (a lead-in of several
 *   words, "partially committed", with one of them blanked), or
 *   "... access to a data _____." when the notes say "data item" - the word
 *   before the blank and the answer make a phrase the notes use.
 */
export function blankSplitsTerm(sentence, answer, contextText = "") {
  const s = clean(sentence);
  // the lead-in before a colon is one term; a blank inside it with other words beside it is half of it
  const lead = s.match(/^([^:]{1,60}):\s/)?.[1];
  // ("_____ (S):" is the whole term with its symbol, not half of one)
  const besideBlank = lead ? words(lead.replace(/\([^)]*\)/g, " ").replace(/_{3,}/g, " ")).filter((w) => /[A-Za-z]{2}/.test(w)) : [];
  if (lead && /_{3,}/.test(lead) && besideBlank.length >= 1 && words(lead).length <= 5) return true;
  const ctx = ` ${normalizeText(contextText)} `;
  const ans = normalizeText(answer);
  if (!ans || ctx.trim() === "") return false;
  // only the word BEFORE: modifiers come first in an English term ("data
  // item", "secret key"); the word after a term is usually its verb
  // ("router forwards"), which is no part of it
  const before = s.match(/([A-Za-z][A-Za-z-]*)\s+_{3,}/)?.[1];
  return Boolean(before && isContentWord(before) && !FUNCTION_ANSWERS.has(before.toLowerCase()) && ctx.includes(` ${normalizeText(`${before} ${ans}`)} `));
}

/** Stems of the content words in a text, for "is the answer in the passage" checks. */
const stemsOf = (s) => new Set(tokenize(String(s ?? "")).map(stem));

function isMeaningfulAnswer(answer) {
  const a = clean(answer);
  if (!a) return false;
  const w = words(a);
  if (w.length > 6) return false;
  // an acronym or a name with digits is meaningful however short ("IP", "MD5")
  if (/^[A-Z0-9][A-Z0-9/+.-]*$/.test(a) && /[A-Z0-9]/.test(a)) return true;
  const lower = w.map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, ""));
  // several words make a term even when each is common ("page table")
  if (lower.every((x) => FUNCTION_ANSWERS.has(x))) return false;
  if (w.length === 1) {
    const x = lower[0];
    if (x.length < 3 || FUNCTION_ANSWERS.has(x) || GENERIC.has(x) || BROAD_DISTRACTORS.has(x)) return false;
    // a verb form or adverb blanked out tests grammar, not knowledge
    if (!isContentWord(w[0]) || /(?:ly)$/.test(x)) return false;
  }
  return true;
}

/**
 * Check one MCQ or theory question. `q` uses the stored shape: prompt,
 * options + answerKey (MCQ) or answerKey (model answer) + keyPoints (theory),
 * supportingExcerpt, difficulty. `contextText` is everything the question may
 * quote. Returns { ok, reasons, question } - `question` with small faults
 * repaired, `reasons` the checks that failed (empty when ok).
 */
export function validateQuestion(q, { type, contextText = "" } = {}) {
  const reasons = [];
  const out = { ...q };
  // line breaks are kept (code, steps, a matrix); everything else is tidied
  out.prompt = cleanLines(q?.prompt);
  out.difficulty = DIFFICULTIES.includes(q?.difficulty) ? q.difficulty : "medium";
  const prompt = out.prompt;
  const context = normalizeText(contextText);

  // ---- clarity and language
  if (prompt.length < 15) reasons.push("clarity:too-short");
  if (prompt.length > 600) reasons.push("clarity:too-long");
  if (/\b(?:undefined|null|NaN)\b|\{\{|\}\}|\[object /.test(prompt)) reasons.push("clarity:template-text");
  if (/\b(\w{2,})\s+\1\b/i.test(prompt.replace(/_+/g, ""))) reasons.push("language:doubled-word");
  reasons.push(...formattingProblems(prompt));
  for (const [open, close] of [["(", ")"], ["“", "”"], ["[", "]"]]) {
    if (prompt.split(open).length !== prompt.split(close).length) reasons.push("language:unbalanced");
  }
  if ((prompt.match(/"/g) || []).length % 2) reasons.push("language:unbalanced");

  const blanks = prompt.match(BLANK) || [];
  const quoted = prompt.match(/"([^"]+)"/)?.[1] || prompt.match(/“([^”]+)”/)?.[1] || "";
  const blankSentence = blanks.length ? quoted || prompt.replace(/^fill in the blank:\s*/i, "") : "";

  // ---- context: nothing pointing at a sentence the student has not seen
  const asked = blankSentence || prompt.replace(/^(?:fill in the blank|question)\s*:\s*/i, "");
  if (opensWithReference(asked)) reasons.push("context:refers-back");

  if (type === "mcq") {
    let options = Array.isArray(q?.options) ? q.options.map((o) => clean(repairFormatting(o))).filter(Boolean) : [];
    let answer = clean(repairFormatting(q?.answerKey ?? q?.correctAnswer));
    if (options.some((o) => formattingProblems(o).length)) reasons.push("format:option");
    // repair: an answer differing from its option only in case or spacing
    const exact = options.filter((o) => o === answer);
    if (exact.length === 0) {
      const loose = options.filter((o) => normalizeText(o) === normalizeText(answer));
      if (loose.length === 1) answer = loose[0];
    }
    // repair: more than four options - keep the answer and the first three others
    if (options.length > 4 && options.includes(answer)) options = [answer, ...options.filter((o) => o !== answer).slice(0, 3)];
    if (options.length !== 4) reasons.push("mcq:not-four-options");
    if (new Set(options.map(optionKey)).size !== options.length) reasons.push("mcq:duplicate-options");
    if (options.filter((o) => o === answer).length !== 1) reasons.push("mcq:answer-not-an-option");
    if (options.some((o) => /\b(?:all|none|both|neither) of (?:the )?(?:above|these|them)\b/i.test(o))) reasons.push("mcq:all-or-none-of-the-above");
    if (options.some((o, i) => options.some((p, j) => i !== j && phraseInside(o, p)))) reasons.push("mcq:overlapping-options");

    const others = options.filter((o) => o !== answer);
    if (answer && others.length) {
      // the answer printed in the question gives it away
      if (normalizeText(answer).length >= 2 && ` ${normalizeText(prompt.replace(BLANK, " "))} `.includes(` ${normalizeText(answer)} `)) {
        reasons.push("mcq:answer-in-question");
      }
      // one option that stands out by length or form points at itself
      const longest = Math.max(...others.map((o) => o.length));
      if (answer.length > 2 * longest && answer.length - longest > 15) reasons.push("mcq:answer-stands-out-by-length");
      if (others.every((o) => shapeOf(o) !== shapeOf(answer)) && others.every((o) => shapeOf(o) === shapeOf(others[0]))) {
        reasons.push("mcq:answer-stands-out-by-form");
      }
    }

    // a wrong option nobody would pick: a lone function word or generic word
    // ("the", "system", "type") tests nothing
    if (options.some((o) => words(o).length === 1 && (FUNCTION_ANSWERS.has(o.toLowerCase()) || GENERIC.has(o.toLowerCase())))) reasons.push("mcq:weak-option");
    // ...or a roman numeral or a lone letter ("II", "b"), or a word in capitals
    // beside a lower-case answer ("LOADER" beside "program": a table header)
    else if (options.some((o) => /^(?:[ivxlcdm]{1,4}|[a-z])$/i.test(o) && !/^[A-Z]{2,4}$/.test(o.replace(/^(?:I{1,3}|IV|VI{0,3}|IX|X{1,3})$/, "")))) reasons.push("mcq:weak-option");
    else if (/[a-z]/.test(answer) && options.some((o) => o !== answer && /^[A-Z][A-Z\s-]{4,}$/.test(o))) reasons.push("mcq:weak-option");
    // ...or a word so broad it is never the answer to anything ("system", "data")
    else if (options.some((o) => o !== answer && words(o).length === 1 && BROAD_DISTRACTORS.has(o.toLowerCase()))) reasons.push("mcq:weak-option");

    // the question has to say what it is about: "Which of the following is
    // not a feature?" or "It consists of _____." name nothing a student can
    // answer from
    const negative = !blanks.length && isNegativeStem(prompt);
    // (a blank's sentence already has six words of context; one of them must
    // name something)
    if (subjectWords(blanks.length ? blankSentence : prompt).length < (blanks.length ? 1 : 2)) reasons.push("clarity:names-no-subject");

    if (blanks.length && blankIsNegated(blankSentence)) {
      // "IT does not contain _____.": countless things fit a negative blank
      reasons.push("blank:negative-statement");
    } else if (blanks.length) {
      if (blanks.length > 3) reasons.push("blank:too-many-blanks");
      if (!isMeaningfulAnswer(answer)) reasons.push("blank:meaningless");
      if (words(blankSentence.replace(BLANK, " ")).length < 6) reasons.push("blank:too-little-context");
      if (blankSplitsTerm(blankSentence, answer, contextText)) reasons.push("blank:part-of-term");
      // ambiguity: a wrong option that also makes a sentence the notes say
      // ("a(n) _____" is tried with both articles)
      const fills = (o) => ["a", "an"].map((art) => normalizeText(blankSentence.replace(/\ba\(n\)(?=\s)/gi, art).replace(BLANK, o)));
      if (context && others.some((o) => fills(o).some((f) => f.length > 20 && context.includes(f)))) reasons.push("mcq:another-option-also-correct");
      // correctness: the answer in the blank gives the supporting passage back
      if (q?.supportingExcerpt && answer) {
        const filled = stemsOf(blankSentence.replace(BLANK, ` ${answer} `));
        const have = stemsOf(q.supportingExcerpt);
        const share = [...filled].filter((x) => have.has(x)).length / Math.max(1, filled.size);
        if (share < 0.9) reasons.push("correctness:answer-does-not-fill-the-passage");
      }
    } else if (negative) {
      // "Which of the following is NOT a property of a block cipher?" has one
      // answer only when the notes say every other option IS one: the three
      // wrong options must be in the supporting passage, and the answer not.
      const passage = q?.supportingExcerpt || "";
      if (!passage || !answer || !others.length || !others.every((o) => optionIn(o, passage)) || optionIn(answer, passage)) {
        reasons.push("mcq:negative-not-verifiable");
      }
      if (!/[?:]$/.test(prompt) && !/^(?:which|what|who|when|where|why|how)\b/i.test(prompt)) reasons.push("clarity:not-a-question");
      // repair: the negation is what the student must not miss
      out.prompt = prompt.replace(/\b(not|except)\b/i, (w) => w.toUpperCase());
    } else if (q?.supportingExcerpt && answer) {
      // a direct question: the answer's content words are in the passage
      const need = [...stemsOf(answer)];
      const have = stemsOf(q.supportingExcerpt);
      if (need.length && need.filter((s) => have.has(s)).length / need.length < 0.6) reasons.push("correctness:answer-not-in-passage");
      if (!/[?:]$/.test(prompt) && !/^(?:which|what|who|when|where|why|how)\b/i.test(prompt)) reasons.push("clarity:not-a-question");
    }
    out.options = options;
    out.answerKey = answer;
  } else if (type === "theory") {
    if (!COMMAND.test(prompt)) reasons.push("theory:no-command-word");
    if (VAGUE_THEORY.test(prompt)) reasons.push("theory:vague");
    // it has to name what it asks about: a quoted term, or at least two
    // content words after the command word
    const subject = prompt.replace(COMMAND, "").replace(/[“”"]/g, "");
    if (!/[“"]/.test(prompt) && tokenize(subject).length < 2) reasons.push("theory:names-nothing");
    const model = clean(q?.answerKey ?? q?.modelAnswer);
    if (words(model).length < 6) reasons.push("theory:no-model-answer");
    const points = Array.isArray(q?.keyPoints) ? q.keyPoints.map(clean).filter(Boolean) : [];
    if (points.length === 0) reasons.push("theory:no-key-points");
    const distinct = [];
    for (const p of points) if (!distinct.some((d) => termKey(d) === termKey(p))) distinct.push(p);
    out.keyPoints = distinct.slice(0, 6);
    if (out.keyPoints.some((p) => words(p).length > 12)) reasons.push("theory:key-point-too-long");
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], question: out };
}

/**
 * The concept a question tests, for "do not ask about the same thing again so
 * soon": the answer of an MCQ, the term a theory question names (or its whole
 * wording when it names none), as a normalised key.
 */
export function conceptOf(q, type) {
  if (q?.concept) return String(q.concept).split("|").map((c) => termKey(normalizeText(c))).filter(Boolean).join(" | ");
  if (type === "mcq") return termKey(normalizeText(q?.answerKey ?? q?.correctAnswer ?? ""));
  const named = [...String(q?.prompt || "").matchAll(/[“"]([^”"]+)[”"]/g)].map((m) => termKey(normalizeText(m[1])));
  return named.length ? named.sort().join(" | ") : normalizeText(q?.prompt).split(" ").slice(0, 8).join(" ");
}

/** Shuffle options (Fisher-Yates), keeping the answer's text - and so its mapping - intact. */
export function shuffleOptions(options, answer, random = Math.random) {
  const a = [...options];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (a.filter((o) => o === answer).length !== 1) throw new Error("answer lost in shuffle");
  return a;
}
