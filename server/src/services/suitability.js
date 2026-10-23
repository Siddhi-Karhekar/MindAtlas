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
const CODE_PARTS_SRC = [
  "[{};]\\s*$", "\\b(?:for|while|if|switch)\\s*\\(", "\\b\\w+\\([^)]*\\)\\s*;", "#include\\b", "\\bprintf\\s*\\(", "\\bSystem\\.out\\.",
  // operators only between operands ("a == b", "i++", "x && y"): prose that
  // names an operator ("The == operator compares ...") or a language ("C++")
  // is a statement about code, not code
  "\\bdef\\s+\\w+\\s*\\(", "\\breturn\\s+[\\w(]", "=>", "\\b(?!(?:[Tt]he|[Aa]n?|and|or)\\s*(?:==|!=|&&|\\|\\|))[\\w)\\]]+\\s*(?:==|!=|&&|\\|\\|)\\s*(?!operators?\\b|signs?\\b|symbols?\\b)[\\w(!-]|\\b[a-z_]\\w*(?:\\+\\+|--(?=\\s*[;)]))|\\+\\+[a-z_]", "\\b(?:int|void|char|float|double|public|static)\\s+\\w+\\s*[=(;,)]",
  "`[^`]+`", "^\\s*(?:MOV|ADD|SUB|LOAD|STORE|JMP|LDA|STA|START|END|USING|BALR|DC|DS)\\s+\\S",
];
const CODE = new RegExp(CODE_PARTS_SRC.join("|"), "m");
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
// Words that only occur in working: substituting, "we get", a proof. ("hence",
// "therefore" and "thus" on their own also open ordinary conclusions -
// "Therefore deadlock cannot occur when ..." - which are facts; a step of real
// working carries a formula as well, and rule 4 (formula) catches it first.)
const DERIVATION = /\b(?:thus we get|we get|substitut(?:e|ing)|proof|prove[sd]?|deriv(?:e|ation)|derived(?!\s+from)|it follows that|q\.?e\.?d)\b/i;

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

