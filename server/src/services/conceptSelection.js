// CONCEPT SELECTION: which concepts a test asks about, in which format, in
// what order - decided from the concept records (conceptRecords.js) before
// either writer, Groq or the rules, writes a word.
//
// For each question type, a concept is ELIGIBLE when its record allows that
// format:
//   MCQ     label "mcq" or "both" (a formula: "both" only when it can be
//           applied numerically - the MCQ is then computed, never blanked)
//   theory  label "theory" or "both"; "context-dependent" only with two or
//           more sentences to answer from
// and is then ranked by
//   importance x reading confidence x novelty
// where novelty is 1 for a concept never tested, lower for one tested before
// (least when tested in the last two tests). Importance that is uncertain
// (near IMPORTANCE_MIN) puts the concept in a reserve, used only after every
// surer concept; importance well below it excludes the concept. Unsuitable
// records (fragments, misread text, nothing to ask) never get this far.
//
// Coverage: the ranked lists are kept per note, and writers take notes in
// the mastery-weighted order the engine already uses (weak topics more,
// every topic at least once when the test is long enough), so one note's
// easy concepts cannot fill a test.
//
// What is recorded for diagnostics: how many records were considered,
// eligible, selected and excluded, and why.

import { IMPORTANCE_MIN } from "./conceptRecords.js";

const UNCERTAIN_BAND = 0.08;

function novelty(record, history) {
  const h = history?.get(record.id) || history?.get(record.key);
  if (!h) return { value: 1, tested: 0, recent: false };
  return { value: h.recent ? 0.4 : 0.7 / (1 + 0.2 * (h.count - 1)), tested: h.count, recent: Boolean(h.recent) };
}

const eligibleFor = (type, r) =>
  type === "mcq"
    ? r.suitability.mcq && ["mcq", "both"].includes(r.suitability.label)
    : r.suitability.theory && (["theory", "both"].includes(r.suitability.label) || (r.suitability.label === "context-dependent" && r.statements.length >= 2));

/**
 * recordsByNote  Map(note -> records)
 * history        Map(concept id or key -> { count, recent, approaches: Set })
 * Returns { mcq: Map(note -> ordered records), theory: Map(...), stats }.
 */
export function selectConcepts(recordsByNote, { history = new Map() } = {}) {
  const stats = { considered: 0, eligible: { mcq: 0, theory: 0 }, reserve: { mcq: 0, theory: 0 }, excluded: {} };
  const exclude = (why) => (stats.excluded[why] = (stats.excluded[why] || 0) + 1);
  const plan = { mcq: new Map(), theory: new Map() };
  for (const [note, records] of recordsByNote) {
    for (const type of ["mcq", "theory"]) plan[type].set(note, []);
    const reserve = { mcq: [], theory: [] };
    for (const r of records) {
      stats.considered++;
      const imp = r.importance.score;
      if (imp < IMPORTANCE_MIN - UNCERTAIN_BAND) {
        exclude("low-importance");
        continue;
      }
      const n = novelty(r, history);
      const priority = imp * (r.confidence ?? 1) * n.value;
      let any = false;
      for (const type of ["mcq", "theory"]) {
        if (!eligibleFor(type, r)) continue;
        any = true;
        const entry = { record: r, priority, novelty: n, approaches: history.get(r.id)?.approaches || history.get(r.key)?.approaches || new Set() };
        if (r.importance.uncertain) reserve[type].push(entry);
        else plan[type].get(note).push(entry);
        stats.eligible[type]++;
      }
      if (!any) exclude(r.suitability.label === "context-dependent" ? "context-dependent" : `not-${r.suitability.label}`);
    }
    for (const type of ["mcq", "theory"]) {
      const list = plan[type].get(note).sort((a, b) => b.priority - a.priority);
      list.push(...reserve[type].sort((a, b) => b.priority - a.priority));
      stats.reserve[type] += reserve[type].length;
    }
  }
  return { ...plan, stats };
}

/** Concept ids a plan allows for a type, for checking an AI question's reference. */
export const planIds = (plan, type) => new Set([...plan[type].values()].flat().map((e) => e.record.id));
