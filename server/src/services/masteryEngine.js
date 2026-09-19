// Bayesian Knowledge Tracing (Corbett & Anderson, 1994) - the cross-attempt
// mastery model the feasibility report names as its highest-value upgrade.
//
// Everything the previous version of this module knew was thrown away when an
// attempt closed: feedbackEngine computed a fresh snapshot each time and the
// staircase restarted at "medium" on every attempt. BKT is what turns that
// one-shot snapshot into a model of learning over time: a single probability
// per topic that the student knows it, updated after every graded response
// and carried across attempts.
//
// It is deliberately the lightweight end of knowledge tracing. Deep and
// attention-based successors (DKT, SAKT, AKT) predict better but need a
// training pipeline, GPU access and a logged-response dataset far larger
// than this project will accumulate - see the feasibility report's future
// scope. BKT needs none of that: the update below is four multiplications
// and a divide, runs in ordinary application code, and is fully auditable.
//
// ---------------------------------------------------------------------------
// The four standard parameters
// ---------------------------------------------------------------------------
// P(L0)  prior     - probability a topic is already known before any evidence
// P(T)   transit   - probability of learning it at each practice opportunity
// P(S)   slip      - probability of answering wrong while actually knowing it
// P(G)   guess     - probability of answering right without knowing it
//
// These are fixed at literature-typical defaults rather than fitted, because
// fitting them requires exactly the logged-response data the project does not
// have yet. They are stated here as team-chosen values, not published
// constants for this domain, and are the obvious thing to calibrate once real
// attempt data accumulates.
//
// Guess is the one parameter that genuinely differs by question type, so it
// is not a single constant: a four-option multiple-choice question can be
// guessed right about a quarter of the time, whereas guessing a free-text
// answer past a keyword rubric is far less likely. Using one guess rate for
// both would systematically over-credit MCQ answers and under-credit theory
// ones.

