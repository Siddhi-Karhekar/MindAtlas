// What a student may see of a question before their attempt is submitted.
//
// An allowlist, not a list of fields to remove: a question carries more and
// more of what the generator knew about it (its concept, the concept's id,
// the learning objective, the quality checks), and several of those name or
// encode the answer - the concept of a fill-in-the-blank MCQ *is* the blanked
// term. A field added to questions later stays private until it is added
// here on purpose. The answers, model answers and sources are shown only by
// the review, after submission (routes/attempts.js GET /attempts/:id/review).

const DURING_A_TEST = ["_id", "testId", "type", "prompt", "options", "guidance", "topic", "topicId", "subtopic", "parentTopic", "parentTopicId", "difficulty", "marks"];

// GET /api/tests/:id additionally says how each question was made and whether
// it was kept - counts and labels, never the answer.
const TEST_LISTING = [...DURING_A_TEST, "status", "discardReason", "generatedBy", "promptVersion", "model", "form", "createdAt"];

const pick = (q, fields) => {
  const out = {};
  for (const f of fields) if (q?.[f] !== undefined) out[f] = q[f];
  return out;
};

/** A question as it may be shown while a test is being taken. */
export const questionForAttempt = (q) => pick(q, DURING_A_TEST);

/** A question as GET /api/tests/:id lists it (before or between attempts). */
export const questionForListing = (q) => pick(q, TEST_LISTING);

export const QUESTION_FIELDS_DURING_A_TEST = Object.freeze([...DURING_A_TEST]);
export const QUESTION_FIELDS_IN_LISTING = Object.freeze([...TEST_LISTING]);
