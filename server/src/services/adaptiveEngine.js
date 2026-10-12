// The "IRT-inspired staircase controller" named in CONTRIBUTING.md's build
// order - deliberately the simple end of adaptive testing, not full Item
// Response Theory. Real IRT/CAT (Lord, 1980; Weiss, 1982; van der Linden &
// Glas, 2000 - see the feasibility report's Section 5E) needs item
// difficulty and discrimination parameters *calibrated from real response
// data*, which this project doesn't have yet. A 1-up-1-down staircase gets
// the behavior that actually matters - a struggling student gets easier
// questions, a strong student gets pushed - without pretending to have
// calibration data it doesn't have. Upgrading to calibrated Rasch
// difficulties later only means swapping what feeds `difficulty` on each
// question; this controller's stepping logic doesn't change.

import { topicWeight } from "./masteryEngine.js";

const TIERS = ["easy", "medium", "hard"];

export function initialDifficulty() {
  return "medium";
}

// Re-exported so routes import the whole adaptive surface from one place.
// The cross-attempt half of adaptivity lives in masteryEngine.js: it decides
// where this staircase STARTS, using what the student did in earlier attempts,
// which is the piece that was missing when every attempt began at "medium".
export { startingDifficulty } from "./masteryEngine.js";

/** Step one tier up on a good response, one tier down on a poor one, clamped. */
export function nextDifficulty(current, wasGood) {
  const idx = TIERS.indexOf(current);
  const safeIdx = idx === -1 ? 1 : idx;
  const nextIdx = wasGood ? Math.min(safeIdx + 1, TIERS.length - 1) : Math.max(safeIdx - 1, 0);
  return TIERS[nextIdx];
}

/**
 * Pick the next question to show: prefer an unshown item at exactly the
 * target difficulty tier; if none remain at that tier, fall back to the
 * nearest tier that still has unshown items. Returns null once the pool
 * is exhausted.
 *
 * Among equally-suitable candidates at the target tier, the one whose topic
 * the student is weakest on wins. Difficulty alone used to decide this, with
 * ties broken at random, which meant an attempt could spend all its questions
 * on a topic the student had already mastered - the topic-balance gap the
 * feasibility report names as a limitation of the bare staircase. Passing no
 * mastery map restores the previous random behaviour exactly.
 */
//
// `types`, when given, are the question types still owed to the student: a
// mixed test of 5 MCQ and 2 theory must deliver 5 and 2, whatever the
// difficulty steps do. Only when none of those types is left in the pool does
// another type stand in, so the test still reaches its length.
export function pickNextQuestion(pool, shownIds, targetDifficulty, masteryMap = null, { types = null } = {}) {
  const shown = new Set(shownIds.map(String));
  let remaining = pool.filter((q) => !shown.has(String(q._id)));
  if (remaining.length === 0) return null;
  if (types?.length) {
    const owed = remaining.filter((q) => types.includes(q.type || "mcq"));
    if (owed.length) remaining = owed;
  }

  const weakestFirst = (candidates) => {
    if (!masteryMap || masteryMap.size === 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    const scored = candidates.map((q) => ({
      q,
      weight: topicWeight(q.topicId || q.topic, masteryMap),
    }));
    const best = Math.max(...scored.map((x) => x.weight));
    // Keep a random tie-break among equally-weak topics so repeated attempts
    // on the same pool do not serve an identical sequence every time.
    const tied = scored.filter((x) => x.weight === best).map((x) => x.q);
    return tied[Math.floor(Math.random() * tied.length)];
  };

  const exact = remaining.filter((q) => (q.difficulty || "medium") === targetDifficulty);
  if (exact.length > 0) return weakestFirst(exact);

  const targetIdx = TIERS.indexOf(targetDifficulty);
  const byDistance = [...remaining].sort((a, b) => {
    const da = Math.abs(TIERS.indexOf(a.difficulty || "medium") - targetIdx);
    const db = Math.abs(TIERS.indexOf(b.difficulty || "medium") - targetIdx);
    return da - db;
  });
  return byDistance[0];
}

/**
 * Which question types an attempt still owes, from the test's requested mix
 * ({ mcq: 5, theory: 2 }) and what has been shown so far. Null for a test
 * built before the mix was recorded: any type will do.
 */
//
// A paper in sections (`sectioned`) owes its MCQs first (Section A) and its
// theory questions only once those are done (Section B).
export function typesOwed(mix, shownQuestions, { sectioned = false } = {}) {
  if (!mix) return null;
  const shownBy = { mcq: 0, theory: 0 };
  for (const q of shownQuestions) shownBy[q.type === "theory" ? "theory" : "mcq"] += 1;
  const owed = Object.keys(shownBy).filter((t) => (mix[t] || 0) > shownBy[t]);
  return sectioned && owed.includes("mcq") ? ["mcq"] : owed;
}
