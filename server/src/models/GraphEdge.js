import { getCollection } from "../db/index.js";

const graphEdges = () => getCollection("graph_edges");

export async function findEdgesBySubject(subjectId) {
  return graphEdges().find({ subjectId });
}

export async function upsertEdge({ subjectId, sourceNoteId, targetNoteId, weight, sharedKeywords }) {
  return graphEdges().findOneAndUpdate(
    { subjectId, sourceNoteId, targetNoteId },
    { $set: { weight, sharedKeywords, subjectId, sourceNoteId, targetNoteId } },
    { upsert: true }
  );
}
