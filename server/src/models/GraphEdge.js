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

export async function findEdgesBySubject(subjectId) {
  return graphEdges().find({ subjectId });
}

/** Cross-subject and rejected edges with one end in this subject. */
export async function findCrossSubjectEdges(subjectId) {
  // The store only matches plain equality, so "either end is in this
  // subject" is two queries merged, not one $or.
  const [asSource, asTarget] = await Promise.all([
    graphEdges().find({ sourceSubjectId: subjectId }),
    graphEdges().find({ targetSubjectId: subjectId }),
  ]);
  const byId = new Map();
  for (const e of [...asSource, ...asTarget]) {
    if (e.edgeType === "cross-subject" || e.edgeType === "rejected") byId.set(String(e._id), e);
  }
  return [...byId.values()];
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
