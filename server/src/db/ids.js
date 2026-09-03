import crypto from "crypto";

// 24 hex chars - same shape as a real MongoDB ObjectId string, so ids look
// and behave identically whether the in-memory dev store or a real
// MongoDB Atlas cluster is backing the app.
export function generateId() {
  return crypto.randomBytes(12).toString("hex");
}
