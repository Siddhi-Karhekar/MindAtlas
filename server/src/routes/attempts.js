import { Router } from "express";
import { findOwnedTest } from "../models/Test.js";
import { findQuestionsByTest, findQuestionsByIds } from "../models/Question.js";
import { createAttempt, findAttemptsBySubject, findOwnedAttempt, markAttemptSubmitted, recordQuestionShown } from "../models/Attempt.js";
import { upsertResponse, findResponsesByAttempt, updateResponseGrade } from "../models/Response.js";
import { createFeedbackReport, findFeedbackByAttempt, findFeedbackBySubject } from "../models/FeedbackReport.js";
import { requireAuth } from "../middleware/auth.js";
import { computeDocumentRollup, computeTopicScores, computeMarksSummary, phraseFeedback } from "../services/feedbackEngine.js";
import { gradeAttemptResponses, quickTheoryScore } from "../services/gradingEngine.js";
import { nextDifficulty, pickNextQuestion, startingDifficulty } from "../services/adaptiveEngine.js";
import { applyAttemptToMastery } from "../services/masteryEngine.js";
import { findMasteryBySubject, masteryMapForSubject, upsertMastery } from "../models/Mastery.js";
import { findOwnedSubject } from "../models/Subject.js";
import { difficultyForMastery } from "../services/masteryEngine.js";
import { findTestsBySubject } from "../models/Test.js";
import { findNotesBySubject } from "../models/Note.js";

const router = Router();
router.use(requireAuth);

function forAttemptTaking(question) {
  // never send the answer key, supporting excerpt, or (for theory
  // questions) the grading rubric to the client while a test is in
  // progress - only after submission, via the feedback report.
  const { answerKey, supportingExcerpt, keyPoints, ...safe } = question;
  return safe;
}

function progressOf(attempt) {
  return { shown: attempt.shownQuestionIds.length, target: attempt.targetCount };
}

