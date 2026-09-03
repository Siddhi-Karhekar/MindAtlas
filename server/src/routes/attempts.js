import { Router } from "express";
import { findOwnedTest } from "../models/Test.js";
import { findQuestionsByTest, findQuestionsByIds } from "../models/Question.js";
import { createAttempt, findOwnedAttempt, markAttemptSubmitted } from "../models/Attempt.js";
import { upsertResponse, findResponsesByAttempt } from "../models/Response.js";
import { createFeedbackReport, findFeedbackByAttempt } from "../models/FeedbackReport.js";
import { requireAuth } from "../middleware/auth.js";
import { computeTopicScores, phraseFeedback } from "../services/feedbackEngine.js";

const router = Router();
router.use(requireAuth);

function forAttemptTaking(question) {
  // never send the answer key or supporting excerpt to the client while a
  // test is in progress - only after submission, via the feedback report.
  const { answerKey, supportingExcerpt, ...safe } = question;
  return safe;
}

// POST /api/tests/:id/attempts - start an attempt.
router.post("/tests/:id/attempts", async (req, res) => {
  const test = await findOwnedTest(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: "test not found" });

  const questions = await findQuestionsByTest(test._id, { onlyAccepted: true });
  if (questions.length === 0) {
    return res.status(400).json({ error: "this test has no accepted questions to attempt" });
  }

  const attempt = await createAttempt({ testId: test._id, ownerId: req.user.id });
  res.status(201).json({ attempt, questions: questions.map(forAttemptTaking) });
});

async function loadOwnedAttempt(req, res, next) {
  const attempt = await findOwnedAttempt(req.params.id, req.user.id);
  if (!attempt) return res.status(404).json({ error: "attempt not found" });
  req.attempt = attempt;
  next();
}

// POST /api/attempts/:id/responses - record (or update) one answer.
router.post("/attempts/:id/responses", loadOwnedAttempt, async (req, res) => {
  if (req.attempt.status !== "in_progress") {
    return res.status(400).json({ error: "this attempt has already been submitted" });
  }

  const { questionId, answer, timeMs = 0 } = req.body || {};
  if (!questionId) return res.status(400).json({ error: "questionId is required" });

  const [question] = await findQuestionsByIds([questionId]);
  if (!question || String(question.testId) !== String(req.attempt.testId)) {
    return res.status(404).json({ error: "question not found on this test" });
  }

  const isCorrect = question.type === "mcq" ? answer === question.answerKey : null;

  const response = await upsertResponse({
    attemptId: req.attempt._id,
    questionId,
    answer,
    isCorrect,
    timeMs,
  });

  res.json({ response: { ...response, isCorrect } });
});

// POST /api/attempts/:id/submit - close the attempt, compute the
// deterministic per-topic score, then phrase it (LLM or template).
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

  const topicScores = computeTopicScores(questionsById, responses);
  const { text, generatedBy } = await phraseFeedback(topicScores);

  const attempt = await markAttemptSubmitted(req.attempt._id);
  const feedback = await createFeedbackReport({
    attemptId: req.attempt._id,
    ownerId: req.user.id,
    topicScores,
    feedbackText: text,
    generatedBy,
  });

  res.json({ attempt, feedback });
});

router.get("/attempts/:id/feedback", loadOwnedAttempt, async (req, res) => {
  const feedback = await findFeedbackByAttempt(req.attempt._id);
  if (!feedback) return res.status(404).json({ error: "no feedback yet - submit the attempt first" });
  res.json({ feedback });
});

export default router;
