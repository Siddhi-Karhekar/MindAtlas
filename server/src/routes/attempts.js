import { findOwnedTest } from "../models/Test.js";
import { findQuestionsByTest, findQuestionsByIds } from "../models/Question.js";
import {
  claimAttemptForClosing,
  createAttempt,
  findAttemptsByOwner,
  findAttemptsBySubject,
  findOpenAttempt,
  findOwnedAttempt,
  markAttemptSubmitted,
  reclaimStaleClose,
  recordQuestionShown,
  releaseAttemptClaim,
  setAwaitedQuestion,
  takeAwaitedQuestion,
} from "../models/Attempt.js";
import { upsertResponse, findResponsesByAttempt, recordRemark, updateResponseGrade } from "../models/Response.js";
import { createFeedbackReport, findFeedbackByAttempt, findFeedbackBySubject, updateFeedbackScores } from "../models/FeedbackReport.js";
import { REPORT_REASONS, findReportsByOwner, saveQuestionReport } from "../models/QuestionReport.js";
import { requireAuth } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { once } from "../middleware/once.js";
import { InputError, LIMITS, id, oneOf, text } from "../middleware/validate.js";
import { publicDoc } from "../services/noteView.js";
import { computeDocumentRollup, computeTopicScores, computeMarksSummary, markEvidence, phraseFeedback, templateFeedback } from "../services/feedbackEngine.js";
import { gradeAttemptResponses, keyPointMatches, quickTheoryScore, remarkTheoryResponse } from "../services/gradingEngine.js";
import { nextDifficulty, pickNextQuestion, startingDifficulty, typesOwed } from "../services/adaptiveEngine.js";
import { MIN_OBSERVATIONS_FOR_VERDICT, applyAttemptToMastery, difficultyForMastery } from "../services/masteryEngine.js";
import { findMasteryByOwner, findMasteryBySubject, masteryMapForSubject, upsertMastery } from "../models/Mastery.js";
import { dueTopics, streakOf } from "../services/revision.js";
import { findOwnedSubject, findSubjectsByOwner } from "../models/Subject.js";
import { markActivity } from "../models/User.js";
import { findTestsBySubject } from "../models/Test.js";
import { findNotesByIds, findNotesBySubject, topicLabelFor } from "../models/Note.js";

const router = safeRouter();
router.use(requireAuth);

function forAttemptTaking(question) {
  // never send the answer key, supporting excerpt, or (for theory
  // questions) the grading rubric to the client while a test is in
  // progress - only after submission, via the review.
  // eslint-disable-next-line no-unused-vars
  const { answerKey, supportingExcerpt, keyPoints, ...safe } = question;
  return safe;
}

// ---------------------------------------------------------------------------
// The clock. A test's time limit is kept here, not in the browser: the
// attempt records when it ends (deadlineAt), the browser's countdown is drawn
// from that, and an answer arriving after it is refused. The grace covers the
// network: an answer sent in the last second still counts.
// ---------------------------------------------------------------------------

const graceMs = () => Math.max(0, Number(process.env.ATTEMPT_GRACE_SECONDS ?? 30)) * 1000;

export function msLeft(attempt, now = Date.now()) {
  if (!attempt?.deadlineAt) return null;
  return new Date(attempt.deadlineAt).getTime() - now;
}

export function isPastDeadline(attempt, now = Date.now(), grace = graceMs()) {
  const left = msLeft(attempt, now);
  return left !== null && left < -grace;
}

// Time on a question, measured by the server: from when it was served to now.
// Capped at four hours. An attempt from before this was recorded falls back
// to what the browser reports, checked the same way.
function serverTimeMs(attempt, reported) {
  const cap = (ms) => Math.min(4 * 3600_000, Math.max(0, Math.round(ms)));
  if (attempt.lastShownAt) return cap(Date.now() - new Date(attempt.lastShownAt).getTime());
  return typeof reported === "number" && Number.isFinite(reported) ? cap(reported) : 0;
}

function clockOf(attempt) {
  return { deadlineAt: attempt.deadlineAt || null, serverNow: new Date().toISOString() };
}

function testInfo(test) {
  return {
    _id: test._id,
    title: test.title,
    subjectId: test.subjectId,
    durationMinutes: test.durationMinutes,
    // the exam pattern, for the test screen to explain
    negativeMarks: test.negativeMarks || 0,
    sectioned: Boolean(test.sectioned),
    mix: test.mix || null,
  };
}

// The questions a student may still be given: the test's accepted pool,
// without any they have reported as broken - unless that would leave nothing.
// For an attempt under way, only reports made before it started count, so
// reporting (from another attempt's review) never shortens a test mid-way.
async function deliverablePool(test, ownerId, { startedAt = null } = {}) {
  const pool = await findQuestionsByTest(test._id, { onlyAccepted: true });
  const since = startedAt ? new Date(startedAt).getTime() : Infinity;
  const reports = (await findReportsByOwner(ownerId, { testId: test._id })).filter((r) => new Date(r.reportedAt).getTime() < since);
  const reported = new Set(reports.map((r) => String(r.questionId)));
  const usable = pool.filter((q) => !reported.has(String(q._id)));
  return usable.length ? usable : pool;
}

