import { findOwnedSubject } from "../models/Subject.js";
import { findChildNotes, findNotesByIds, isSplitParent, topicLabelFor } from "../models/Note.js";
import { createTest, findTestsBySubject, findOwnedTest, setTestLength } from "../models/Test.js";
import { createQuestions, findAcceptedQuestionsByTests, findQuestionsByTest } from "../models/Question.js";
import { requireAuth } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { once } from "../middleware/once.js";
import { idList, integer, text } from "../middleware/validate.js";
import { publicDoc } from "../services/noteView.js";
import { isProduction } from "../config.js";
import { generateQuestions } from "../services/testEngine.js";
import { masteryMapForSubject } from "../models/Mastery.js";

const router = safeRouter();
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
router.post("/subjects/:id/tests", once(), async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  // Every field is read through a check: only these are taken from the
  // request, each of a known type and within a range. Nothing else a client
  // sends reaches the stored test.
  //
  // The exam pattern: marks for an MCQ (marksPerQuestion) and for a theory
  // question (theoryMarks), marks taken off for a wrong MCQ (negativeMarks,
  // 0 to the MCQ's own marks, in quarter marks), and whether the paper is in
  // sections - all the MCQs first (Section A), then the theory (Section B).
  const body = req.body || {};
  const title = text(body.title, "title");
  const noteIds = idList(body.noteIds, "noteIds");
  const safeMcqCount = integer(body.mcqCount, "mcqCount", { min: 0, max: 20, fallback: 5 });
  const safeTheoryCount = integer(body.theoryCount, "theoryCount", { min: 0, max: 20, fallback: 0 });
  const marksPerQuestion = integer(body.marksPerQuestion, "marksPerQuestion", { min: 1, max: 100, fallback: 1 });
  const durationMinutes = integer(body.durationMinutes, "durationMinutes", { min: 1, max: 600, fallback: 15 });
  const theoryMarks = integer(body.theoryMarks, "theoryMarks", { min: 1, max: 100, fallback: marksPerQuestion });
  const negativeMarks = body.negativeMarks === undefined || body.negativeMarks === null ? 0 : body.negativeMarks;
  if (typeof negativeMarks !== "number" || !Number.isFinite(negativeMarks) || negativeMarks < 0 || negativeMarks > marksPerQuestion || Math.round(negativeMarks * 4) !== negativeMarks * 4) {
    return res.status(400).json({ error: "negativeMarks must be between 0 and the marks for an MCQ, in quarter marks" });
  }
  if (body.sectioned !== undefined && typeof body.sectioned !== "boolean") {
    return res.status(400).json({ error: "sectioned must be true or false" });
  }
  const sectioned = body.sectioned === true;
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
    title,
    noteIds: notesInSubject.map((n) => n._id),
    marksPerQuestion,
    theoryMarks,
    negativeMarks,
    sectioned,
    durationMinutes,
    targetQuestionCount,
    mix: { mcq: safeMcqCount, theory: safeTheoryCount },
  });

  // The student's accumulated per-topic mastery steers WHICH notes the pool is
  // drawn from: weak and untested topics get more questions than ones already
  // demonstrated. Empty on a first-ever test, in which case generation falls
  // back to an even spread across the selected notes.
  const masteryMap = await masteryMapForSubject(req.user.id, subject._id);

  // What the student has been asked before on these notes, so a new test
  // brings new questions (testEngine.pickFresh). Earlier questions are used
  // again only when the notes cannot supply enough new ones.
  const topicIds = new Set(notesInSubject.map((n) => String(n._id)));
  const earlierTests = (await findTestsBySubject(subject._id)).filter(
    (t) => String(t.ownerId) === String(req.user.id) && String(t._id) !== String(test._id)
  );
  const avoid = (await findAcceptedQuestionsByTests(earlierTests.map((t) => t._id)))
    .filter((q) => topicIds.has(String(q.topicId)))
    .map((q) => q.prompt)
    .filter(Boolean);

  const { accepted, discarded, repeatsUsed, mcqGeneratedBy, theoryGeneratedBy, rankedBy } = await generateQuestions(notesInSubject, {
    mcqCount: poolSizeFor(safeMcqCount),
    theoryCount: poolSizeFor(safeTheoryCount),
    marksPerQuestion,
    theoryMarks,
    masteryMap,
    avoid,
    // earlier questions are used again only to reach these, never to fill the larger pool
    mcqTarget: safeMcqCount,
    theoryTarget: safeTheoryCount,
  });

  const stored = await createQuestions([...accepted, ...discarded].map((q) => ({ ...q, testId: test._id })));
  const acceptedCount = stored.filter((q) => q.status === "accepted").length;
  const available = (type) => stored.filter((q) => q.status === "accepted" && q.type === type).length;
  // Fewer good questions than asked for: the test is as long as what could be
  // made, and the student is told, rather than finding out mid-test.
  const deliverable = Math.min(targetQuestionCount, acceptedCount);
  if (deliverable < targetQuestionCount && deliverable > 0) {
    await setTestLength(test._id, { targetQuestionCount: deliverable, mix: { mcq: safeMcqCount, theory: safeTheoryCount } });    test.targetQuestionCount = deliverable;
  }

  res.status(201).json({
    test: publicDoc(test),
    mcqGeneratedBy,
    theoryGeneratedBy,
    // "embeddings" when the semantic model judged relevance and key terms,
    // "rules" when it is off, not installed or still loading
    rankedBy,
    accepted: acceptedCount,
    discarded: stored.filter((q) => q.status === "discarded").length,
    targetQuestionCount,
    deliverable,
    // set when the notes could not supply everything asked for
    shortfall:
      deliverable < targetQuestionCount || available("mcq") < safeMcqCount || available("theory") < safeTheoryCount
        ? {
            requested: targetQuestionCount,
            deliverable,
            mcq: { requested: safeMcqCount, available: available("mcq") },
            theory: { requested: safeTheoryCount, available: available("theory") },
          }
        : null,
    // questions from the student's earlier tests used again, because these
    // notes could not supply enough new ones
    repeatsUsed,
  });
});

router.get("/subjects/:id/tests", async (req, res) => {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });

  const tests = await findTestsBySubject(subject._id);
  res.json({ tests: tests.map(publicDoc) });
});

// GET /api/tests/:id - a test and its questions, WITHOUT answer keys, the
// sentences they were drawn from or the grading rubric. The owner of a test
// is the student who will sit it, so sending those here would hand over the
// answers before the attempt; they are shown after submission, in the
// feedback report.
//
// For checking the generator while developing, a server started with
// TEST_REVEAL_KEYS=1 sends them when asked with ?keys=1. Ignored in
// production whatever the setting says.
router.get("/tests/:id", async (req, res) => {
  const test = await findOwnedTest(req.params.id, req.user.id);
  if (!test) return res.status(404).json({ error: "test not found" });

  const questions = await findQuestionsByTest(test._id);
  const withKeys = req.query.keys === "1" && process.env.TEST_REVEAL_KEYS === "1" && !isProduction();
  // eslint-disable-next-line no-unused-vars
  const withoutKeys = ({ answerKey, supportingExcerpt, keyPoints, ...q }) => q;
  res.json({ test: publicDoc(test), questions: withKeys ? questions : questions.map(withoutKeys) });
});

export default router;