export const BKT_DEFAULTS = {
  prior: 0.25,
  transit: 0.15,
  slip: 0.1,
  guessMcq: 0.25, // 1 in 4 options
  guessTheory: 0.1,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round4 = (x) => Number(x.toFixed(4));

/** Guess rate for a question, by type. Falls back to the MCQ rate. */
export function guessRateFor(question, params = BKT_DEFAULTS) {
  if (question?.type === "theory") return params.guessTheory;
  if (question?.type === "mcq" && Array.isArray(question.options) && question.options.length > 0) {
    // A question with more options is harder to guess; keep it honest rather
    // than assuming every MCQ has exactly four.
    return clamp01(1 / question.options.length);
  }
  return params.guessMcq;
}

/**
 * One BKT update.
 *
 * `score` is the response's 0..1 score, the same number feedbackEngine and
 * gradingEngine already use - 1 or 0 for multiple choice, fractional partial
 * credit for a theory answer.
 *
 * Standard BKT expects a binary observation, so the two posteriors are
 * computed and then blended by the score. At score 1 or 0 this reduces
 * exactly to textbook BKT; in between it treats a half-right answer as half
 * the evidence each way. That interpolation is this team's own extension for
 * partial credit, not a published variant, and it is named as such here
 * rather than presented as standard.
 */
export function updateMastery(pKnownBefore, score, guessRate, params = BKT_DEFAULTS) {
  const { slip, transit } = params;
  const pL = clamp01(pKnownBefore);
  const g = clamp01(guessRate);
  const s = clamp01(score);

  // Posterior given a fully correct answer
  const correctNum = pL * (1 - slip);
  const correctDen = correctNum + (1 - pL) * g;
  const pGivenCorrect = correctDen > 0 ? correctNum / correctDen : pL;

  // Posterior given a fully incorrect answer
  const wrongNum = pL * slip;
  const wrongDen = wrongNum + (1 - pL) * (1 - g);
  const pGivenWrong = wrongDen > 0 ? wrongNum / wrongDen : pL;

  const posterior = s * pGivenCorrect + (1 - s) * pGivenWrong;

  // Learning opportunity: even a wrong answer teaches something.
  const next = posterior + (1 - posterior) * transit;
  return round4(clamp01(next));
}

/**
 * Fold a whole attempt's responses into updated per-topic mastery.
 *
 * `existing` is a Map of topicId -> { pKnown, observations }, and responses
 * are applied in the order they were answered so the trajectory matches what
 * the student actually did. Returns a Map of topicId -> { topicId,
 * topicLabel, before, after, observations, responses } which the caller
 * persists and hands to the feedback engine, so the report can say what moved
 * rather than only where the student stands.
 */
export function applyAttemptToMastery({ responses, questionsById, existing, params = BKT_DEFAULTS }) {
  const result = new Map();
  const ordered = [...responses].sort(
    (a, b) => new Date(a.answeredAt || 0) - new Date(b.answeredAt || 0)
  );

  for (const r of ordered) {
    const q = questionsById.get(String(r.questionId));
    if (!q) continue;

    const topicId = String(q.topicId || q.topic || "general");
    const topicLabel = q.topic || topicId;

    if (!result.has(topicId)) {
      const prior = existing.get(topicId);
      const startingP = typeof prior?.pKnown === "number" ? prior.pKnown : params.prior;
      result.set(topicId, {
        topicId,
        topicLabel,
        before: round4(startingP),
        after: round4(startingP),
        observations: prior?.observations || 0,
        responses: 0,
      });
    }

    const entry = result.get(topicId);
    entry.topicLabel = topicLabel; // refresh the display label on every pass
    const score = typeof r.score === "number" ? r.score : r.isCorrect ? 1 : 0;
    entry.after = updateMastery(entry.after, score, guessRateFor(q, params), params);
    entry.observations += 1;
    entry.responses += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Turning mastery into a difficulty tier
// ---------------------------------------------------------------------------
// This is what makes testing adaptive ACROSS attempts rather than only within
// one. adaptiveEngine's staircase still does the within-attempt stepping; what
// mastery changes is where that staircase starts, which previously was always
// "medium" regardless of everything the student had ever done.
//
// The two cut points are a team heuristic, chosen so a student has to be
// clearly weak or clearly strong to open away from the middle. A topic with
// no history falls back to the prior, which lands in the medium band, so a
// first-ever attempt behaves exactly as it did before this model existed.

const TIER_CUTS = { easy: 0.4, hard: 0.75 };

// Below this many recorded responses across a test's topics, the opening tier
// stays at "medium" no matter what the numbers say. The prior (0.25) sits
// inside the "easy" band by construction, so without this guard every student
// who had never taken a test would be handed easy questions on the basis of
// no evidence at all - adapting to an assumption rather than to the student.
// It also preserves the pre-mastery behaviour exactly for a first attempt,
// which makes the feature's effect attributable: if the opening tier moved,
// it moved because of something the student actually did.
const MIN_OBSERVATIONS_TO_ADAPT = 3;

export function difficultyForMastery(pKnown) {
  if (typeof pKnown !== "number" || Number.isNaN(pKnown)) return "medium";
  if (pKnown < TIER_CUTS.easy) return "easy";
  if (pKnown > TIER_CUTS.hard) return "hard";
  return "medium";
}

/**
 * Opening difficulty for an attempt, from the student's mean mastery across
 * the topics this test actually covers. Topics with no history contribute the
 * prior, so a mixed test of familiar and brand-new material opens sensibly in
 * between rather than being dragged to an extreme by either. With too little
 * evidence overall the tier stays at "medium" - see MIN_OBSERVATIONS_TO_ADAPT.
 */
// Weight given to a topic we have never tested, when averaging across a test's
// topics. It is deliberately small but non-zero: unseen material should pull
// the opening difficulty gently toward the middle, because we genuinely do not
// know how the student will handle it, but it must not outvote topics they
// have actually demonstrated. A plain unweighted mean does outvote them - a
// student averaging 93% on every topic they have been tested on would still
// open at "medium" merely because the pool also touched one note they had
// never seen, which reads as the system ignoring their track record.
const UNSEEN_TOPIC_WEIGHT = 0.5;

export function startingDifficulty(topicIds, masteryMap, params = BKT_DEFAULTS) {
  if (!topicIds?.length) return "medium";

  let totalObservations = 0;
  let weightedSum = 0;
  let weightTotal = 0;

  for (const id of topicIds) {
    const row = masteryMap.get(String(id));
    const observations = row?.observations || 0;
    const pKnown = typeof row?.pKnown === "number" ? row.pKnown : params.prior;
    // Confidence weighting: a topic answered six times says six times more
    // about this student than one never attempted.
    const weight = observations > 0 ? observations : UNSEEN_TOPIC_WEIGHT;
    totalObservations += observations;
    weightedSum += pKnown * weight;
    weightTotal += weight;
  }

  if (totalObservations < MIN_OBSERVATIONS_TO_ADAPT) return "medium";

  return difficultyForMastery(weightedSum / weightTotal);
}

/**
 * How much attention a topic deserves when choosing what to generate or serve
 * next. Weakness dominates, with a smaller bonus for topics we simply have
 * little evidence about, so a brand-new topic is not ignored just because its
 * prior happens to sit mid-range. Always strictly positive, so no topic in a
 * test can be starved entirely.
 */
export function topicWeight(topicId, masteryMap, params = BKT_DEFAULTS) {
  const row = masteryMap.get(String(topicId));
  const pKnown = typeof row?.pKnown === "number" ? row.pKnown : params.prior;
  const observations = row?.observations || 0;
  const weakness = 1 - pKnown;
  const uncertainty = 1 / (1 + observations);
  return round4(0.1 + weakness + 0.3 * uncertainty);
}