// Choose and record the next question of an attempt, keeping to the test's
// MCQ / theory mix. Returns the question, or null when there is none left.
async function serveNext(attempt, test, tier, ownerId) {
  const [pool, masteryMap] = await Promise.all([
    deliverablePool(test, ownerId, { startedAt: attempt.startedAt }),
    masteryMapForSubject(ownerId, attempt.subjectId),
  ]);
  const shown = new Set(attempt.shownQuestionIds.map(String));
  const allQuestions = await findQuestionsByTest(test._id);
  const types = typesOwed(test.mix, allQuestions.filter((q) => shown.has(String(q._id))), { sectioned: test.sectioned });
  const next = pickNextQuestion(pool, attempt.shownQuestionIds, tier, masteryMap, { types });
  if (!next) return { question: null, attempt };
  const updated = await recordQuestionShown(attempt._id, {
    shownQuestionIds: [...attempt.shownQuestionIds, next._id],
    currentDifficulty: tier,
  });
  return { question: next, attempt: updated || attempt };
}

/**
 * Where an unfinished attempt stands: the question waiting for an answer, or
 * none when every question has been answered and only submitting is left.
 * Used to carry on after a refresh, a closed tab or a dropped connection.
 */
async function currentState(openAttempt, test, ownerId) {
  let attempt = openAttempt;
  const responses = await findResponsesByAttempt(attempt._id);
  const answered = new Set(responses.map((r) => String(r.questionId)));
  const lastId = attempt.shownQuestionIds[attempt.shownQuestionIds.length - 1];
  if (lastId && !answered.has(String(lastId))) {
    const [question] = await findQuestionsByIds([lastId]);
    if (question) {
      // an answer was being saved when the server stopped: the question is
      // still waiting for it
      const takenLongAgo = Date.now() - new Date(attempt.awaitingTakenAt || 0).getTime() > 30_000;
      if ("awaitingQuestionId" in attempt && String(attempt.awaitingQuestionId) !== String(lastId) && takenLongAgo) {
        attempt = (await setAwaitedQuestion(attempt._id, lastId)) || attempt;
      }
      return { attempt, question, answered: answered.size };
    }
  }
  // the last answer was saved, but the next question was never recorded
  // (the connection dropped in between): serve it now
  if (attempt.shownQuestionIds.length < attempt.targetCount) {
    const served = await serveNext(attempt, test, attempt.currentDifficulty, ownerId);
    if (served.question) return { attempt: served.attempt, question: served.question, answered: answered.size };
  }
  return { attempt, question: null, answered: answered.size };
}

function attemptPayload({ attempt, test, question, resumed = false }) {
  return {
    attempt: publicDoc(attempt),
    // Lets the focus-mode screen show the test's name and its time limit.
    test: testInfo(test),
    question: question ? forAttemptTaking(question) : null,
    progress: { shown: attempt.shownQuestionIds.length, target: attempt.targetCount },
    // every question answered: only submitting is left
    readyToSubmit: !question,
    resumed,
    ...clockOf(attempt),
  };
}

// POST /api/tests/:id/attempts - start an attempt, or carry on the one the
// student already has open on this test. Delivery is adaptive
// (adaptiveEngine.js): this hands back one question, not the whole set - see
// POST /responses below for how the rest are chosen.
//
// One open attempt per test: opening the test again (a refresh, another tab,
// coming back later) returns to it, with the same clock. Starting over to get
// easier questions, or more time, is not possible. An open attempt whose time
// has run out is submitted with the answers it has, and the student is told.
router.post("/tests/:id/attempts", once({ remember: false }), async (req, res) => {
  const test = await findOwnedTest(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: "test not found" });
  const startOver = req.body?.startOver === true;

  const open = await findOpenAttempt(test._id, req.user.id);
  if (open?.status === "closing") {
    // its answers are being marked (or a close was abandoned: finish it)
    if (isStaleClose(open)) await closeAttempt(open, req.user.id, { closedBy: isPastDeadline(open) ? "time" : "student" });
    else return res.status(409).json({ error: "your last attempt at this test is being marked - its results will be ready in a moment", code: "closing", attemptId: open._id });
    if (!startOver) return res.json({ expired: { attemptId: open._id, reason: isPastDeadline(open) ? "time" : "submitted" }, test: testInfo(test) });
  } else if (open) {
    if (isPastDeadline(open)) {
      await closeAttempt(open, req.user.id, { closedBy: "time" });
      if (!startOver) return res.json({ expired: { attemptId: open._id, reason: "time" }, test: testInfo(test) });
    } else {
      const state = await currentState(open, test, req.user.id);
      return res.json(attemptPayload({ ...state, test, resumed: true }));
    }
  }

  const pool = await deliverablePool(test, req.user.id);
  if (pool.length === 0) {
    return res.status(400).json({ error: "this test has no accepted questions to attempt" });
  }

  const targetCount = Math.min(test.targetQuestionCount || pool.length, pool.length);

  // Cross-attempt adaptivity: the opening tier comes from what this student
  // has shown on these topics before, not from a fixed "medium". With no
  // history (or too little to be meaningful) this returns "medium", so a
  // first attempt behaves exactly as it did before mastery existed.
  const masteryMap = await masteryMapForSubject(req.user.id, test.subjectId);
  const topicIds = [...new Set(pool.map((q) => String(q.topicId || q.topic)))];
  const difficulty = startingDifficulty(topicIds, masteryMap);
  const firstQuestion = pickNextQuestion(pool, [], difficulty, masteryMap, { types: typesOwed(test.mix, [], { sectioned: test.sectioned }) });

  const attempt = await createAttempt({
    testId: test._id,
    subjectId: test.subjectId,
    ownerId: req.user.id,
    targetCount,
    currentDifficulty: difficulty,
    shownQuestionIds: [firstQuestion._id],
    durationMinutes: test.durationMinutes,
  });

  res.status(201).json(attemptPayload({ attempt, test, question: firstQuestion }));
});

