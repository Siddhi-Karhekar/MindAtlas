// The machine-readable side of a note: CONCEPT RECORDS.
//
// A note is stored for people as `content` (headings, paragraphs, lists,
// tables, bold terms - what the reading pane shows) and as `rawText`. Neither
// says what the note TEACHES. A concept record does, for one concept:
//
//   id            stable: the same concept gets the same id on every rebuild
//                 and in every note of the subject ("c-" + a hash of its key)
//   key, title    "two-phase locking" / "Two-phase locking"
//   kind          term (a concept the notes name) | process (the steps of an
//                 algorithm or procedure) | comparison (a table comparing two
//                 things) | list (a labelled list: characteristics,
//                 advantages ...) | formula
//   type          what the notes give about it: definition, fact,
//                 cause-effect, process, comparison, list, formula
//   topicPath     [document, ...headings, subtopic]
//   definition    the sentence that says what it IS, if any
//   statements    every study sentence about it, with its classification
//                 (kind, confidence, MCQ or not) and question-worthiness
//   examples, steps, formulas, comparison rows - where the notes give them
//   suitability   label: "both" | "mcq" | "theory" | "context-dependent" |
//                 "unsuitable", with mcq / theory flags and the reasons
//   importance    0-1 + the parts it is made of; band high / medium / low;
//                 "uncertain" when it sits near the cut-off
//   difficulty    easy / medium / hard + why (what kind of knowledge, how
//                 many other concepts it is explained with)
//   prerequisites the ids of the concepts its own sentences are explained with
//   relations     siblings and parents (conceptRelations.js), as ids
//   confidence    how reliably the text was read (OCR, garbled words)
//   source        { noteId, passages }: every passage verbatim in the note
//   exclusion     why it may not be asked at all, when it may not
//
// Built by one deterministic function from the note's study view
// (keyTerms.studyFor) and its structure - the same function at upload, at
// edit and at test time - so the reading view and the records cannot drift:
// the records are kept on the note (`concepts`, with a fingerprint of the
// text) and rebuilt whenever the text, or this file's CONCEPTS_VERSION,
// changes. Test generation SELECTS from these records (conceptSelection.js)
// before either writer - Groq or the rules - writes a word.

import crypto from "node:crypto";
import { isStrongTerm, termKey, termPattern } from "./keyTerms.js";
import { opensWithReference } from "./questionQuality.js";
import { WORTH_MIN } from "./worthiness.js";
import { isHypernymPair } from "./conceptRelations.js";

export const CONCEPTS_VERSION = 1;

export const conceptId = (kind, key) => `c-${crypto.createHash("sha1").update(`${kind}|${key}`).digest("hex").slice(0, 10)}`;
/** The id of a key term's concept. */
export const termConceptId = (key) => conceptId("term", key);

/** A fingerprint of what the records are built from: the text, its structure and the rules' version. */
export function notesFingerprint(note) {
  const h = crypto.createHash("sha1");
  h.update(String(CONCEPTS_VERSION));
  h.update(String(note?.title || ""));
  h.update(String(note?.rawText || ""));
  h.update(JSON.stringify(note?.content || null));
  return h.digest("hex").slice(0, 16);
}

