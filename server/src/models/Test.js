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
  durationMinutes,
  targetQuestionCount,
}) {
  return tests().insertOne({
    ownerId,
    subjectId,
    title,
    noteIds,
    marksPerQuestion,
    durationMinutes,
    targetQuestionCount,
    createdAt: new Date(),
  });
}

export async function findTestsBySubject(subjectId) {
  return tests().find({ subjectId }, { sort: { createdAt: -1 } });
}

export async function findOwnedTest(id, ownerId) {
  return tests().findOne({ _id: id, ownerId });
}