async function loadOwnedAttempt(req, res, next) {
  const attempt = await findOwnedAttempt(req.params.id, req.user.id);
  if (!attempt) return res.status(404).json({ error: "attempt not found" });
  req.attempt = attempt;
  next();
}

// POST /api/attempts/:id/responses - record one answer, then (if the
// attempt isn't at its target count yet) pick and return the next
// question. mcq answers are scored - and the staircase stepped - the
// instant they're submitted. Theory answers can't be authoritatively
// graded that fast (the good path is an LLM call), so two different
// scores exist for a theory response: a fast key-point "quick score"
// computed here only to decide whether the next question should be easier
// or harder, and the authoritative score (LLM-preferred) computed later at
// submission by gradeAttemptResponses. The quick score never gets persisted
// as the response's real score.
router.post("/attempts/:id/responses", loadOwnedAttempt, async (req, res) => {
  if (req.attempt.status !== "in_progress") {
    return res.status(409).json({ error: "this attempt has already been submitted", code: "submitted" });
  }
  if (isPastDeadline(req.attempt)) {
    return res.status(409).json({ error: "time is up for this test - your answers so far are being submitted", code: "time_up" });
  }

  // Two fields are taken from the request, each checked. Whether the answer
  // is right, its score and the time it took are worked out here - a client
  // cannot send them.
  const body = req.body || {};
  const questionId = id(body.questionId, "questionId");
  const answer = text(body.answer, "answer", { required: false, max: LIMITS.answer, trim: false });

  // Only the question the attempt is currently waiting on can be answered:
  // the most recently shown one. This stops a client from answering
  // questions the staircase never served it, or from probing the pool.
  const shownIds = req.attempt.shownQuestionIds.map(String);
  if (shownIds[shownIds.length - 1] !== String(questionId)) {
    return res.status(409).json({ error: "that is not the question currently awaiting an answer", code: "not_current" });
  }

  // Answers are final. Without this, an upsert would let a client re-submit
  // the same question with a different answer.
  const alreadyAnswered = (await findResponsesByAttempt(req.attempt._id)).some(
    (r) => String(r.questionId) === String(questionId)
  );
  if (alreadyAnswered) {
    return res.status(409).json({ error: "this question has already been answered", code: "already_answered" });
  }

  const [question] = await findQuestionsByIds([questionId]);
  if (!question || String(question.testId) !== String(req.attempt.testId)) {
    return res.status(404).json({ error: "question not found on this test" });
  }
  const test = await findOwnedTest(req.attempt.testId, req.user.id);
  if (!test) return res.status(404).json({ error: "test not found" });

  // Take the question, so two requests answering it at once cannot both be
  // recorded: the second is told it was already answered.
  const tracked = "awaitingQuestionId" in req.attempt;
  if (tracked && !(await takeAwaitedQuestion(req.attempt._id, questionId))) {
    return res.status(409).json({ error: "this question has already been answered", code: "already_answered" });
  }

  const isMcq = question.type === "mcq";
  const isCorrect = isMcq ? answer === question.answerKey : null;
  const score = isMcq ? (isCorrect ? 1 : 0) : null; // null = "not graded yet"

  let response;
  try {
    response = await upsertResponse({
      attemptId: req.attempt._id,
      questionId,
      answer,
      isCorrect,
      score,
      timeMs: serverTimeMs(req.attempt, body.timeMs),
    });
  } catch (err) {
    if (tracked) await setAwaitedQuestion(req.attempt._id, questionId); // not saved: it is still waiting
    throw err;
  }

  const wasGood = isMcq ? isCorrect : quickTheoryScore(question, answer) >= 0.5;
  // a question left blank on purpose says nothing about the level: stay there
  const nextTier = isMcq && !String(answer ?? "").trim() ? req.attempt.currentDifficulty : nextDifficulty(req.attempt.currentDifficulty, wasGood);

  let nextQuestion = null;
  let attempt = req.attempt;
  if (attempt.shownQuestionIds.length < attempt.targetCount) {
    ({ question: nextQuestion, attempt } = await serveNext(attempt, test, nextTier, req.user.id));
  }

  res.json({
    // Deliberately no isCorrect / score here: correctness is only revealed
    // after submission, so it can't be used to work out the answer key
    // mid-attempt.
    response: { _id: response._id, questionId: response.questionId, timeMs: response.timeMs },
    nextQuestion: nextQuestion ? forAttemptTaking(nextQuestion) : null,
    progress: { shown: attempt.shownQuestionIds.length, target: attempt.targetCount },
    ...clockOf(attempt),
  });
});

