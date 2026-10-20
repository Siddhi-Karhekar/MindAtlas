import { getCollection } from "../db/index.js";

// A picture a student attached to a theory answer: a photo of handwritten
// working, a formula, a diagram. Stored with the answer it belongs to - the
// student, the attempt and the question - so it is marked with that answer
// and can never be read by anyone else (routes/attempts.js checks the owner
// on every request).
//
// Two collections, so listing and counting never load the pictures:
//   answer_images      what the picture is: owner, attempt, question, type,
//                      size, status, and what was read from it
//   answer_image_data  the bytes, base64-encoded (the same record works in
//                      MongoDB and in the local JSON / in-memory store)
//
//   status   "draft" while the question is still being answered (it can be
//            removed), "submitted" once the answer is saved
//   reading  what was read from it when the answer was marked:
//            { text, legibility: "clear" | "partial" | "unreadable", by: "vision" | "ocr" | null, model }

const images = () => getCollection("answer_images");
const bytes = () => getCollection("answer_image_data");

export async function createAnswerImage({ ownerId, attemptId, questionId, mime, size, width, height, data }) {
  const image = await images().insertOne({ ownerId, attemptId, questionId, mime, size, width, height, status: "draft", createdAt: new Date() });
  await bytes().insertOne({ imageId: String(image._id), ownerId, data });
  return image;
}

/** A student's pictures for one question of one attempt, oldest first. */
export async function findAnswerImages(attemptId, questionId) {
  return images().find({ attemptId, questionId }, { sort: { createdAt: 1 } });
}

/** Every picture of an attempt. */
export async function findAnswerImagesByAttempt(attemptId) {
  return images().find({ attemptId }, { sort: { createdAt: 1 } });
}

export async function findOwnedAnswerImage(id, ownerId) {
  return images().findOne({ _id: id, ownerId });
}

/** The picture itself, as a Buffer (null if it is gone). */
export async function readAnswerImageData(image) {
  const row = await bytes().findOne({ imageId: String(image._id), ownerId: image.ownerId });
  return row?.data ? Buffer.from(row.data, "base64") : null;
}

export async function countAnswerImagesByOwner(ownerId) {
  return (await images().find({ ownerId })).length;
}

/** Remove a picture that is still a draft (the question not yet answered). */
export async function deleteDraftAnswerImage(id, ownerId) {
  const removed = await images().deleteMany({ _id: id, ownerId, status: "draft" });
  if (removed) await bytes().deleteMany({ imageId: String(id), ownerId });
  return removed;
}

/** Once the answer is saved, its pictures are part of it: no longer removable. */
export async function markAnswerImagesSubmitted(attemptId, questionId) {
  const list = await images().find({ attemptId, questionId });
  await Promise.all(list.map((im) => images().findOneAndUpdate({ _id: im._id }, { $set: { status: "submitted" } })));
  return list.map((im) => im._id);
}

export async function saveImageReading(id, reading) {
  return images().findOneAndUpdate({ _id: id }, { $set: { reading } });
}

/** Every picture of these attempts, with its bytes (deleting a subject or an account). */
export async function deleteAnswerImagesByAttempts(attemptIds) {
  if (!attemptIds.length) return 0;
  const list = await images().find({ attemptId: attemptIds });
  if (list.length) await bytes().deleteMany({ imageId: list.map((im) => String(im._id)) });
  return images().deleteMany({ attemptId: attemptIds });
}