// POST /api/tests/:id/attempts - start an attempt. Delivery is adaptive
// (adaptiveEngine.js): this hands back just the FIRST question, picked at
// the staircase's starting ("medium") difficulty, not the whole set - see
// POST /responses below for how the rest are chosen.
router.post("/tests/:id/attempts", async (req, res) => {
  const test = await findOwnedTest(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: "test not found" });

  const pool = await findQuestionsByTest(test._id, { onlyAccepted: true });
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
  const firstQuestion = pickNextQuestion(pool, [], difficulty, masteryMap);

  const attempt = await createAttempt({
    testId: test._id,
    subjectId: test.subjectId,
    ownerId: req.user.id,
    targetCount,
    currentDifficulty: difficulty,
    shownQuestionIds: [firstQuestion._id],
  });

  res.status(201).json({
    attempt,
    // Lets the focus-mode screen show the test's name and enforce its time limit.
    test: { _id: test._id, title: test.title, subjectId: test.subjectId, durationMinutes: test.durationMinutes },
    question: forAttemptTaking(firstQuestion),
    progress: progressOf(attempt),
  });
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
// scores exist for a theory response: a fast keyword-overlap "quick
// score" computed here only to decide whether the next question should
// be easier or harder, and the authoritative score (LLM-preferred)
// computed later at submission by gradeAttemptResponses. Using the quick
// score for scoring itself would be a regression; it never gets persisted
// as the response's real score.
router.post("/attempts/:id/responses", loadOwnedAttempt, async (req, res) => {
  if (req.attempt.status !== "in_progress") {
    return res.status(400).json({ error: "this attempt has already been submitted" });
  }

  const { questionId, answer, timeMs = 0 } = req.body || {};
  if (!questionId) return res.status(400).json({ error: "questionId is required" });

  // Only the question the attempt is currently waiting on can be answered:
  // the most recently shown one. This stops a client from answering
  // questions the staircase never served it, or from probing the pool.
  const shownIds = req.attempt.shownQuestionIds.map(String);
  if (shownIds[shownIds.length - 1] !== String(questionId)) {
    return res.status(409).json({ error: "that is not the question currently awaiting an answer" });
  }

  // Answers are final. Without this, an upsert would let a client re-submit
  // the same question with a different answer.
  const alreadyAnswered = (await findResponsesByAttempt(req.attempt._id)).some(
    (r) => String(r.questionId) === String(questionId)
  );
  if (alreadyAnswered) {
    return res.status(409).json({ error: "this question has already been answered" });
  }

  const [question] = await findQuestionsByIds([questionId]);
  if (!question || String(question.testId) !== String(req.attempt.testId)) {
    return res.status(404).json({ error: "question not found on this test" });
  }

  const isMcq = question.type === "mcq";
  const isCorrect = isMcq ? answer === question.answerKey : null;
  const score = isMcq ? (isCorrect ? 1 : 0) : null; // null = "not graded yet"

  const response = await upsertResponse({
    attemptId: req.attempt._id,
    questionId,
    answer,
    isCorrect,
    score,
    timeMs,
  });

  const wasGood = isMcq ? isCorrect : quickTheoryScore(question, answer) >= 0.5;
  const nextTier = nextDifficulty(req.attempt.currentDifficulty, wasGood);

  let nextQuestion = null;
  let shownQuestionIds = req.attempt.shownQuestionIds;
  let currentDifficulty = req.attempt.currentDifficulty;

  if (req.attempt.shownQuestionIds.length < req.attempt.targetCount) {
    const [pool, masteryMap] = await Promise.all([
      findQuestionsByTest(req.attempt.testId, { onlyAccepted: true }),
      masteryMapForSubject(req.user.id, req.attempt.subjectId),
    ]);
    nextQuestion = pickNextQuestion(pool, req.attempt.shownQuestionIds, nextTier, masteryMap);
    if (nextQuestion) {
      shownQuestionIds = [...req.attempt.shownQuestionIds, nextQuestion._id];
      currentDifficulty = nextTier;
      await recordQuestionShown(req.attempt._id, { shownQuestionIds, currentDifficulty });
    }
  }

  res.json({
    // Deliberately no isCorrect / score here: correctness is only revealed
    // after submission, via the feedback report, so it can't be used to
    // work out the answer key mid-attempt.
    response: { _id: response._id, questionId: response.questionId, timeMs: response.timeMs },
    nextQuestion: nextQuestion ? forAttemptTaking(nextQuestion) : null,
    progress: { shown: shownQuestionIds.length, target: req.attempt.targetCount },
  });
});

// POST /api/attempts/:id/submit - close the attempt, grade any ungraded
// theory responses, compute the deterministic per-topic score, then
// phrase it (LLM or template).
router.post("/attempts/:id/submit", loadOwnedAttempt, async (req, res) => {
  if (req.attempt.status !== "in_progress") {
    const existing = await findFeedbackByAttempt(req.attempt._id);
    return res.json({ attempt: req.attempt, feedback: existing });
  }

  const [responses, allQuestions] = await Promise.all([
    findResponsesByAttempt(req.attempt._id),
    findQuestionsByTest(req.attempt.testId),
  ]);
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
      })
    )
  );

  const topicScores = computeTopicScores(questionsById, responses);
  const { marksAwarded, marksPossible } = computeMarksSummary(questionsById, responses);

  // Fold this attempt into the student's running per-topic mastery. This is
  // the step that makes testing adaptive ACROSS attempts: what happens here
  // decides the opening difficulty, and which topics get questioned, next
  // time. Before/after is kept so the feedback can say what moved rather than
  // only where the student now stands.
  const existingMastery = await masteryMapForSubject(req.user.id, req.attempt.subjectId);
  const deltas = applyAttemptToMastery({ responses, questionsById, existing: existingMastery });
  await Promise.all(
    [...deltas.values()].map((d) =>
      upsertMastery({
        ownerId: req.user.id,
        subjectId: req.attempt.subjectId,
        topicId: d.topicId,
        topicLabel: d.topicLabel,
        pKnown: d.after,
        observations: d.observations,
      })
    )
  );
  const masteryDeltas = [...deltas.values()].map(({ topicId, topicLabel, before, after, responses: n }) => ({
    topicId, topicLabel, before, after, responses: n,
  }));

  const { text, generatedBy } = await phraseFeedback(topicScores, masteryDeltas);

  const attempt = await markAttemptSubmitted(req.attempt._id);
  const feedback = await createFeedbackReport({
    attemptId: req.attempt._id,
    ownerId: req.user.id,
    subjectId: req.attempt.subjectId,
    topicScores,
    documentScores: computeDocumentRollup(topicScores),
    masteryDeltas,
    feedbackText: text,
    generatedBy,
    marksAwarded,
    marksPossible,
  });

  res.json({ attempt, feedback });
});

router.get("/attempts/:id/feedback", loadOwnedAttempt, async (req, res) => {
  const feedback = await findFeedbackByAttempt(req.attempt._id);
  if (!feedback) return res.status(404).json({ error: "no feedback yet - submit the attempt first" });
  // Extra context for the results screen (test name, subject, timing). Purely additive.
  const test = await findOwnedTest(req.attempt.testId, req.user.id);
  res.json({
    feedback,
    attempt: {
      _id: req.attempt._id,
      startedAt: req.attempt.startedAt,
      submittedAt: req.attempt.submittedAt,
      targetCount: req.attempt.targetCount,
    },
    test: test ? { _id: test._id, title: test.title, subjectId: test.subjectId, durationMinutes: test.durationMinutes } : null,
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
      topic: m.topicLabel,
      subtopic: parent ? note.title : null,
      parentTopicId: parent ? parent._id : null,
      parentTopic: parent ? parent.title : null,
      pKnown: m.pKnown,
      observations: m.observations,
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
    // Weakest three with at least one observation - what the test builder
    // suggests drawing the next test from.
    recommendedTopicIds: topics.filter((t) => t.observations > 0).slice(0, 3).map((t) => t.topicId),
  });
});

export default router;