// Work out an attempt's scores from its responses: the per-topic ranking
// (unanswered questions count as 0 for their topic), the document roll-up and
// the marks out of the whole paper.
// An MCQ left blank on purpose (negative marking): no answer, so it counts
// like an unanswered question for the topic, and not as evidence for mastery.
const isBlank = (r, questionsById) => questionsById.get(String(r.questionId))?.type !== "theory" && !String(r.answer ?? "").trim();
const withoutBlanks = (responses, questionsById) => responses.filter((r) => !isBlank(r, questionsById));

function scoreAttempt({ attempt, test, responses, questionsById, observationsByTopic }) {
  const given = withoutBlanks(responses, questionsById);
  const answered = new Set(given.map((r) => String(r.questionId)));
  const unansweredIds = attempt.shownQuestionIds.map(String).filter((qid) => !answered.has(qid));
  const topicScores = markEvidence(computeTopicScores(questionsById, given, { unansweredIds }), observationsByTopic);
  const marks = computeMarksSummary(questionsById, responses, {
    shownQuestionIds: attempt.shownQuestionIds,
    targetCount: attempt.targetCount,
    marksPerQuestion: test?.marksPerQuestion,
    theoryMarks: test?.theoryMarks,
    mix: test?.mix,
    negativeMarks: test?.negativeMarks || 0,
  });
  return { topicScores, documentScores: computeDocumentRollup(topicScores), marks };
}

// How long a close may run before another request may take it over (the
// server stopped part way). Well above the slowest real close: twenty theory
// answers marked four at a time, each LLM call allowed two tries of twenty
// seconds, plus the feedback wording.
const STALE_CLOSE_MS = 10 * 60_000;
const isStaleClose = (attempt) => attempt.status === "closing" && Date.now() - new Date(attempt.closingAt || 0).getTime() > STALE_CLOSE_MS;

function beingMarked(attempt) {
  const err = new InputError("this attempt is being marked - its results will be ready in a moment", 409);
  err.code = "closing";
  err.details = { attemptId: attempt._id };
  return err;
}

/**
 * Close an attempt: grade any ungraded theory responses, compute the
 * deterministic per-topic score, phrase it (LLM or template), then - only if
 * this request still holds the claim - mark it submitted, fold it into
 * mastery and store the report. Used when the student submits, and by the
 * server when an attempt's time has run out. Only one close finishes per
 * attempt (see claimAttemptForClosing).
 */
async function closeAttempt(attempt, ownerId, { closedBy = "student" } = {}) {
  if (attempt.status === "submitted") {
    const existing = await findFeedbackByAttempt(attempt._id);
    if (existing) return { attempt, feedback: existing };
    // Submitted, but no report: the report is written a moment after the
    // attempt turns "submitted", so only a long gap means the server stopped
    // in between - then the report is rebuilt (mastery is not applied twice).
    if (Date.now() - new Date(attempt.submittedAt || 0).getTime() < 60_000) throw beingMarked(attempt);
    const prepared = await prepareReport(attempt, ownerId, { withMastery: false });
    return { attempt, feedback: await saveReport(attempt, ownerId, prepared) };
  }
  let token = null;
  if (attempt.status === "in_progress") token = await claimAttemptForClosing(attempt._id);
  else if (isStaleClose(attempt)) token = await reclaimStaleClose(attempt._id, attempt.closeToken);
  if (!token) throw beingMarked(attempt);

  try {
    const [responses, allQuestions] = await Promise.all([findResponsesByAttempt(attempt._id), findQuestionsByTest(attempt.testId)]);
    const questionsById = new Map(allQuestions.map((q) => [String(q._id), q]));
    const gradeUpdates = await gradeAttemptResponses(responses, questionsById);
    await Promise.all(
      gradeUpdates.map((u) =>
        updateResponseGrade({
          attemptId: u.attemptId,
          questionId: u.questionId,
          score: u.score,
          gradedBy: u.gradedBy,
          graderNote: u.note,
          keyPointResults: u.keyPointResults,
          flagged: u.flagged,
          promptVersion: u.promptVersion,
          model: u.model,
        })
      )
    );
    // everything slow (marking, the feedback wording) happens before the
    // attempt turns "submitted"; after it, only quick writes
    const prepared = await prepareReport(attempt, ownerId, { withMastery: true });
    const closed = await markAttemptSubmitted(attempt._id, { closedBy, token });
    if (!closed) throw beingMarked(attempt); // another request took the close over
    await Promise.all(
      prepared.masteryRows.map((d) =>
        upsertMastery({ ownerId, subjectId: attempt.subjectId, topicId: d.topicId, topicLabel: d.topicLabel, pKnown: d.after, observations: d.observations })
      )
    );
    const feedback = await saveReport(closed, ownerId, prepared);
    markActivity(ownerId, "test").catch(() => {});
    return { attempt: closed, feedback };
  } catch (err) {
    await releaseAttemptClaim(attempt._id, token);
    throw err;
  }
}

