import { findOwnedSubject } from "../models/Subject.js";
import { findChildNotes, findNotesByIds, isSplitParent, topicLabelFor, updateNote } from "../models/Note.js";
import { createTest, deleteTest, findTestsBySubject, findOwnedTest, setTestGeneration, setTestLength } from "../models/Test.js";
import { createQuestions, findAcceptedQuestionsByTests, findQuestionsByIds, findQuestionsByTest } from "../models/Question.js";
import { findReportsByOwner } from "../models/QuestionReport.js";
import { requireAuth } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { once } from "../middleware/once.js";
import { idList, integer, text } from "../middleware/validate.js";
import { publicDoc } from "../services/noteView.js";
import { isProduction } from "../config.js";
import { generateQuestions } from "../services/testEngine.js";
import { conceptOf } from "../services/questionQuality.js";
import { masteryMapForSubject } from "../models/Mastery.js";
import { findAttemptsBySubject } from "../models/Attempt.js";
import { findResponsesByAttempts } from "../models/Response.js";
import { withSyllabus } from "../services/keyTermSignals.js";
import { hasCurrentAiTerms, suggestInBackground } from "../services/aiKeyTerms.js";
import { refreshNoteConcepts } from "../services/noteLifecycle.js";

const router = safeRouter();
router.use(requireAuth);

// The adaptive controller (adaptiveEngine.js) needs a pool of accepted
// questions deeper than what's actually delivered, so it has real options
// at each difficulty tier - a test asking for `target` questions generates
// roughly 1.5x that many candidates (capped, so this stays a single LLM
// call). Everything above `target` that gets accepted just sits unused in
// the pool if the adaptive walk never needs it.
const RECENT_TESTS = 2;

// Reports that say a question is broken - not merely a repeat, or "other" -
// keep it (or a rewording of it) out of every later test on these notes.
const BLOCKING_REPORTS = new Set(["wrong-answer", "unclear", "not-in-notes"]);

// One test build at a time per student and subject. Two builds started
// together (a double click, two tabs) would each read the same history and
// pick the same questions; queued, the second sees the first's questions.
const building = new Map();
function oneAtATime(key, work) {
  const before = building.get(key) || Promise.resolve();
  const run = before.catch(() => {}).then(work);
  const tail = run.catch(() => {});
  building.set(key, tail);
  tail.then(() => {
    if (building.get(key) === tail) building.delete(key);
  });
  return run;
}

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
router.post("/subjects/:id/tests", once(), (req, res) => oneAtATime(`${req.user.id}|${req.params.id}`, () => buildTest(req, res)));

