import { getCollection } from "../db/index.js";

const users = () => getCollection("users");

export async function createUser({ email, passwordHash }) {
  return users().insertOne({ email, passwordHash, createdAt: new Date() });
}

export async function findUserByEmail(email) {
  return users().findOne({ email });
}

export async function findUserById(id) {
  return users().findOne({ _id: id });
}
