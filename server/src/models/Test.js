import { getCollection } from "../db/index.js";

const tests = () => getCollection("tests");

export async function createTest({ ownerId, subjectId, title, noteIds, marksPerQuestion, durationMinutes }) {
  return tests().insertOne({
    ownerId,
    subjectId,
    title,
    noteIds,
    marksPerQuestion,
    durationMinutes,
    createdAt: new Date(),
  });
}

export async function findTestsBySubject(subjectId) {
  return tests().find({ subjectId }, { sort: { createdAt: -1 } });
}

export async function findOwnedTest(id, ownerId) {
  return tests().findOne({ _id: id, ownerId });
}
