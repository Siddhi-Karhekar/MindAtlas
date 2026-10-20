// Which kind of question a piece of the notes can carry.
//
// Not every sentence makes a fair multiple-choice question. A definition or a
// plain statement of fact has one right answer that four options can test. A
// formula, a piece of code, the steps of an algorithm, a row of a comparison
// table or a long explanation does not: blank a word out of "EA = base +
// displacement" or out of a table row and the question tests reading, not
// knowing. Those belong in the theory section, where the student explains,
// writes the steps or compares.
//
// So every study sentence (studyText.candidateSentences) and every block of a
// note is given a kind, decided from its STRUCTURE - where it sits, what it
// is made of, whether it is a whole statement - and not from its length or a
// keyword alone:
//
//   definition   "A loader is a system program that ..."           MCQ + theory
//   fact         "An absolute loader loads the code at ..."         MCQ + theory
//   formula      "... computed as EA = base + displacement ..."     theory only
//   code         "for (i = 0; i < n; i++) sum += a[i];"             theory only
//   step         an entry of an ordered list, or under "Algorithm",
//                "Steps", "Procedure", "Pass 1"; an instruction     theory only
//   table-row    a row of a comparison table, as a PDF flattens it
//                ("Basic It generates ... It loads ...")            theory only
//   fragment     a clipped list point with no verb ("Complexity -
//                implementation difficult due to ... etc.")         theory only
//   point        a labelled entry of a list of advantages, disadvantages,
//                limitations ... ("Memory usage - the loader occupies ..."):
//                blanking its label tests nothing; the list is asked
//                for as a whole ("List the disadvantages of ...")    theory only
//   derivation   "hence", "substituting", "proof", "we get"         theory only
//   explanation  a long statement of several clauses               theory only
//
// Both question writers follow this: the rules build MCQs only from sentences
// marked `mcq`, the LLM is only sent those sentences when it writes MCQs, and
// the quality gate rejects any MCQ - whoever wrote it - whose supporting
// passage is not MCQ material (testEngine.generateQuestions).

import { isVerbForm } from "./keyTerms.js";
import { parseFlattenedComparison, comparisonToTable } from "./comparisonTable.js";

export { parseFlattenedComparison, comparisonToTable };

const KINDS = {
  definition: { mcq: true, theory: true },
  fact: { mcq: true, theory: true },
  formula: { mcq: false, theory: true },
  code: { mcq: false, theory: true },
  step: { mcq: false, theory: true },
  "table-row": { mcq: false, theory: true },
  fragment: { mcq: false, theory: true },
  point: { mcq: false, theory: true },
  derivation: { mcq: false, theory: true },
  explanation: { mcq: false, theory: true },
};

// ---- what a piece of text is made of

