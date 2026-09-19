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

const TIERS = ["easy", "medium", "hard"];

export function initialDifficulty() {
  return "medium";
}

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
 * is exhausted. Type (mcq vs theory) and topic are not part of the
 * selection criteria - a documented simplification, not an oversight; see
 * the feasibility report's Section 8 for what a fuller multi-constraint
 * selector would need.
 */
export function pickNextQuestion(pool, shownIds, targetDifficulty) {
  const shown = new Set(shownIds.map(String));
  const remaining = pool.filter((q) => !shown.has(String(q._id)));
  if (remaining.length === 0) return null;

  const exact = remaining.filter((q) => (q.difficulty || "medium") === targetDifficulty);
  if (exact.length > 0) return exact[Math.floor(Math.random() * exact.length)];

  const targetIdx = TIERS.indexOf(targetDifficulty);
  const byDistance = [...remaining].sort((a, b) => {
    const da = Math.abs(TIERS.indexOf(a.difficulty || "medium") - targetIdx);
    const db = Math.abs(TIERS.indexOf(b.difficulty || "medium") - targetIdx);
    return da - db;
  });
  return byDistance[0];
}