/**
 * Everything the report of an attempt holds, worked out from its (graded)
 * responses, without writing anything. With `withMastery`, the attempt's
 * effect on the student's running per-topic mastery is worked out too - the
 * step that makes testing adaptive ACROSS attempts: it decides the opening
 * difficulty, and which topics get questioned, next time. Before/after is
 * kept so the feedback can say what moved.
 */
async function prepareReport(attempt, ownerId, { withMastery }) {
  const [responses, allQuestions, test] = await Promise.all([
    findResponsesByAttempt(attempt._id),
    findQuestionsByTest(attempt.testId),
    findOwnedTest(attempt.testId, ownerId),
  ]);
  const questionsById = new Map(allQuestions.map((q) => [String(q._id), q]));
  const existingMastery = await masteryMapForSubject(ownerId, attempt.subjectId);
  const observationsByTopic = new Map([...existingMastery.entries()].map(([k, m]) => [String(k), m.observations || 0]));
  let masteryRows = [];
  if (withMastery) {
    masteryRows = [...applyAttemptToMastery({ responses: withoutBlanks(responses, questionsById), questionsById, existing: existingMastery }).values()];
    for (const d of masteryRows) observationsByTopic.set(String(d.topicId), d.observations);
  }
  const masteryDeltas = masteryRows.map(({ topicId, topicLabel, before, after, responses: n }) => ({ topicId, topicLabel, before, after, responses: n }));
  const { topicScores, documentScores, marks } = scoreAttempt({ attempt, test, responses, questionsById, observationsByTopic });
  const { text: feedbackText, generatedBy, promptVersion = null, model = null } = await phraseFeedback(topicScores, masteryDeltas);
  return { masteryRows, masteryDeltas, topicScores, documentScores, marks, feedbackText, generatedBy, promptVersion, model };
}

function saveReport(attempt, ownerId, p) {
  return createFeedbackReport({
    attemptId: attempt._id,
    ownerId,
    subjectId: attempt.subjectId,
    topicScores: p.topicScores,
    documentScores: p.documentScores,
    masteryDeltas: p.masteryDeltas,
    feedbackText: p.feedbackText,
    generatedBy: p.generatedBy,
    promptVersion: p.promptVersion,
    model: p.model,
    marksAwarded: p.marks.marksAwarded,
    marksPossible: p.marks.marksPossible,
  });
}

// POST /api/attempts/:id/submit - close the attempt (see closeAttempt).
// The page sends { timedOut: true } when its countdown reached zero; it is
// believed only when the deadline really is (nearly) here.
router.post("/attempts/:id/submit", loadOwnedAttempt, async (req, res) => {
  const left = msLeft(req.attempt);
  const timedOut = left !== null && (left < 0 || (req.body?.timedOut === true && left < 5000));
  const out = await closeAttempt(req.attempt, req.user.id, { closedBy: timedOut ? "time" : "student" });
  res.json({ attempt: publicDoc(out.attempt), feedback: publicDoc(out.feedback) });
});

router.get("/attempts/:id/feedback", loadOwnedAttempt, async (req, res) => {
  let attempt = req.attempt;
  // an attempt left open after its time ran out is closed on first look, and
  // a close abandoned part way (the server stopped) is finished
  if ((attempt.status === "in_progress" && isPastDeadline(attempt)) || isStaleClose(attempt)) {
    attempt = (await closeAttempt(attempt, req.user.id, { closedBy: isPastDeadline(attempt) ? "time" : "student" })).attempt;
  }
  if (attempt.status === "closing") {
    return res.status(409).json({ error: "your answers are being marked - this page will update in a moment", code: "closing" });
  }
  let feedback = await findFeedbackByAttempt(attempt._id);
  if (!feedback && attempt.status === "submitted") feedback = (await closeAttempt(attempt, req.user.id)).feedback;
  if (!feedback) return res.status(404).json({ error: "no results yet - this attempt has not been submitted", code: "in_progress" });
  // Extra context for the results screen (test name, subject, timing). Purely additive.
  const test = await findOwnedTest(attempt.testId, req.user.id);
  res.json({
    feedback: publicDoc(feedback),
    attempt: {
      _id: attempt._id,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      targetCount: attempt.targetCount,
      closedBy: attempt.closedBy || "student",
    },
    test: test ? testInfo(test) : null,
  });
});

