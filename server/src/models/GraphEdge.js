import { getCollection } from "../db/index.js";

const graphEdges = () => getCollection("graph_edges");

// Every edge has an edgeType (see services/graphEngine.js): "same-subject",
// "cross-subject" or "rejected". Rows written before cross-subject linking
// have no edgeType and are all same-subject.
//
// subjectId is set ONLY on same-subject edges. Cross-subject and rejected
// edges span two subjects, so they carry subjectId: null and are found
// through sourceSubjectId / targetSubjectId instead. That keeps
// findEdgesBySubject returning exactly the same-subject edges it always did,
// which matters because Home, the subject page and the note editor all read
// it (through GET /api/subjects/:id/graph) and count its edges as links
// within the subject.
//
// A student can mark a link as wrong (POST /api/graph/edges/:id/correct).
// That sets correction: "removed" on the edge rather than deleting it, so the
// link can be restored, and so re-running the linker - which only ever $sets
// its own fields - can never quietly bring it back. Removed edges are left
// out of both finders below unless asked for.

export const isRemoved = (e) => e.correction === "removed";

export async function findEdgesBySubject(subjectId, { includeRemoved = false } = {}) {
  const edges = await graphEdges().find({ subjectId });
  return includeRemoved ? edges : edges.filter((e) => !isRemoved(e));
}

/** Cross-subject and rejected edges with one end in this subject. */
export async function findCrossSubjectEdges(subjectId, { includeRemoved = false } = {}) {
  // The store only matches plain equality, so "either end is in this
  // subject" is two queries merged, not one $or.
  const [asSource, asTarget] = await Promise.all([
    graphEdges().find({ sourceSubjectId: subjectId }),
    graphEdges().find({ targetSubjectId: subjectId }),
  ]);
  const byId = new Map();
  for (const e of [...asSource, ...asTarget]) {
    if (e.edgeType !== "cross-subject" && e.edgeType !== "rejected") continue;
    if (!includeRemoved && isRemoved(e)) continue;
    byId.set(String(e._id), e);
  }
  return [...byId.values()];
}

export async function findEdgeById(id) {
  return graphEdges().findOne({ _id: id });
}

/** Record a student's correction: "removed", or null to restore the link. */
export async function setEdgeCorrection(id, correction) {
  return graphEdges().findOneAndUpdate(
    { _id: id },
    { $set: { correction, correctedAt: correction ? new Date() : null } }
  );
}

export async function upsertEdge({
  sourceNoteId,
  targetNoteId,
  sourceSubjectId,
  targetSubjectId,
  edgeType,
  weight,
  sharedKeywords,
}) {
  const subjectId = edgeType === "same-subject" ? sourceSubjectId : null;
  return graphEdges().findOneAndUpdate(
    { sourceNoteId, targetNoteId },
    {
      // Deliberately never touches `correction`: a link the student removed
      // stays removed however often the pair is re-scored.
      $set: {
        subjectId,
        sourceSubjectId,
        targetSubjectId,
        sourceNoteId,
        targetNoteId,
        edgeType,
        weight,
        sharedKeywords,
      },
    },
    { upsert: true }
  );
}

/** An edge as the API returns it. */
export const toApiEdge = (e) => ({
  id: e._id,
  source: e.sourceNoteId,
  target: e.targetNoteId,
  weight: e.weight,
  sharedKeywords: e.sharedKeywords,
  edgeType: e.edgeType || "same-subject",
});