// Many imperative verbs are also nouns that open a term: "Load balancing
// distributes requests ...", "Link state routing floods ...", "Update anomaly
// occurs when ...". Such an entry is a statement: its second word is a
// lower-case content word (not "the", a number or a symbol such as LOCCTR) and
// a verb follows within the next two words. A step ("Read the next record",
// "Set LOCCTR to 0", "Store values in registers") has its object straight
// after the verb instead.
const OBJECT_START = /^(?:the|a|an|its|their|this|these|those|each|every|all|some|any|it|them|to|in|on|into|from|with|at|as|for|by|of|and|or|up|out|over|until|next|first|last)$/;
function nounLedStatement(text) {
  const w = String(text).trim().split(/\s+/).map((x) => x.toLowerCase().replace(/^[^a-z]+|[^a-z'-]+$/g, ""));
  if (w.length < 4 || !/^[a-z][a-z-]+$/.test(w[1]) || OBJECT_START.test(w[1])) return false;
  // the part of the sentence's subject that is the term itself: up to two more content words
  for (const x of w.slice(2, 4)) {
    if (!x || OBJECT_START.test(x)) return false;
    if (isVerbForm(x)) return true;
    // an -s / -es verb the word lists do not know ("floods", "distributes"),
    // with the rest of the sentence carrying an article or a quantifier
    if (/^[a-z]{3,}(?:s|es)$/.test(x) && !/(?:ss|us|is)$/.test(x) && DETERMINER.test(w.slice(w.indexOf(x) + 1).join(" "))) return true;
  }
  return false;
}
const isImperative = (text) => IMPERATIVE.test(text) && !nounLedStatement(text);

const clauses = (text) => 1 + (String(text).match(/[,;:]|\b(?:which|that|because|whereas|while|although|so that|such that)\b/gi) || []).length;
const wordCount = (text) => String(text).split(/\s+/).filter(Boolean).length;

// ---- how sure the decision is
// The rules above are a priority chain: the first one that matches decides.
// Some matches are near-certain (a LaTeX formula, an entry of an ordered
// list), others are a best guess (a statement nothing else matched becomes a
// "fact"). Each decision therefore carries a confidence between 0 and 1 and
// the reason it was made, so that
//   - an MCQ is only built from a sentence the rules are reasonably sure of
//     (MCQ_MIN_CONFIDENCE): below it the sentence is theory material only,
//     the safer type, and the AI checker (testEngine.verifyWithLLM) gets the
//     final word on any MCQ written from it;
//   - the decision is stored with every question (sourceKind, classification)
//     and can be inspected on a discarded one.
// The numbers are provisional, set by hand from the fixtures; see
// docs/QUESTION_QUALITY.md for how to calibrate them on labelled sentences.
export const MCQ_MIN_CONFIDENCE = 0.45;
// "may", "usually", "often": a statement that is only sometimes true has no
// single defensible blank or option
const HEDGE = /\b(?:may|might|usually|generally|often|sometimes|typically|normally|mostly|in most cases|can be)\b/i;
// "For example, ...", "e.g. ...": an example leans on what it illustrates
const EXAMPLE_LED = /^(?:for (?:example|instance)|e\.g\.|such as|consider|suppose|similarly|likewise|also|in this case|here)\b/i;
// "because", "so that", "as a result": a cause and its effect, which an MCQ
// can test ("Why ...?") and a theory question can ask to be explained
const CAUSAL = /\b(?:because|since|so that|as a result|therefore|hence|thus|due to|leads? to|causes?|results? in|in order to)\b/i;
const NUMBERS = (t) => (String(t).match(/(?<![A-Za-z-])\d+(?:\.\d+)?(?:\s*%| percent)?(?![A-Za-z-])/g) || []).length;
const CODE_PARTS = CODE_PARTS_SRC.map((p) => new RegExp(p, "m"));

function confidenceOfFact(t) {
  let c = 0.6;
  const reasons = [];
  const n = wordCount(t);
  if (n >= 8 && n <= 35) c += 0.1;
  else {
    c -= 0.1;
    reasons.push(n < 8 ? "short" : "long");
  }
  if (HEDGE.test(t)) {
    c -= 0.1;
    reasons.push("hedged");
  }
  if (EXAMPLE_LED.test(t)) {
    c -= 0.25;
    reasons.push("example-or-continuation");
  }
  const numbers = NUMBERS(t);
  if (numbers > 1) {
    c -= Math.min(0.2, 0.1 * (numbers - 1));
    reasons.push("number-heavy");
  }
  if (/\betc\.?|\band so on\b/i.test(t)) {
    c -= 0.1;
    reasons.push("open-ended-list");
  }
  return { confidence: c, reasons };
}

// the kind, how sure, and why: the priority chain itself
function decide(t, { blockType, ordered, section, inTable }) {
  if (!t) return { kind: "explanation", confidence: 1, reason: "empty" };
  if (inTable) return { kind: "table-row", confidence: 0.95, reason: "in-a-table" };
  if (looksLikeTableRow(t)) return { kind: "table-row", confidence: 0.75, reason: "reads-like-a-flattened-table-row" };
  if (hasCode(t)) {
    const parts = CODE_PARTS.filter((re) => re.test(t)).length;
    return { kind: "code", confidence: parts >= 2 ? 0.9 : 0.7, reason: `code-features:${parts}` };
  }
  if (hasFormula(t)) {
    if (LATEX.test(t)) return { kind: "formula", confidence: 0.95, reason: "latex" };
    if (MATH_SYMBOL.test(t)) return { kind: "formula", confidence: 0.85, reason: "maths-symbol" };
    return { kind: "formula", confidence: 0.75, reason: "equation" };
  }
  if (DERIVATION.test(t)) return { kind: "derivation", confidence: 0.7, reason: "working-words" };
  if (blockType === "item") {
    if (ordered) return { kind: "step", confidence: 0.95, reason: "ordered-list" };
    if (PROCEDURE_SECTION.test(section)) return { kind: "step", confidence: 0.8, reason: "under-a-procedure-heading" };
    if (isImperative(t)) return { kind: "step", confidence: 0.7, reason: "imperative-opening" };
    if (isFragmentPoint(t)) return { kind: "fragment", confidence: 0.75, reason: "clipped-list-point" };
    // "Memory usage – the loader itself occupies main memory." under "Disadvantages"
    if (POINTS_SECTION.test(section) && /^[A-Z][^:–—]{0,40}?\s*(?:[:–—]|\s-\s)\s*\S/.test(t)) return { kind: "point", confidence: 0.8, reason: "labelled-point-under-pros-cons" };
  }
  // a sentence under a "how it works" heading that tells the reader what to do
  if (PROCEDURE_SECTION.test(section) && isImperative(t)) return { kind: "step", confidence: 0.75, reason: "instruction-under-a-procedure-heading" };
  if (isClipped(t)) return { kind: "fragment", confidence: 0.65, reason: "no-verb" };
  if (DEFINES.test(t)) {
    const opens = /^(?:an?\s+|the\s+)?[A-Za-z][\w'/-]*(?:\s+[A-Za-z][\w'/-]*){0,5}\s+(?:\([^)]*\)\s+)?(?:is|are)\s+(?:an?|the|one|any|defined|called|known)\b/i.test(t);
    const hedged = HEDGE.test(t) ? 0.1 : 0;
    return { kind: "definition", confidence: (opens ? 0.9 : 0.75) - hedged, reason: opens ? "term-is-a" : "refers-to-or-is-called" };
  }
  // a long statement of several clauses asks to be explained, not blanked
  if (wordCount(t) > 40 && clauses(t) >= 4) {
    const causal = (t.match(new RegExp(CAUSAL.source, "gi")) || []).length;
    return { kind: "explanation", confidence: causal >= 2 ? 0.7 : 0.55, reason: causal >= 2 ? "long-causal-chain" : "long-many-clauses" };
  }
  const f = confidenceOfFact(t);
  return { kind: "fact", confidence: f.confidence, reason: f.reasons.length ? `statement(${f.reasons.join(",")})` : "statement" };
}

/**
 * The kind of one study sentence or list entry, and the question types it can
 * carry: { kind, mcq, theory, confidence, reason, role }.
 *   text     the sentence
 *   context  { blockType: "para" | "item", ordered, section, inTable }
 * `role` says what an MCQ on it would test: "definition", "cause-effect" or
 * "fact" for MCQ material; null otherwise. A sentence whose decision is
 * unsure (confidence below MCQ_MIN_CONFIDENCE) is theory material only.
 */
export function classifyText(text, context = {}) {
  const t = String(text || "").trim();
  const { blockType = "para", ordered = false, section = "", inTable = false } = context;
  const d = decide(t, { blockType, ordered, section, inTable });
  const confidence = Math.max(0, Math.min(1, Number(d.confidence.toFixed(2))));
  const out = { kind: d.kind, ...KINDS[d.kind], confidence, reason: d.reason, role: null };
  if (out.mcq && confidence < MCQ_MIN_CONFIDENCE) {
    out.mcq = false;
    out.reason = `${d.reason};low-confidence`;
  }
  if (out.mcq) out.role = d.kind === "definition" ? "definition" : CAUSAL.test(t) ? "cause-effect" : "fact";
  return out;
}

/** Whether a section heading introduces points (advantages, features ...) rather than prose. */
export const isPointsSection = (section) => POINTS_SECTION.test(String(section || ""));
export const isProcedureSection = (section) => PROCEDURE_SECTION.test(String(section || ""));

// "Basic It generates the executable module ... It loads ...": a row read on
// its own, when the header is somewhere else
function looksLikeTableRow(t) {
  return /^[A-Z][\w/]*(?:\s+[A-Z][\w/]*)?\s+(?:It|They)\s+\w+[^.]*\.\s+(?:It|They)\s+\w+/.test(t);
}
