import { Router } from "express";
import { findOwnedSubject } from "../models/Subject.js";
import { findNotesByIds } from "../models/Note.js";
import { createTest, findTestsBySubject, findOwnedTest } from "../models/Test.js";
import { createQuestions, findQuestionsByTest } from "../models/Question.js";
import { requireAuth } from "../middleware/auth.js";
import { generateQuestions } from "../services/testEngine.js";

const router = Router();
router.use(requireAuth);

// POST /api/subjects/:id/tests - build a test from a set of that subject's notes.
router.post("/subjects/:id/tests", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const { title, noteIds, mcqCount = 5, marksPerQuestion = 1, durationMinutes = 15 } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: "title is required" });
  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    return res.status(400).json({ error: "noteIds must be a non-empty array of note ids from this subject" });
  }

  const notes = await findNotesByIds(noteIds);
  const notesInSubject = notes.filter((n) => String(n.subjectId) === String(subject._id));
  if (notesInSubject.length === 0) {
    return res.status(400).json({ error: "none of the given noteIds belong to this subject" });
  }

  const test = await createTest({
    ownerId: req.user.id,
    subjectId: subject._id,
    title: title.trim(),
    noteIds: notesInSubject.map((n) => n._id),
    marksPerQuestion,
    durationMinutes,
  });

  const { accepted, discarded, generatedBy } = await generateQuestions(notesInSubject, {
    mcqCount: Math.max(1, Math.min(mcqCount, 20)),
    marksPerQuestion,
  });

  const stored = await createQuestions([...accepted, ...discarded].map((q) => ({ ...q, testId: test._id })));

  res.status(201).json({
    test,
    generatedBy,
    accepted: stored.filter((q) => q.status === "accepted").length,
    discarded: stored.filter((q) => q.status === "discarded").length,
  });
});

router.get("/subjects/:id/tests", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const tests = await findTestsBySubject(subject._id);
  res.json({ tests });
});

// GET /api/tests/:id - builder/review view: includes answer keys and
// discarded items, so only the owner should ever call this (never expose
// it to a student mid-attempt).
router.get("/tests/:id", async (req, res) => {
  const test = await findOwnedTest(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: "test not found" });

  const questions = await findQuestionsByTest(test._id);
  res.json({ test, questions });
});

export default router;