async function buildTest(req, res) {
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
  // the subject's syllabus travels with each note: its terms rank higher (keyTermSignals.js)
  const notesInSubject = withSyllabus(await resolveTopicNotes(selectedInSubject), subject);
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
  // oldest test first, so the list ends with what was asked most recently
  const testTime = new Map(earlierTests.map((t) => [String(t._id), new Date(t.createdAt || 0).getTime()]));
  const earlierQuestions = (await findAcceptedQuestionsByTests(earlierTests.map((t) => t._id)))
    .filter((q) => q.prompt && topicIds.has(String(q.topicId)))
    .sort((a, b) => (testTime.get(String(a.testId)) || 0) - (testTime.get(String(b.testId)) || 0));
  const avoid = earlierQuestions.map((q) => q.prompt);

  // When the notes run out of new questions, which earlier ones come back
  // first: ones the student was never actually shown (the pool is larger than
  // a test), then ones they got wrong, then the rest - oldest first in each.
  // A repeat is then revision of what the student does not yet know, not
  // simply the first questions ever written.
  const attempts = (await findAttemptsBySubject(req.user.id, subject._id)).slice(0, 100);
  const shownIds = new Set(attempts.flatMap((a) => (a.shownQuestionIds || []).map(String)));
  const lowestScore = new Map();
  for (const r of await findResponsesByAttempts(attempts.map((a) => a._id))) {
    const id = String(r.questionId);
    lowestScore.set(id, Math.min(lowestScore.get(id) ?? 1, typeof r.score === "number" ? r.score : 0));
  }
  // Long-term policy: a question from one of the last two tests comes back
  // only after everything older (it is too soon to be useful revision).
  const recentTests = new Set(
    [...earlierTests].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, RECENT_TESTS).map((t) => String(t._id))
  );
  const repeatRank = new Map();
  earlierQuestions.forEach((q, i) => {
    const id = String(q._id);
    const band = (recentTests.has(String(q.testId)) ? 3 : 0) + (!shownIds.has(id) ? 0 : (lowestScore.get(id) ?? 0) < 0.5 ? 1 : 2);
    if (!repeatRank.has(q.prompt)) repeatRank.set(q.prompt, band * 1e6 + i);
  });
  // concepts tested in the last two tests: asked again in a new way only when
  // the notes have no untested concept left
  const recentConcepts = new Set(earlierQuestions.filter((q) => recentTests.has(String(q.testId))).map((q) => conceptOf(q, q.type)).filter(Boolean));
  // every concept tested on these notes: how often, and in which test last
  // (0 = the oldest), so the concepts tested least and longest ago come back
  // before the ones tested often and lately
  const ordinal = new Map([...earlierTests].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)).map((t, i) => [String(t._id), i]));
  const conceptHistory = new Map();
  for (const q of earlierQuestions) {
    const c = conceptOf(q, q.type);
    if (!c) continue;
    const h = conceptHistory.get(c) || { count: 0, last: -1, tests: new Set() };
    const t = String(q.testId);
    if (!h.tests.has(t)) {
      h.tests.add(t);
      h.count += 1;
    }
    h.last = Math.max(h.last, ordinal.get(t) ?? -1);
    conceptHistory.set(c, h);
  }

  // How each concept was asked before (its form: a definition, a numerical, a
  // comparison ...), so a concept that comes back is asked a new way
  // (conceptSelection.js, testEngine.pickFresh). Keyed by concept id and by
  // the concept's name, for questions stored before ids existed.
  const approachHistory = new Map();
  for (const q of earlierQuestions) {
    const way = q.approach || q.form || q.cognitiveLevel;
    if (!way) continue;
    for (const k of [q.conceptId, conceptOf(q, q.type)].filter(Boolean)) {
      if (!approachHistory.has(k)) approachHistory.set(k, new Set());
      approachHistory.get(k).add(way);
    }
  }

  // Questions this student reported as wrong, unclear or not from the notes:
  // never generated again for them (testEngine discards them as "reported").
  const reports = (await findReportsByOwner(req.user.id)).filter((r) => String(r.subjectId) === String(subject._id) && BLOCKING_REPORTS.has(r.reason));
  const blocked = (await findQuestionsByIds(reports.map((r) => r.questionId))).map((q) => ({
    prompt: q.prompt,
    excerpt: q.supportingExcerpt,
    answer: q.type === "mcq" ? q.answerKey : null,
  }));

  const { accepted, discarded, repeatsUsed, mcqGeneratedBy, theoryGeneratedBy, generation, rankedBy } = await generateQuestions(notesInSubject, {
    mcqCount: poolSizeFor(safeMcqCount),
    theoryCount: poolSizeFor(safeTheoryCount),
    marksPerQuestion,
    theoryMarks,
    masteryMap,
    avoid,
    repeatRank,
    recentConcepts,
    conceptHistory,
    blocked,
    approachHistory,
    // a note whose concept records are missing or out of date gets them stored
    onConcepts: (note, concepts) => updateNote(note._id, { concepts }),
    // earlier questions are used again only to reach these, never to fill the larger pool
    mcqTarget: safeMcqCount,
    theoryTarget: safeTheoryCount,
  });

  // Nothing passed the quality checks: there is no test to take. The empty
  // test is removed and the student is told plainly; why each draft failed
  // goes to the server log as counts (never the text).
  if (accepted.length === 0) {
    await deleteTest(test._id);
    const reasons = {};
    for (const q of discarded) for (const r of String(q.discardReason || "unknown").split(",")) reasons[r] = (reasons[r] || 0) + 1;
    console.warn("[testgen] no question passed the checks:", JSON.stringify(reasons));
    return res.status(422).json({
      error: "No questions could be made from these notes. Try adding more notes on this topic, or choose more notes.",
      code: "generation_failed",
      generation,
      mcqGeneratedBy,
      theoryGeneratedBy,
    });
  }

  const stored = await createQuestions([...accepted, ...discarded].map((q) => ({ ...q, testId: test._id })));
  await setTestGeneration(test._id, generation);
  test.generation = generation;
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
    // per question type: status ("llm" | "rule-based-fallback" | "mixed" |
    // "failed" | "none"), how many questions each writer supplied, and why
    // the rules stepped in (fallbackReason) - decided from the questions
    // actually chosen, not from whether an AI key is set
    generation,
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

  // Notes saved before AI key terms existed (or with an AI outage at upload)
  // get them now, in the background, for the next test: never this one, which
  // has been answered already. A few notes per build, one request.
  const missing = notesInSubject.filter((n) => !hasCurrentAiTerms(n)).slice(0, 8);
  suggestInBackground(missing, async () => {
    for (const n of missing) await refreshNoteConcepts(n);
  });
}

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
  const withoutKeys = ({ answerKey, supportingExcerpt, keyPoints, quality, verification, computation, explanation, distractorReasons, classification, ...q }) => q;
  res.json({ test: publicDoc(test), questions: withKeys ? questions : questions.map(withoutKeys) });
});

export default router;
