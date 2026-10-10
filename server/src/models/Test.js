import { getCollection } from "../db/index.js";

const tests = () => getCollection("tests");

// targetQuestionCount is how many questions a student actually sees
// (mcqCount + theoryCount as requested at build time) - the accepted
// question *pool* stored under this test is deliberately larger, so the
// adaptive controller (adaptiveEngine.js) has real depth to pick from at
// each difficulty tier. See routes/tests.js for the pool-sizing logic.
export async function createTest({
  ownerId,
  subjectId,
  title,
  noteIds,
  marksPerQuestion,
  theoryMarks = null,
  negativeMarks = 0,
  sectioned = false,
  durationMinutes,
  targetQuestionCount,
  mix = null,
}) {
  return tests().insertOne({
    ownerId,
    subjectId,
    title,
    noteIds,
    // marks for an MCQ; for a theory question (theoryMarks, the same if not set)
    marksPerQuestion,
    theoryMarks: theoryMarks ?? marksPerQuestion,
    // marks off for a wrong MCQ (a blank one costs nothing)
    negativeMarks,
    // MCQs first (Section A), then theory (Section B)
    sectioned,
    durationMinutes,
    targetQuestionCount,
    // how many of each type the student asked for ({ mcq: 5, theory: 2 }):
    // delivery keeps to it (adaptiveEngine.typesOwed)
    mix,
    createdAt: new Date(),
  });
}

export async function findTestsBySubject(subjectId) {
  return tests().find({ subjectId }, { sort: { createdAt: -1 } });
}

/** After building: the test is as long as the questions that could be made, if fewer than asked. */
export async function setTestLength(id, { targetQuestionCount, mix }) {
  return tests().findOneAndUpdate({ _id: id }, { $set: { targetQuestionCount, mix } });
}

export async function findOwnedTest(id, ownerId) {
  return tests().findOne({ _id: id, ownerId });
}