// GET /api/attempts/:id/review - question by question, after submission:
// what was asked, the student's answer, the right answer (or the model answer
// and which key points were covered), the marks and why, and the passage of
// the notes the question came from. Never before submission: it holds the
// answer keys.
router.get("/attempts/:id/review", loadOwnedAttempt, async (req, res) => {
  if (req.attempt.status !== "submitted") {
    return res.status(409).json({ error: "the answers are shown once the test is submitted" });
  }
  const [questions, responses, reports] = await Promise.all([
    findQuestionsByIds(req.attempt.shownQuestionIds),
    findResponsesByAttempt(req.attempt._id),
    findReportsByOwner(req.user.id, { testId: req.attempt.testId }),
  ]);
  const test = await findOwnedTest(req.attempt.testId, req.user.id);
  const negative = test?.negativeMarks || 0;
  const byId = new Map(questions.map((q) => [String(q._id), q]));
  const responseBy = new Map(responses.map((r) => [String(r.questionId), r]));
  const reportBy = new Map(reports.map((r) => [String(r.questionId), r]));

  const items = req.attempt.shownQuestionIds
    .map((qid, i) => {
      const q = byId.get(String(qid));
      if (!q) return null;
      const r = responseBy.get(String(qid));
      const answered = Boolean(r);
      const score = answered ? (typeof r.score === "number" ? r.score : r.isCorrect ? 1 : 0) : 0;
      const theory = q.type === "theory";
      // an MCQ left blank on purpose (negative marking): no answer, no penalty
      const skipped = answered && !theory && !String(r.answer ?? "").trim();
      const penalty = answered && !theory && !skipped && r.isCorrect === false ? negative : 0;
      return {
        number: i + 1,
        questionId: q._id,
        type: q.type,
        prompt: q.prompt,
        guidance: q.guidance || null,
        options: theory ? null : q.options,
        topicId: q.topicId || null,
        topic: q.topic,
        subtopic: q.subtopic || null,
        parentTopicId: q.parentTopicId || null,
        parentTopic: q.parentTopic || null,
        difficulty: q.difficulty,
        marks: q.marks || 0,
        marksAwarded: Number((score * (q.marks || 0) - penalty).toFixed(2)),
        penalty,
        answered: answered && !skipped,
        skipped,
        answer: answered && !skipped ? r.answer : null,
        isCorrect: theory ? null : answered ? Boolean(r.isCorrect) : false,
        correctAnswer: theory ? null : q.answerKey,
        modelAnswer: theory ? q.answerKey : null,
        keyPoints: theory ? (answered && r.keyPointResults) || keyPointMatches(answered ? r.answer : "", q.keyPoints) : null,
        graderNote: skipped
          ? "Left blank - no marks, and no penalty."
          : penalty
            ? `Wrong answer: ${penalty} ${penalty === 1 ? "mark" : "marks"} taken off (negative marking).`
            : answered
              ? r.graderNote || null
              : "Not answered.",
        gradedBy: answered ? r.gradedBy || (theory ? null : "answer-key") : null,
        flagged: Boolean(r?.flagged),
        // the passage of the notes this question was written from
        source: q.supportingExcerpt || null,
        remark: r?.remark ? { requestedAt: r.remark.requestedAt, before: r.remark.before, after: r.remark.after } : null,
        canRemark: theory && answered && Boolean(String(r.answer || "").trim()) && !r.remark,
        reported: reportBy.get(String(qid))?.reason || null,
      };
    })
    .filter(Boolean);

  res.json({ attemptId: req.attempt._id, items });
});

const remarking = new Set(); // "attemptId|questionId" being marked again right now