// ---- how reliably the text was read
// A photo read by OCR, or a PDF whose text layer is damaged, gives words like
// "rnanagement", "tbe", "l1nker" and stray letters. Such text may not become a
// question: a blank on a misread word tests nothing, and its "answer" is wrong.
const VOWEL = /[aeiouy]/i;
function garbledShare(text) {
  // formulas and code are left out: "$f'(x)", "\\lim_{h", "i++" are not misreadings
  const words = String(text || "")
    .replace(/\$[^$]*\$|`[^`]*`/g, " ")
    .split(/\s+/)
    .filter((w) => /[A-Za-z]/.test(w) && !/[\\$^_{}=+*/<>|]/.test(w));
  if (words.length < 5) return 0;
  const odd = words.filter((w) => {
    const core = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!core) return false;
    if (/^[A-Z0-9][A-Z0-9/+.-]*$/.test(core)) return false; // an acronym or code: SHA-1, TCP, R1
    if (/[a-z][0-9]+[a-z]/i.test(core) && !/^[a-z]+\d+$/i.test(core)) return true; // "l1nker"
    if (core.length >= 5 && !VOWEL.test(core)) return true; // "rnnt", "sbjct"
    if (/[^\w'’-]/.test(core)) return true; // symbols inside a word: "pro©ess"
    return false;
  });
  return odd.length / words.length;
}

// Signs of a misread page that need no dictionary. OCR misreads the commonest
// words like any other, and prose is full of them: "tbe", "tbat", "wbich"
// (b for h), "callcd", "fixcd" (c for e), "rnernory" (rn for m), and longer
// function words one letter off ("tbere", "betwecn"). Ordinary English almost
// never has a word starting "tb"/"wb", ending "cd", or with "rn" twice. On the
// samples, clean notes score 0-1% and a misread page over 10%.
const LONG_FUNCTION_WORDS = "which there their these those other where would should could about above after before between during under through while because since until called being every often".split(" ");
function looksMisread(w) {
  if (/^(?:tb|wb)[aeiouy]/.test(w) || (w.length >= 4 && /cd$/.test(w)) || (w.match(/rn/g) || []).length >= 2) return true;
  if (w.length < 5 || LONG_FUNCTION_WORDS.includes(w)) return false;
  return LONG_FUNCTION_WORDS.some((f) => f.length === w.length && [...f].filter((ch, i) => ch !== w[i]).length === 1) || LONG_FUNCTION_WORDS.includes(w.replace(/rn/g, "m"));
}
function misreadShare(text) {
  const words = String(text || "").toLowerCase().match(/\b[a-z]{3,10}\b/g) || [];
  if (words.length < 20) return 0;
  return words.filter(looksMisread).length / words.length;
}

/** { confidence (0-1), reasons } for how reliably a note's text was read. */
export function extractionConfidence(note) {
  let c = 1;
  const reasons = [];
  if (note?.ocrFailed) {
    c = 0.3;
    reasons.push("ocr-failed");
  } else if (note?.sourceType === "image") {
    const ocr = typeof note.ocrConfidence === "number" ? note.ocrConfidence : 0.8;
    c = Math.min(c, ocr);
    reasons.push(`ocr:${ocr.toFixed(2)}`);
  }
  const miss = misreadShare(note?.rawText);
  if (miss > 0.02) {
    c = Math.min(c, miss > 0.05 ? 0.3 : 0.45);
    reasons.push(`misread-common-words:${miss.toFixed(2)}`);
  }
  const g = garbledShare(note?.rawText);
  if (g > 0.15) {
    c = Math.min(c, 0.35);
    reasons.push("garbled-words");
  } else if (g > 0.06) {
    c = Math.min(c, 0.6);
    reasons.push("some-garbled-words");
  }
  return { confidence: Number(c.toFixed(2)), reasons };
}

// ---- small readers of the notes' wording
const DEFINES = (term) => {
  const t = termPattern(term, "i").source;
  return new RegExp(
    `${t}\\s+(?:\\([^)]*\\)\\s+)?(?:(?:is|are)\\s+(?:an?|the|one|any|defined|called|known)|refers to|means|denotes|represents|can be defined as)\\b|\\b(?:called|termed|known as|referred to as)\\s+(?:an?\\s+|the\\s+)?${t}|^${t}\\s*(?:\\([^)]*\\))?\\s*:`,
    "i"
  );
};
const EXAMPLE_CUE = /\b(?:for example|for instance|e\.g\.|such as)\b/i;
const LEANS_ON_CONTEXT = (text) => opensWithReference(text) || /^(?:for (?:example|instance)|e\.g\.|similarly|likewise|also|then|finally|here|in this case)\b/i.test(String(text).trim());

// The sentences about `term` itself: not those where it is only part of a
// longer key term ("system" inside "distributed system").
function statementsAbout(study, term) {
  const re = termPattern(term.term, "i");
  const longer = study.terms.filter((t) => t.words > term.words && ` ${t.key} `.includes(` ${term.key} `)).map((t) => termPattern(t.term, "i"));
  return study.sentences.filter((s) => re.test(s.text) && !longer.some((l) => l.test(s.text)));
}

const band = (x) => (x >= 0.75 ? "high" : x >= 0.55 ? "medium" : "low");
// importance near the cut-off is reported as uncertain: selection uses such a
// concept only when nothing surer is left (conceptSelection.js)
export const IMPORTANCE_MIN = 0.45;
const UNCERTAIN_BAND = 0.08;
const round = (x) => Number(Math.max(0, Math.min(1, x)).toFixed(3));

const statementView = (s) => ({
  text: s.text,
  section: s.section || null,
  kind: s.suit?.kind || "fact",
  role: s.suit?.role || null,
  mcq: Boolean(s.suit?.mcq),
  confidence: s.suit?.confidence ?? null,
  worth: s.worth?.score ?? null,
  leansOnContext: LEANS_ON_CONTEXT(s.text),
});

/**
 * The concept records of one note.
 *   note        the note (rawText, content, title, path ...)
 *   study       keyTerms.studyFor(note) with worthiness.annotateWorthiness run
 *   relations   conceptRelations.buildRelations over the subject's notes
 *   structures  the note's structural material, as testEngine finds it:
 *               [{ kind: "process"|"comparison"|"list"|"formula", key, title,
 *                  passages, steps?, rows?, numeric? }]
 * Returns { version, fingerprint, extraction, records, excluded }.
 */
export function buildConceptRecords(note, study, { relations = null, structures = [] } = {}) {
  const extraction = extractionConfidence(note);
  const topicPath = [note?.parentTopic, ...(Array.isArray(note?.path) ? note.path : []), note?.title].filter(Boolean);
  const records = [];
  const excluded = [];
  const terms = study?.terms || [];
  const top = terms[0]?.score || 1;
  const known = new Map(terms.map((t) => [t.key, t]));

  for (const term of terms) {
    // an acronym the notes spell out is the same concept as its expansion:
    // one record ("Remote Procedure Call"), not two
    if (/^[A-Z][A-Z0-9]{1,7}s?$/.test(term.term) && relations?.expansionOf?.get(term.term.replace(/s$/, "").toLowerCase()) && known.has(relations.expansionOf.get(term.term.replace(/s$/, "").toLowerCase()))) continue;
    const about = statementsAbout(study, term);
    const statements = about.map(statementView);
    const id = termConceptId(term.key);
    const reasons = [];
    const definitionSentence = about.find((s) => DEFINES(term.term).test(s.text));
    const defined = Boolean(definitionSentence);
    const marked = term.words > 1 || Boolean(term.abbr) || (term.marks || []).some((m) => m !== "title");

    // what can be asked about it
    const usable = about.filter((s) => !LEANS_ON_CONTEXT(s.text));
    const mcqStatements = usable.filter((s) => s.suit?.mcq && (s.worth?.score ?? 1) >= WORTH_MIN());
    // a concept worth being an MCQ's answer: a whole term, an acronym, one the
    // author marked, or one the notes define - never a word merely repeated
    const answerable = marked || defined || /^[A-Z0-9][A-Z0-9/+.-]*[A-Z0-9+]$/.test(term.term) || (study.semantic && (term.semantic || 0) >= 0.45);
    let mcq = mcqStatements.length > 0 && answerable;
    // worth a written answer: a concept (not a word merely repeated) with at
    // least one sentence of its own to answer from
    let theory = usable.length >= 1 && answerable;
    if (!about.length) reasons.push("no-statement");
    if (about.length && !usable.length) reasons.push("every-statement-leans-on-context");
    if (!answerable) reasons.push("answer-not-a-concept");
    if (usable.length && !mcqStatements.length) reasons.push("no-mcq-material");

    // importance: how central, how worth asking its best sentence, whether
    // the notes define or mark it - never how often it is said
    const bestWorth = Math.max(0, ...about.map((s) => s.worth?.score ?? 0));
    const centrality = Math.min(1, term.score / top);
    const importanceScore = round(0.4 * bestWorth + 0.35 * centrality + (defined ? 0.15 : 0) + (marked ? 0.1 : 0));
    const uncertain = Math.abs(importanceScore - IMPORTANCE_MIN) < UNCERTAIN_BAND;

    // prerequisites: the other concepts its own sentences are explained with
    // (from the sentence that defines it, else its first: every sentence that
    // merely mentions it would count the whole paragraph's terms)
    const core = definitionSentence || usable[0] || about[0];
    const prereqKeys = [...new Set((core?.terms || []).filter((k) => k !== term.key && known.has(k) && !` ${term.key} `.includes(` ${k} `) && !` ${k} `.includes(` ${term.key} `)))];
    const prerequisites = prereqKeys.filter((k) => isStrongTerm(known.get(k))).slice(0, 6).map(termConceptId);

    const type = defined ? "definition" : about.some((s) => s.suit?.role === "cause-effect") ? "cause-effect" : about.some((s) => s.suit?.kind === "formula") ? "formula" : "fact";
    const difficulty =
      prerequisites.length >= 3 || type === "formula" ? { level: "hard", why: prerequisites.length >= 3 ? "explained with 3+ other concepts" : "a formula" } : prerequisites.length >= 1 || about.length >= 3 ? { level: "medium", why: "related to other concepts" } : { level: "easy", why: "a definition or single fact" };

    let label;
    if (extraction.confidence < 0.5) {
      label = "unsuitable";
      reasons.push("text-not-read-reliably");
      mcq = theory = false;
    } else if (!about.length) {
      label = "unsuitable";
      mcq = theory = false;
    } else if (!usable.length) {
      label = "context-dependent";
      mcq = false;
      // with two or more sentences, a written answer has the context it needs
      theory = about.length >= 2 && theory;
    } else label = mcq && theory ? "both" : mcq ? "mcq" : theory ? "theory" : "unsuitable";
    if (importanceScore < IMPORTANCE_MIN - UNCERTAIN_BAND) reasons.push("low-importance");

    const record = {
      id,
      key: term.key,
      title: term.term,
      kind: "term",
      type,
      topicPath,
      definition: definitionSentence?.text || null,
      statements,
      examples: about.filter((s) => EXAMPLE_CUE.test(s.text)).map((s) => s.text),
      formulas: about.filter((s) => s.suit?.kind === "formula").map((s) => s.text),
      suitability: { label, mcq, theory, reasons },
      importance: { score: importanceScore, band: band(importanceScore), uncertain, factors: { bestWorth: round(bestWorth), centrality: round(centrality), defined, marked } },
      difficulty,
      prerequisites,
      relations: relationIds(relations, term.key, known),
      confidence: extraction.confidence,
      source: { noteId: note?._id ?? null, passages: about.map((s) => s.text) },
      exclusion: label === "unsuitable" ? reasons.join(",") || "unsuitable" : null,
    };
    (label === "unsuitable" ? excluded : records).push(record);
  }

  // the note's structure: procedures, comparison tables, labelled lists, formulas
  for (const st of structures) {
    const id = conceptId(st.kind, st.key);
    const reliable = extraction.confidence >= 0.5;
    const numeric = st.kind === "formula" && Boolean(st.numeric);
    const importanceScore = round(st.importance ?? 0.7);
    const record = {
      id,
      key: st.key,
      title: st.title,
      kind: st.kind,
      type: st.kind,
      topicPath,
      definition: null,
      statements: (st.passages || []).map((text) => ({ text, section: st.title, kind: st.kind === "formula" ? "formula" : st.kind === "process" ? "step" : st.kind === "comparison" ? "table-row" : "point", role: null, mcq: false, confidence: null, worth: null, leansOnContext: false })),
      examples: [],
      formulas: st.kind === "formula" ? st.passages || [] : [],
      steps: st.steps || undefined,
      rows: st.rows || undefined,
      // a structure is asked as a whole, in writing; a formula may also be
      // APPLIED in a numerical MCQ, whose answer the server computes
      suitability: { label: reliable ? (numeric ? "both" : "theory") : "unsuitable", mcq: reliable && numeric, theory: reliable, reasons: reliable ? (numeric ? ["numerical-only-mcq"] : ["asked-as-a-whole"]) : ["text-not-read-reliably"] },
      importance: { score: importanceScore, band: band(importanceScore), uncertain: false, factors: { structure: st.kind } },
      difficulty: { level: st.kind === "comparison" || (st.steps || []).length >= 5 ? "hard" : "medium", why: st.kind === "comparison" ? "a comparison on several points" : st.kind === "process" ? "steps in order" : st.kind === "formula" ? "a formula and its terms" : "several points" },
      prerequisites: [],
      relations: { siblings: [], parents: [] },
      confidence: extraction.confidence,
      source: { noteId: note?._id ?? null, passages: st.passages || [] },
      exclusion: reliable ? null : "text-not-read-reliably",
    };
    (reliable ? records : excluded).push(record);
  }

  return { version: CONCEPTS_VERSION, fingerprint: notesFingerprint(note), extraction, records, excluded };
}

function relationIds(relations, key, known) {
  if (!relations) return { siblings: [], parents: [] };
  const ids = (set) => [...(set || [])].map((k) => (known.has(k) ? termConceptId(k) : conceptId("name", k)));
  return { siblings: ids(relations.siblingsOf.get(key)), parents: ids(relations.parentsOf.get(key)) };
}

/** True when two records' concepts are a kind of each other (either way), as the notes state it. */
export const conceptsOverlap = (relations, a, b) => a?.kind === "term" && b?.kind === "term" && isHypernymPair(relations, a.key, b.key);

/** The record whose passages contain `excerpt` (best: the shortest such passage's record). */
export function recordForExcerpt(records, excerpt) {
  const e = String(excerpt || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (e.length < 8) return null;
  let best = null;
  for (const r of records) {
    for (const p of r.source.passages) {
      const t = p.toLowerCase().replace(/\s+/g, " ").trim();
      if (t.includes(e) || (e.length > 30 && e.includes(t))) {
        // a term record beats a structure; a defined term beats a mentioned one
        const rank = (r.kind === "term" ? 2 : 1) + (r.definition && r.definition.toLowerCase().includes(e.slice(0, 40)) ? 1 : 0);
        if (!best || rank > best.rank) best = { r, rank };
      }
    }
  }
  return best?.r || null;
}

/** termKey for a free-text concept name from the AI. */
export const keyFor = (name) => termKey(String(name || "").toLowerCase().replace(/[^a-z0-9 /+-]/g, " ").replace(/\s+/g, " ").trim());
