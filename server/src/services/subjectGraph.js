// A subject's knowledge graph, as GET /api/subjects/:id/graph answers it
// (routes/subjects.js says what each field means). Built here so the PDF
// download (services/graphExport/) draws exactly the graph the page shows.

import { findSubjectsByOwner } from "../models/Subject.js";
import { findNotesByIds, findNotesBySubject } from "../models/Note.js";
import { findCrossSubjectEdges, findEdgesBySubject, isRemoved, toApiEdge } from "../models/GraphEdge.js";
import { withKeyTerms } from "./noteView.js";
import { clusterNotes } from "./graphEngine.js";

export async function buildSubjectGraph(subject, ownerId) {
  const [notes, allSameEdges, allCrossEdges] = await Promise.all([
    findNotesBySubject(subject._id),
    findEdgesBySubject(subject._id, { includeRemoved: true }),
    findCrossSubjectEdges(subject._id, { includeRemoved: true }),
  ]);
  const edges = allSameEdges.filter((e) => !isRemoved(e));
  const crossEdges = allCrossEdges.filter((e) => !isRemoved(e));

  const ownIds = new Set(notes.map((n) => String(n._id)));
  const externalIds = [
    ...new Set(
      allCrossEdges.flatMap((e) => [String(e.sourceNoteId), String(e.targetNoteId)]).filter((id) => !ownIds.has(id))
    ),
  ];
  const [externalNotes, subjects] = await Promise.all([
    findNotesByIds(externalIds),
    findSubjectsByOwner(ownerId),
  ]);
  const subjectName = new Map(subjects.map((s) => [String(s._id), s.name]));
  // Edges only ever join one student's own notes, but check ownership anyway
  // before exposing another subject's note.
  const external = externalNotes.filter((n) => String(n.ownerId) === String(ownerId));
  const known = new Set([...ownIds, ...external.map((n) => String(n._id))]);
  const isKnown = (e) => known.has(String(e.sourceNoteId)) && known.has(String(e.targetNoteId));
  const usable = crossEdges.filter(isKnown);
  // Same-subject links only: a cluster is a group within this subject. Split
  // document parents are containers, not topics, so they are not clustered.
  const isSplitParent = (n) => !n.parentNoteId && (n.childCount || 0) > 0;
  const { clusterOf, clusters } = clusterNotes(notes.filter((n) => !isSplitParent(n)), edges);
  // what the graph page shows and searches by: the key terms ("page table",
  // "translation lookaside buffer") the reading pane shows. `keywords` (single
  // TF-IDF words) stay for cluster labels and the keyword map, which compare
  // words across notes.
  const termsById = new Map(withKeyTerms(notes, notes, { subject }).map((n) => [String(n._id), n.keyTerms]));
  const externalTerms = new Map(withKeyTerms(external, external).map((n) => [String(n._id), n.keyTerms]));

  return {
    nodes: notes.map((n) => ({
      id: n._id,
      title: n.title,
      keywords: n.keywords,
      keyTerms: termsById.get(String(n._id)) || [],
      sourceType: n.sourceType,
      createdAt: n.createdAt,
      clusterId: clusterOf.get(String(n._id)),
      parentNoteId: n.parentNoteId || null,
      childCount: n.childCount || 0,
      order: n.order ?? null,
      sectionGroup: n.sectionGroup || null,
    })),
    clusters,
    edges: edges.map(toApiEdge),
    containsEdges: notes
      .filter((n) => n.parentNoteId && ownIds.has(String(n.parentNoteId)))
      .map((n) => ({ id: `contains-${n._id}`, source: n.parentNoteId, target: n._id, edgeType: "contains" })),
    crossSubjectEdges: usable.filter((e) => e.edgeType === "cross-subject").map(toApiEdge),
    rejectedEdges: usable.filter((e) => e.edgeType === "rejected").map(toApiEdge),
    removedEdges: [...allSameEdges, ...allCrossEdges.filter(isKnown)].filter(isRemoved).map(toApiEdge),
    externalNodes: external.map((n) => ({
      id: n._id,
      title: n.title,
      keywords: n.keywords,
      keyTerms: externalTerms.get(String(n._id)) || [],
      subjectId: n.subjectId,
      subjectName: subjectName.get(String(n.subjectId)) || "Another subject",
    })),
  };
}