// A formula: LaTeX, maths symbols, or "X = Y" between symbols and terms
// ("EA = base + displacement", "P = R + L", "x^2").
const LATEX = /\$[^$]+\$|\\(?:frac|sum|int|sqrt|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega|cdot|times|leq|geq|neq|infty)\b/;
const MATH_SYMBOL = /[≤≥≠≈±×÷∑∏∫√∞∂∆∇→⇒⇔∈∉∀∃]|[A-Za-z0-9)\]]\s*\^\s*[A-Za-z0-9(]|\b[a-zA-Z]_[a-zA-Z0-9{]/;
// any "=" between two operands ("1/R = 1/R1 + 1/R2", "V = I x R", "f(x) = 0"),
// or an inequality whose right side carries an operator
const EQUATION = /[A-Za-z0-9)\]'](?:\s*)(?<![=!<>])=(?!=)\s*[A-Za-z0-9(-]|(?:^|[\s(])(?:[A-Za-z][\w']{0,12}|\d+(?:\.\d+)?)\s*(?:<=|>=|<|>)\s*[A-Za-z0-9(][^.,;]{0,60}?(?:[+\-*/%]|\bmod\b)/;
export const hasFormula = (text) => LATEX.test(text) || MATH_SYMBOL.test(text) || EQUATION.test(text);

// Code: statements, calls, operators and keywords of a programming language.
const CODE = new RegExp(
  [
    "[{};]\\s*$", "\\b(?:for|while|if|switch)\\s*\\(", "\\b\\w+\\([^)]*\\)\\s*;", "#include\\b", "\\bprintf\\s*\\(", "\\bSystem\\.out\\.",
    "\\bdef\\s+\\w+\\s*\\(", "\\breturn\\s+[\\w(]", "=>", "==|!=|\\+\\+|--(?=\\s*[;)])|&&|\\|\\|", "\\b(?:int|void|char|float|double|public|static)\\s+\\w+\\s*[=(;,)]",
    "`[^`]+`", "^\\s*(?:MOV|ADD|SUB|LOAD|STORE|JMP|LDA|STA|START|END|USING|BALR|DC|DS)\\s+\\S",
  ].join("|"),
  "m"
);
export const hasCode = (text) => CODE.test(text);

// The heading over an ordered procedure.
const PROCEDURE_SECTION = /\b(?:algorithm|steps?|procedure|process(?:ing)? of|pass\s*(?:\d|i{1,3}|one|two)|how to|working of|method for|flow of|sequence of)\b/i;
// An entry that tells the reader to do something: a step, not a statement.
const IMPERATIVE = /^(?:read|write|assign|build|create|compute|calculate|set|initiali[sz]e|increment|decrement|repeat|go to|goto|store|load|scan|search|insert|delete|add|update|check|if|else|until|while|for each|return|output|print|stop|end|start|begin|obtain|enter|generate|allocate|link|relocate|copy|move|replace|push|pop|call|open|close)\b/i;
// The headings over lists whose entries are aspects ("Complexity", "Cost",
// "Overhead") weighed for or against something, not concepts. (A list of
// characteristics or types names concepts - "Fault tolerance: the system keeps
// working when ..." - and stays MCQ material.)
const POINTS_SECTION = /\b(?:advantages?|disadvantages?|merits?|demerits?|limitations?|drawbacks?|benefits?|pros|cons|issues|problems)\b/i;
const DERIVATION = /\b(?:hence|thus we get|we get|substitut(?:e|ing)|proof|prove[sd]?|deriv(?:e|ed|ation)|therefore|it follows that|q\.?e\.?d)\b/i;

// The verb a statement needs: an auxiliary, or a verb form the word lists know.
// Verbs the lists do not know are found by their place: an -s/-ed word after a
// pronoun ("the loader itself occupies"), or before an article or preposition
// ("occupies the", "stored in").
const VERB_BY_PLACE = /\b(?:it|itself|they|which|that|who|this|these|each)\s+[a-z]+(?:s|es|ed)\b|\b[a-z]{3,}(?:s|es|ed)\s+(?:the|a|an|its|their|this|that|these|those|all|each|every|some|any|no|to|by|in|on|into|from|with|at|as|for)\b/i;
function hasVerb(text) {
  return (
    String(text)
      .toLowerCase()
      .split(/[^a-z'-]+/)
      .some((w) => w && isVerbForm(w)) || VERB_BY_PLACE.test(String(text))
  );
}

// "Complexity – implementation difficult due to memory management, relocation
// etc.": a label, a dash or colon, and a clipped phrase with no verb.
// A clipped phrase has neither a verb nor the articles and determiners a
// sentence carries ("implementation difficult due to memory management").
const DETERMINER = /\b(?:the|a|an|its|their|this|these|those|each|every|several|some|all|any|many|both|one)\b/i;
const isClipped = (text) => !hasVerb(text) && (!DETERMINER.test(text) || /\betc\.?\s*$/i.test(text));
function isFragmentPoint(text) {
  const m = String(text).match(/^([A-Z][^:–—-]{0,40}?)\s*(?:[:–—]|\s-\s)\s*(.+)$/);
  return isClipped(m ? m[2] : text);
}

// The text a definition opens with: "A loader is a ...", "X refers to ...".
const DEFINES = /^(?:an?\s+|the\s+)?[A-Za-z][\w'/-]*(?:\s+[A-Za-z][\w'/-]*){0,5}\s+(?:\([^)]*\)\s+)?(?:is|are)\s+(?:an?|the|one|any|defined|called|known)\b|\b(?:refers to|is defined as|is known as|is called|are called|is termed|means)\b/i;

const clauses = (text) => 1 + (String(text).match(/[,;:]|\b(?:which|that|because|whereas|while|although|so that|such that)\b/gi) || []).length;
const wordCount = (text) => String(text).split(/\s+/).filter(Boolean).length;

/**
 * The kind of one study sentence or list entry, and the question types it can
 * carry: { kind, mcq, theory }.
 *   text     the sentence
 *   context  { blockType: "para" | "item", ordered, section, inTable }
 */
export function classifyText(text, context = {}) {
  const t = String(text || "").trim();
  const { blockType = "para", ordered = false, section = "", inTable = false } = context;
  const of = (kind) => ({ kind, ...KINDS[kind] });
  if (!t) return of("explanation");
  if (inTable || looksLikeTableRow(t)) return of("table-row");
  if (hasCode(t)) return of("code");
  if (hasFormula(t)) return of("formula");
  if (DERIVATION.test(t)) return of("derivation");
  if (blockType === "item") {
    if (ordered || PROCEDURE_SECTION.test(section) || IMPERATIVE.test(t)) return of("step");
    if (isFragmentPoint(t)) return of("fragment");
    // "Memory usage – the loader itself occupies main memory." under "Disadvantages"
    if (POINTS_SECTION.test(section) && /^[A-Z][^:–—]{0,40}?\s*(?:[:–—]|\s-\s)\s*\S/.test(t)) return of("point");
  }
  // a sentence under a "how it works" heading that tells the reader what to do
  if (PROCEDURE_SECTION.test(section) && IMPERATIVE.test(t)) return of("step");
  if (isClipped(t)) return of("fragment");
  if (DEFINES.test(t)) return of("definition");
  // a long statement of several clauses asks to be explained, not blanked
  if (wordCount(t) > 40 && clauses(t) >= 4) return of("explanation");
  return of("fact");
}

/** Whether a section heading introduces points (advantages, features ...) rather than prose. */
export const isPointsSection = (section) => POINTS_SECTION.test(String(section || ""));
export const isProcedureSection = (section) => PROCEDURE_SECTION.test(String(section || ""));

// "Basic It generates the executable module ... It loads ...": a row read on
// its own, when the header is somewhere else
function looksLikeTableRow(t) {
  return /^[A-Z][\w/]*(?:\s+[A-Z][\w/]*)?\s+(?:It|They)\s+\w+[^.]*\.\s+(?:It|They)\s+\w+/.test(t);
}
