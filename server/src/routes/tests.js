import { Router } from "express";
import { findOwnedSubject } from "../models/Subject.js";
import { findChildNotes, findNotesByIds, isSplitParent, topicLabelFor } from "../models/Note.js";
import { createTest, findTestsBySubject, findOwnedTest } from "../models/Test.js";
import { createQuestions, findQuestionsByTest } from "../models/Question.js";
import { requireAuth } from "../middleware/auth.js";
import { generateQuestions } from "../services/testEngine.js";
import { masteryMapForSubject } from "../models/Mastery.js";

const router = Router();
router.use(requireAuth);

// The adaptive controller (adaptiveEngine.js) needs a pool of accepted
// questions deeper than what's actually delivered, so it has real options
// at each difficulty tier - a test asking for `target` questions generates
// roughly 1.5x that many candidates (capped, so this stays a single LLM
// call). Everything above `target` that gets accepted just sits unused in
// the pool if the adaptive walk never needs it.
function poolSizeFor(target) {
  if (target <= 0) return 0;
  return Math.min(24, Math.max(target, Math.ceil(target * 1.5)));
}

// Questions are always drawn from TOPIC notes. Selecting a split document
// means "all of its subtopics", so it is expanded to its children here; a
// subtopic selected on its own is used as is. Each topic note is labelled
// "Document › Subtopic" and carries its parent's id, so every question, the
// feedback report and the mastery record name the specific subtopic.
async function resolveTopicNotes(selected) {
  const parents = selected.filter(isSplitParent);
  const expanded = await findChildNotes(parents.map((p) => p._id));
  const byId = new Map();
  for (const n of [...selected.filter((n) => !isSplitParent(n)), ...expanded]) byId.set(String(n._id), n);
  const topics = [...byId.values()];

  const parentIds = [...new Set(topics.filter((n) => n.parentNoteId).map((n) => String(n.parentNoteId)))];
  const known = new Map(parents.map((p) => [String(p._id), p]));
  const missing = parentIds.filter((id) => !known.has(id));
  for (const p of await findNotesByIds(missing)) known.set(String(p._id), p);

  return topics.map((n) => {
    const parent = n.parentNoteId ? known.get(String(n.parentNoteId)) : null;
    return {
      ...n,
      topicLabel: topicLabelFor(n, known),
      parentTopicId: parent ? parent._id : null,
      parentTopic: parent ? parent.title : null,
    };
  });
}

// POST /api/subjects/:id/tests - build a test from a set of that subject's
// notes. mcqCount and theoryCount are independent - 0/N gives an
// all-theory test, N/0 an all-mcq test (the original behavior), and
// anything else a mixed test. Both counts are how many questions the
// student will actually see; a larger pool is generated behind the scenes
// for the adaptive controller to draw from.
router.post("/subjects/:id/tests", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const { title, noteIds, mcqCount = 5, theoryCount = 0, marksPerQuestion = 1, durationMinutes = 15 } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: "title is required" });
  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    return res.status(400).json({ error: "noteIds must be a non-empty array of note ids from this subject" });
  }

  const safeMcqCount = Math.max(0, Math.min(Number(mcqCount) || 0, 20));
  const safeTheoryCount = Math.max(0, Math.min(Number(theoryCount) || 0, 20));
  if (safeMcqCount + safeTheoryCount < 1) {
    return res.status(400).json({ error: "mcqCount + theoryCount must add up to at least 1" });
  }
  if (safeMcqCount + safeTheoryCount > 20) {
    return res.status(400).json({ error: "mcqCount + theoryCount must not exceed 20" });
  }

  const notes = await findNotesByIds(noteIds);
  const selectedInSubject = notes.filter((n) => String(n.subjectId) === String(subject._id));
  if (selectedInSubject.length === 0) {
    return res.status(400).json({ error: "none of the given noteIds belong to this subject" });
  }
  const notesInSubject = await resolveTopicNotes(selectedInSubject);
  if (notesInSubject.length === 0) {
    return res.status(400).json({ error: "the selected notes have no text to build questions from" });
  }

  const targetQuestionCount = safeMcqCount + safeTheoryCount;

  const test = await createTest({
    ownerId: req.user.id,
    subjectId: subject._id,
    title: title.trim(),
    noteIds: notesInSubject.map((n) => n._id),
    marksPerQuestion,
    durationMinutes,
    targetQuestionCount,
  });

  // The student's accumulated per-topic mastery steers WHICH notes the pool is
  // drawn from: weak and untested topics get more questions than ones already
  // demonstrated. Empty on a first-ever test, in which case generation falls
  // back to an even spread across the selected notes.
  const masteryMap = await masteryMapForSubject(req.user.id, subject._id);

  const { accepted, discarded, mcqGeneratedBy, theoryGeneratedBy } = await generateQuestions(notesInSubject, {
    mcqCount: poolSizeFor(safeMcqCount),
    theoryCount: poolSizeFor(safeTheoryCount),
    marksPerQuestion,
    masteryMap,
  });

  const stored = await createQuestions([...accepted, ...discarded].map((q) => ({ ...q, testId: test._id })));
  const acceptedCount = stored.filter((q) => q.status === "accepted").length;

  res.status(201).json({
    test,
    mcqGeneratedBy,
    theoryGeneratedBy,
    accepted: acceptedCount,
    discarded: stored.filter((q) => q.status === "discarded").length,
    targetQuestionCount,
    deliverable: Math.min(targetQuestionCount, acceptedCount),
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
