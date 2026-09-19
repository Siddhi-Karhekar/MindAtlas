import { getCollection } from "../db/index.js";

const mastery = () => getCollection("mastery");

// One row per (owner, subject, topic). `topicId` is a note id - NOT the
// note's title - so a student's history survives a note being renamed, and
// so the same key can later address a knowledge-graph node id. `topicLabel`
// is the title carried alongside purely for display; it is refreshed on
// every update so a rename shows through without losing the history.
//
// `pKnown` is the Bayesian Knowledge Tracing posterior: the probability the
// student knows this topic, updated after every graded response (see
// services/masteryEngine.js). `observations` counts the responses that have
// contributed, which is what lets callers distinguish "0.5 because we have
// no idea" from "0.5 after twenty questions".

export async function findMasteryBySubject(ownerId, subjectId) {
  return mastery().find({ ownerId, subjectId });
}

export async function findMasteryForTopics(ownerId, subjectId, topicIds) {
  if (!topicIds.length) return [];
  return mastery().find({ ownerId, subjectId, topicId: topicIds });
}

/** Insert or update one topic's mastery. Returns the stored record. */
export async function upsertMastery({ ownerId, subjectId, topicId, topicLabel, pKnown, observations }) {
  return mastery().findOneAndUpdate(
    { ownerId, subjectId, topicId },
    {
      $set: {
        ownerId,
        subjectId,
        topicId,
        topicLabel,
        pKnown,
        observations,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

/** Convenience: a Map of topicId -> mastery record for quick lookup. */
export async function masteryMapForSubject(ownerId, subjectId) {
  const rows = await findMasteryBySubject(ownerId, subjectId);
  return new Map(rows.map((r) => [String(r.topicId), r]));
}
