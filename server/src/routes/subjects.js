import { Router } from "express";
import { createSubject, findSubjectsByOwner, findOwnedSubject } from "../models/Subject.js";
import { findNotesByIds, findNotesBySubject } from "../models/Note.js";
import { findCrossSubjectEdges, findEdgesBySubject, isRemoved, toApiEdge } from "../models/GraphEdge.js";
import { requireAuth } from "../middleware/auth.js";
import { clusterNotes } from "../services/graphEngine.js";

const router = Router();
router.use(requireAuth);

router.post("/", async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  const subject = await createSubject({ ownerId: req.user.id, name: name.trim() });
  res.status(201).json({ subject });
});

router.get("/", async (req, res) => {
  const subjects = await findSubjectsByOwner(req.user.id);
  res.json({ subjects });
});

export async function loadOwnedSubject(req, res, next) {
  const subject = await findOwnedSubject(req.params.id, req.user.id);
  if (!subject) return res.status(404).json({ error: "subject not found" });
  req.subject = subject;
  next();
}

// `nodes` and `edges` mean exactly what they always have - this subject's
// notes and the links between them - because Home, the subject page and the
// note editor read them too. Everything about other subjects is additive, in
// fields only the knowledge graph page reads:
//   crossSubjectEdges - links from this subject's notes to other subjects'
//   rejectedEdges     - ambiguous cross-subject pairs that were not linked
//   externalNodes     - the other subjects' notes those two lists point at
//   clusters          - groups of linked notes within this subject (each node
//                       also gets a clusterId); see clusterNotes()
//   removedEdges      - links the student marked as wrong, same- or cross-
//                       subject, so the page can offer to restore them
// Removed links are left out of `edges`, the cross-subject lists, clusters
// and every count, exactly as if they had never been linked.
router.get("/:id/graph", loadOwnedSubject, async (req, res) => {
  const [notes, allSameEdges, allCrossEdges] = await Promise.all([
    findNotesBySubject(req.subject._id),
    findEdgesBySubject(req.subject._id, { includeRemoved: true }),
    findCrossSubjectEdges(req.subject._id, { includeRemoved: true }),
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
    findSubjectsByOwner(req.user.id),
  ]);
  const subjectName = new Map(subjects.map((s) => [String(s._id), s.name]));
  // Edges only ever join one student's own notes, but check ownership anyway
  // before exposing another subject's note.
  const external = externalNotes.filter((n) => String(n.ownerId) === String(req.user.id));
  const known = new Set([...ownIds, ...external.map((n) => String(n._id))]);
  const isKnown = (e) => known.has(String(e.sourceNoteId)) && known.has(String(e.targetNoteId));
  const usable = crossEdges.filter(isKnown);
  // Same-subject links only: a cluster is a group within this subject.
  const { clusterOf, clusters } = clusterNotes(notes, edges);

  res.json({
    nodes: notes.map((n) => ({
      id: n._id,
      title: n.title,
      keywords: n.keywords,
      sourceType: n.sourceType,
      createdAt: n.createdAt,
      clusterId: clusterOf.get(String(n._id)),
    })),
    clusters,
    edges: edges.map(toApiEdge),
    crossSubjectEdges: usable.filter((e) => e.edgeType === "cross-subject").map(toApiEdge),
    rejectedEdges: usable.filter((e) => e.edgeType === "rejected").map(toApiEdge),
    removedEdges: [...allSameEdges, ...allCrossEdges.filter(isKnown)].filter(isRemoved).map(toApiEdge),
    externalNodes: external.map((n) => ({
      id: n._id,
      title: n.title,
      keywords: n.keywords,
      subjectId: n.subjectId,
      subjectName: subjectName.get(String(n.subjectId)) || "Another subject",
    })),
  });
});

export default router;
