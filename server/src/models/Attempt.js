import { getCollection } from "../db/index.js";
import { generateId } from "../db/ids.js";

const attempts = () => getCollection("attempts");

// shownQuestionIds and currentDifficulty are the adaptive controller's
// entire state (see services/adaptiveEngine.js): which questions from the
// test's pool this attempt has already been given, and which difficulty
// tier to draw the next one from. targetCount is how many questions this
// attempt will deliver in total before routes/attempts.js tells the
// client to submit.
//
// deadlineAt is when the test's time runs out, set here by the server: the
// clock the student sees counts down to it, and answers that arrive after it
// (plus a short grace for the network) are refused (routes/attempts.js).
// lastShownAt is when the question now awaiting an answer was served, so the
// time spent on it is measured by the server, not reported by the browser.
export async function createAttempt({ testId, subjectId, ownerId, targetCount, currentDifficulty, shownQuestionIds = [], durationMinutes = null }) {
  const now = new Date();
  return attempts().insertOne({
    testId,
    // denormalised from the test so mastery lookups during an attempt do not
    // have to re-read it on every response
    subjectId,
    ownerId,
    status: "in_progress",
    startedAt: now,
    submittedAt: null,
    deadlineAt: durationMinutes ? new Date(now.getTime() + durationMinutes * 60_000) : null,
    lastShownAt: now,
    awaitingQuestionId: shownQuestionIds[shownQuestionIds.length - 1] ?? null,
    shownQuestionIds,
    currentDifficulty,
    targetCount,
  });
}

export async function findOwnedAttempt(id, ownerId) {
  return attempts().findOne({ _id: id, ownerId });
}

/** Every attempt of a student, newest first. */
export async function findAttemptsByOwner(ownerId) {
  return attempts().find({ ownerId }, { sort: { startedAt: -1 } });
}

/** Attempt history for a subject, newest first - powers the progress page. */
export async function findAttemptsBySubject(ownerId, subjectId) {
  return attempts().find({ ownerId, subjectId }, { sort: { startedAt: -1 } });
}

/**
 * The student's unfinished attempt at a test, if any (newest first): one in
 * progress, or one whose answers are being marked ("closing").
 */
export async function findOpenAttempt(testId, ownerId) {
  const open = await attempts().find({ testId, ownerId, status: ["in_progress", "closing"] }, { sort: { startedAt: -1 } });
  return open[0] || null;
}

// Closing an attempt (marking it, updating mastery, writing the report) can
// take minutes when an LLM marks many theory answers. Whoever closes it first
// holds a claim: status "closing" with a random token. Only the holder of the
// current token can finish the close, so a second request, or one that takes
// over a close abandoned by a stopped server, can never write a second report.

/** Claim an attempt in progress for closing. Returns the token, or null if someone else has it. */
export async function claimAttemptForClosing(id) {
  const token = generateId();
  const out = await attempts().findOneAndUpdate(
    { _id: id, status: "in_progress" },
    { $set: { status: "closing", closingAt: new Date(), closeToken: token } }
  );
  return out ? token : null;
}

/** Take over a close that was claimed but never finished (the server stopped part way). Returns the new token, or null. */
export async function reclaimStaleClose(id, oldToken) {
  const token = generateId();
  const out = await attempts().findOneAndUpdate(
    // an attempt left "closing" by an older version has no token at all
    oldToken ? { _id: id, status: "closing", closeToken: oldToken } : { _id: id, status: "closing" },
    { $set: { closingAt: new Date(), closeToken: token } }
  );
  return out ? token : null;
}

/**
 * Finish a close: the attempt becomes "submitted", only for the holder of the
 * claim. `closedBy` says how it ended: "student" (submitted) or "time" (the
 * deadline passed). Returns the attempt, or null if the claim was lost.
 */
export async function markAttemptSubmitted(id, { closedBy = "student", token }) {
  return attempts().findOneAndUpdate(
    { _id: id, status: "closing", closeToken: token },
    { $set: { status: "submitted", submittedAt: new Date(), closedBy, closeToken: null } }
  );
}

/** Undo a claim when closing failed part way, so the student can submit again. */
export async function releaseAttemptClaim(id, token) {
  return attempts().findOneAndUpdate({ _id: id, status: "closing", closeToken: token }, { $set: { status: "in_progress", closeToken: null } });
}

/**
 * Take the question the attempt is waiting on, so its answer is recorded
 * once: of two requests answering it at the same moment, one gets the
 * attempt back and the other null. (Attempts from before this field existed
 * have no `awaitingQuestionId`; the caller checks those the old way.)
 */
export async function takeAwaitedQuestion(id, questionId) {
  return attempts().findOneAndUpdate(
    { _id: id, status: "in_progress", awaitingQuestionId: questionId },
    { $set: { awaitingQuestionId: null, awaitingTakenAt: new Date() } }
  );
}

/** Put back the question an attempt is waiting on (after a failed save, or a stop part way). */
export async function setAwaitedQuestion(id, questionId) {
  return attempts().findOneAndUpdate({ _id: id }, { $set: { awaitingQuestionId: questionId } });
}

/** Record that a question has been shown and update the staircase's current tier. */
export async function recordQuestionShown(id, { shownQuestionIds, currentDifficulty }) {
  const awaited = shownQuestionIds[shownQuestionIds.length - 1];
  return attempts().findOneAndUpdate(
    { _id: id },
    { $set: { shownQuestionIds, currentDifficulty, lastShownAt: new Date(), awaitingQuestionId: awaited } }
  );
}
