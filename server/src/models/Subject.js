import { getCollection } from "../db/index.js";

const subjects = () => getCollection("subjects");

export async function createSubject({ ownerId, name }) {
  return subjects().insertOne({ ownerId, name, createdAt: new Date() });
}

export async function findSubjectsByOwner(ownerId) {
  return subjects().find({ ownerId }, { sort: { createdAt: -1 } });
}

export async function findOwnedSubject(id, ownerId) {
  return subjects().findOne({ _id: id, ownerId });
}