// POST /api/attempts/:id/questions/:questionId/remark  { reason? }
// Ask for a theory answer to be marked again. Once per question. The second
// marking is independent and goes key point by key point
// (gradingEngine.remarkTheoryResponse); its result replaces the first, up or
// down, and both are kept. The reason is stored with the request, not shown
// to the marker. MCQs are marked against their answer key by code: a wrong
// key is reported with "Report this question" instead.
router.post("/attempts/:id/questions/:questionId/remark", loadOwnedAttempt, async (req, res) => {
  if (req.attempt.status !== "submitted") return res.status(409).json({ error: "submit the test first" });
  const questionId = req.params.questionId;
  if (!req.attempt.shownQuestionIds.map(String).includes(String(questionId))) {
    return res.status(404).json({ error: "question not found on this attempt" });
  }
  const reason = text(req.body?.reason, "reason", { required: false, max: 1000 });
  const [question] = await findQuestionsByIds([questionId]);
  if (!question) return res.status(404).json({ error: "question not found on this attempt" });
  if (question.type !== "theory") {
    return res.status(400).json({
      error: "multiple-choice answers are marked against the answer key, so marking again would not change them - if the key is wrong, report the question",
    });
  }
  const responses = await findResponsesByAttempt(req.attempt._id);
  const response = responses.find((r) => String(r.questionId) === String(questionId));
  if (!response || !String(response.answer || "").trim()) {
    return res.status(400).json({ error: "there is no answer to mark again" });
  }
  if (response.remark) return res.status(409).json({ error: "this answer has already been marked again" });
  // one re-mark at a time per answer, so two requests sent together cannot
  // both run (this server process; see docs/SECURITY.md on in-memory limits)
  const key = `${req.attempt._id}|${questionId}`;
  if (remarking.has(key)) return res.status(409).json({ error: "this answer is already being marked again" });
  remarking.add(key);
  let graded;
  const before = typeof response.score === "number" ? response.score : 0;
  try {
    graded = await remarkTheoryResponse(question, response.answer);
    await recordRemark({ attemptId: req.attempt._id, questionId: question._id, before, reason, graded });
  } finally {
    remarking.delete(key);
  }

  // the report's marks and topic scores follow the new mark (the written
  // feedback and the mastery record are left as they were)
  const [allQuestions, test, fresh, masteryRows] = await Promise.all([
    findQuestionsByTest(req.attempt.testId),
    findOwnedTest(req.attempt.testId, req.user.id),
    findResponsesByAttempt(req.attempt._id),
    findMasteryBySubject(req.user.id, req.attempt.subjectId),
  ]);
  const questionsById = new Map(allQuestions.map((q) => [String(q._id), q]));
  const observationsByTopic = new Map(masteryRows.map((m) => [String(m.topicId), m.observations || 0]));
  const { topicScores, documentScores, marks } = scoreAttempt({ attempt: req.attempt, test, responses: fresh, questionsById, observationsByTopic });
  // template wording is redone from the new scores; wording written by an LLM
  // is kept, and the results page says it was written before the re-mark
  const report = await findFeedbackByAttempt(req.attempt._id);
  const feedbackText = report?.generatedBy === "template" ? templateFeedback(topicScores, report.masteryDeltas || []) : undefined;
  const updated = await updateFeedbackScores(req.attempt._id, {
    topicScores,
    documentScores,
    marksAwarded: marks.marksAwarded,
    marksPossible: marks.marksPossible,
    feedbackText,
  });

  res.json({
    remark: { before, after: graded.score, gradedBy: graded.gradedBy, note: graded.note, keyPoints: graded.keyPointResults },
    marks: { marksAwarded: marks.marksAwarded, marksPossible: marks.marksPossible },
    feedback: updated ? publicDoc(updated) : null,
  });
});

// POST /api/questions/:questionId/report  { reason, comment?, attemptId? }
// "Report this question": wrong answer, unclear, not from the notes, a
// repeat, or other. Allowed during a test and after it. The question is left
// out of the student's future attempts at that test (it still counts in the
// attempt it was reported from, so reporting is no way to skip a question).
router.post("/questions/:questionId/report", async (req, res) => {
  const reason = oneOf(req.body?.reason, "reason", REPORT_REASONS);
  const comment = text(req.body?.comment, "comment", { required: false, max: 500 });
  const attemptId = req.body?.attemptId === undefined || req.body?.attemptId === null ? null : id(req.body.attemptId, "attemptId");
  const [question] = await findQuestionsByIds([req.params.questionId]);
  const test = question ? await findOwnedTest(question.testId, req.user.id) : null;
  if (!test) return res.status(404).json({ error: "question not found" });
  if (attemptId) {
    const attempt = await findOwnedAttempt(attemptId, req.user.id);
    if (!attempt || String(attempt.testId) !== String(test._id)) return res.status(404).json({ error: "attempt not found" });
  }
  await saveQuestionReport({
    questionId: question._id,
    testId: test._id,
    subjectId: test.subjectId,
    ownerId: req.user.id,
    attemptId,
    reason,
    comment,
  });
  res.status(201).json({ ok: true, reported: reason });
});

