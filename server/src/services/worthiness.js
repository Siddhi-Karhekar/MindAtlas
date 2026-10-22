// Is a sentence worth an exam question? (academic importance)
//
// A study sentence (studyText.js) is subject matter, but not every piece of
// subject matter deserves a question: "A common mnemonic for the layers is
// ..." or "Every device connects to a hub" is true and in the notes, and a
// question on it tests little. Before a question is written - by the AI or
// by the rules - each study sentence gets a QUESTION-WORTHINESS score from
// 0 to 1 made of five parts:
//
//   centrality    how central the key terms it uses are to the note (their
//                 rank among the note's terms, which already weighs how
//                 distinctive a term is against the other notes and whether
//                 the author marked it - not how often it is said)        0.30
//   relevance     how close it is to what the note is about: by meaning
//                 with the embedding model, else by the words it shares
//                 with the note's title, path and headings, or its use of
//                 one of the note's five leading terms                      0.20
//   substance     what kind of statement it is: a definition says what a
//                 concept IS, a cause-and-effect why; a plain fact less    0.15
//   completeness  whether it stands on its own: no "It"/"This" pointing
//                 back, no dangling colon or "etc.", a sensible length     0.20
//   assessability how sure the classifier is about what it is
//                 (suitability.js confidence)                               0.15
//
// MCQs are only written from sentences scoring at least WORTH_MIN, by both
// writers (the AI is not sent the rest for MCQs). Theory questions are not
// filtered here: they are built around whole terms and checked by the
// quality gate. The weights and WORTH_MIN are provisional; docs/
// QUESTION_QUALITY.md explains how to tune them on a labelled set
// (`npm run eval:calibrate`).

import { tokenize, stem } from "./tfidf.js";
import { topicDescriptor } from "./studyText.js";
import { opensWithReference } from "./questionQuality.js";

export const WORTH_MIN = () => {
  const v = Number(process.env.QUALITY_WORTH_MIN);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.5;
};
const WEIGHTS = { centrality: 0.3, relevance: 0.2, substance: 0.15, completeness: 0.2, assessability: 0.15 };
const SUBSTANCE = { definition: 1, "cause-effect": 0.8, fact: 0.5 };

const stems = (s) => new Set(tokenize(String(s || "")).map(stem));
const round = (x) => Number(Math.max(0, Math.min(1, x)).toFixed(3));

function completeness(text) {
  const t = String(text || "").trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  let c = 1;
  const issues = [];
  if (opensWithReference(t)) {
    c -= 0.5;
    issues.push("refers-back");
  }
  if (/:\s*$/.test(t)) {
    c -= 0.3;
    issues.push("dangling-colon");
  }
  if (/\betc\.?|\band so on\b/i.test(t)) {
    c -= 0.2;
    issues.push("open-ended");
  }
  if (words < 8) {
    c -= 0.2;
    issues.push("short");
  }
  if (words > 45) {
    c -= 0.2;
    issues.push("long");
  }
  if (/^(?:for (?:example|instance)|e\.g\.|similarly|likewise|also|finally|then|next|thereafter|in addition|moreover|however|otherwise)\b/i.test(t)) {
    c -= 0.3;
    issues.push("leans-on-earlier-text");
  }
  return { value: c, issues };
}

/**
 * Score one study sentence `s` of `note` (s.terms, s.suit, s.relevance as
 * studyFor and candidateSentences set them).
 */
export function worthinessOf(s, note, study, descriptorStems = stems(topicDescriptor(note))) {
  const byKey = new Map((study?.terms || []).map((t) => [t.key, t]));
  const top = study?.terms?.[0]?.score || 1;
  const central = (s.terms || [])
    .map((k) => byKey.get(k))
    .filter(Boolean)
    .map((t) => Math.min(1, t.score / top) * (t.words > 1 || t.marks?.length || t.abbr ? 1 : 0.8));
  const centrality = central.length ? Math.max(...central) : 0;
  let relevance;
  if (typeof s.relevance === "number") relevance = (s.relevance - 0.25) / 0.5;
  else {
    const own = stems(s.text);
    const section = stems(s.section);
    let shared = 0;
    for (const w of own) if (descriptorStems.has(w) || section.has(w)) shared++;
    // without the model, a sentence about one of the note's leading terms is
    // on topic even when it shares no word with the headings
    const leading = new Set((study?.terms || []).slice(0, 5).map((t) => t.key));
    const usesLeading = (s.terms || []).some((k) => leading.has(k));
    relevance = Math.max(Math.min(1, shared / 2), usesLeading ? 0.7 : (s.terms || []).length ? 0.4 : 0);
  }
  const substance = s.suit?.mcq ? SUBSTANCE[s.suit.role] ?? 0.5 : 0.3;
  const comp = completeness(s.text);
  const assessability = typeof s.suit?.confidence === "number" ? s.suit.confidence : 0.6;
  const factors = { centrality: round(centrality), relevance: round(relevance), substance: round(substance), completeness: round(comp.value), assessability: round(assessability) };
  const score = round(Object.entries(WEIGHTS).reduce((t, [k, w]) => t + w * factors[k], 0));
  return { score, factors, issues: comp.issues };
}

/** Give every study sentence of a note its score (`s.worth`), once. */
export function annotateWorthiness(note, study) {
  if (!study?.sentences || study.worthAnnotated) return study;
  const d = stems(topicDescriptor(note));
  for (const s of study.sentences) s.worth = worthinessOf(s, note, study, d);
  study.worthAnnotated = true;
  return study;
}

/** Whether a study sentence may carry an MCQ: MCQ material, and worth asking. */
export const mcqWorthy = (s) => (!s.suit || s.suit.mcq) && (!s.worth || s.worth.score >= WORTH_MIN());
