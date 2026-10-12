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

/**
 * The fields the linker owns on an edge - everything except the student's
 * `correction`. upsertEdge writes exactly these, and the relink tool
 * (services/relink.js) compares a stored edge against them to tell whether
 * the pair needs rewriting.
 */
export function edgeFields({ sourceNoteId, targetNoteId, sourceSubjectId, targetSubjectId, edgeType, weight, sharedKeywords }) {
  return {
    subjectId: edgeType === "same-subject" ? sourceSubjectId : null,
    sourceSubjectId,
    targetSubjectId,
    sourceNoteId,
    targetNoteId,
    edgeType,
    weight,
    sharedKeywords,
  };
}

export async function upsertEdge(pair) {
  return graphEdges().findOneAndUpdate(
    { sourceNoteId: pair.sourceNoteId, targetNoteId: pair.targetNoteId },
    // Deliberately never touches `correction`: a link the student removed
    // stays removed however often the pair is re-scored.
    { $set: edgeFields(pair) },
    { upsert: true }
  );
}

/** Every edge with an end in `noteIds`, removed ones included. */
export async function findEdgesForNotes(noteIds) {
  if (!noteIds.length) return [];
  const [asSource, asTarget] = await Promise.all([
    graphEdges().find({ sourceNoteId: noteIds }),
    graphEdges().find({ targetNoteId: noteIds }),
  ]);
  const byId = new Map([...asSource, ...asTarget].map((e) => [String(e._id), e]));
  return [...byId.values()];
}

export async function deleteEdgesByIds(ids) {
  return ids.length ? graphEdges().deleteMany({ _id: ids }) : 0;
}

/**
 * Delete every edge with an end in `noteIds`.
 * `keepCorrections`: leave the links the student removed by hand. Used when a
 * note is edited and relinked - "these two are not related" is the student's
 * decision about the pair, and survives a change of wording. When the note
 * itself is deleted, nothing about it is kept.
 */
export async function deleteEdgesForNotes(noteIds, { keepCorrections = false } = {}) {
  const edges = await findEdgesForNotes(noteIds);
  return deleteEdgesByIds(edges.filter((e) => !(keepCorrections && isRemoved(e))).map((e) => String(e._id)));
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