// GET /api/revision?tz=Asia/Kolkata - for the home page: the streak of days
// with a finished test, and up to five topics worth revising next (shaky, or
// not practised for a week), each with its subject and a link target.
router.get("/revision", async (req, res) => {
  const timeZone = typeof req.query.tz === "string" ? req.query.tz.slice(0, 64) : "UTC";
  const [attempts, masteryRows, subjects] = await Promise.all([
    findAttemptsByOwner(req.user.id),
    findMasteryByOwner(req.user.id),
    findSubjectsByOwner(req.user.id),
  ]);
  const streak = streakOf(
    attempts.filter((a) => a.status === "submitted" && a.submittedAt).map((a) => a.submittedAt),
    { timeZone }
  );
  const subjectName = new Map(subjects.map((s) => [String(s._id), s.name]));
  const due = dueTopics(masteryRows.filter((m) => subjectName.has(String(m.subjectId))), { limit: 20 });
  // current names: a renamed note shows its new name
  const notes = await findNotesByIds(due.map((d) => d.topicId));
  const parents = await findNotesByIds([...new Set(notes.filter((n) => n.parentNoteId).map((n) => String(n.parentNoteId)))]);
  const byId = new Map([...notes, ...parents].map((n) => [String(n._id), n]));
  res.json({
    streak,
    due: due
      .filter((d) => byId.has(String(d.topicId)))
      .slice(0, 5)
      .map((d) => ({
        subjectId: d.subjectId,
        subject: subjectName.get(String(d.subjectId)),
        topicId: d.topicId,
        topic: topicLabelFor(byId.get(String(d.topicId)), byId),
        pKnown: d.pKnown,
        daysSince: d.daysSince,
        reason: d.reason,
      })),
  });
});

// GET /api/subjects/:id/progress - everything the progress view needs in one
// call: where the student stands per topic, how that has moved across
// attempts, and the attempt history itself. Deliberately one round trip,
// because these three are only meaningful read together.
router.get("/subjects/:id/progress", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const [masteryRows, reports, attempts, tests, notes] = await Promise.all([
    findMasteryBySubject(req.user.id, subject._id),
    findFeedbackBySubject(req.user.id, subject._id),
    findAttemptsBySubject(req.user.id, subject._id),
    findTestsBySubject(subject._id),
    findNotesBySubject(subject._id),
  ]);
  // topicId is a note id, so the note hierarchy says which document a topic
  // is a subtopic of - read fresh, so a renamed document shows its new name.
  const noteById = new Map(notes.map((n) => [String(n._id), n]));

  const testTitleById = new Map(tests.map((t) => [String(t._id), t.title]));

  // Per topic, the trajectory of mastery across every submitted attempt, in
  // chronological order, so the client can draw a trend without recomputing
  // anything from raw responses.
  const trendByTopic = new Map();
  for (const r of reports) {
    for (const d of r.masteryDeltas || []) {
      const key = String(d.topicId);
      if (!trendByTopic.has(key)) trendByTopic.set(key, []);
      trendByTopic.get(key).push({ at: r.createdAt, value: d.after });
    }
  }

  const topics = masteryRows
    .map((m) => {
      const note = noteById.get(String(m.topicId));
      const parent = note?.parentNoteId ? noteById.get(String(note.parentNoteId)) : null;
      return {
        topicId: m.topicId,
        // the note's name now, so a renamed note keeps its history under its new name
        topic: note ? topicLabelFor(note, noteById) : m.topicLabel,
        subtopic: parent ? note.title : null,
        parentTopicId: parent ? parent._id : null,
        parentTopic: parent ? parent.title : null,
        pKnown: m.pKnown,
        observations: m.observations,
        // fewer answers than this and the topic is not called weak or strong
        enoughEvidence: (m.observations || 0) >= MIN_OBSERVATIONS_FOR_VERDICT,
        // What tier this topic alone would be served at - the visible link
        // between the progress view and what the next test will feel like.
        tier: difficultyForMastery(m.pKnown),
        updatedAt: m.updatedAt,
        trend: trendByTopic.get(String(m.topicId)) || [],
      };
    })
    .sort((a, b) => a.pKnown - b.pKnown); // weakest first

  const submitted = attempts.filter((a) => a.status === "submitted");
  const feedbackByAttempt = new Map(reports.map((r) => [String(r.attemptId), r]));
  const history = submitted.map((a) => {
    const fb = feedbackByAttempt.get(String(a._id));
    return {
      attemptId: a._id,
      testId: a.testId,
      testTitle: testTitleById.get(String(a.testId)) || "Untitled test",
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
      questionsAnswered: a.shownQuestionIds?.length || 0,
      marksAwarded: fb?.marksAwarded ?? null,
      marksPossible: fb?.marksPossible ?? null,
    };
  });

  res.json({
    subject: { _id: subject._id, name: subject.name },
    topics,
    history,
    minObservations: MIN_OBSERVATIONS_FOR_VERDICT,
    // Weakest three with enough answers to judge - what the test builder
    // suggests drawing the next test from.
    recommendedTopicIds: topics.filter((t) => t.enoughEvidence).slice(0, 3).map((t) => t.topicId),
    // tested, but too few times to judge: another test will tell
    undertestedTopicIds: topics.filter((t) => t.observations > 0 && !t.enoughEvidence).map((t) => t.topicId),
  });
});

export default router;
