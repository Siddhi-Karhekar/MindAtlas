import { createSubject, deleteSubjectAndData, findSubjectsByOwner, findOwnedSubject, updateSubject } from "../models/Subject.js";
import { findNotesByOwner, isSplitParent } from "../models/Note.js";
import { findEdgesBySubject } from "../models/GraphEdge.js";
import { requireAuth } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { once } from "../middleware/once.js";
import { LIMITS, text } from "../middleware/validate.js";
import { publicDoc, withKeyTerms } from "../services/noteView.js";
import { buildSubjectGraph } from "../services/subjectGraph.js";
import { exportSubject, parseFormat, sendExport } from "../services/noteExport/index.js";
import { exportGraph } from "../services/graphExport/index.js";

const router = safeRouter();
router.use(requireAuth);

// a folder name: free text, or nothing (an empty string clears it)
const groupField = (value) => text(value, "group", { required: false, max: 60 }) || null;

router.post("/", once(), async (req, res) => {
  const name = text(req.body?.name, "name", { max: LIMITS.subjectName });
  const group = groupField(req.body?.group);
  const subject = await createSubject({ ownerId: req.user.id, name, group });
  res.status(201).json({ subject: publicDoc(subject) });
});

// DELETE /api/subjects/:id - the subject and everything in it, for good
router.delete("/:id", async (req, res) => {
  const removed = await deleteSubjectAndData(req.params.id, req.user.id);
  if (!removed) return res.status(404).json({ error: "subject not found" });
  res.json({ ok: true, removed });
});

// PATCH /api/subjects/:id  { name?, group?, syllabus? } - rename, move to
// another folder, or set the syllabus: the course's topics as text ("Unit 3:
// paging, segmentation, ..."). Terms of the subject's notes that the syllabus
// names rank higher as key terms (services/keyTermSignals.js); an empty
// string clears it.
const MAX_SYLLABUS = 20_000;
router.patch("/:id", async (req, res) => {
  const fields = {};
  if (req.body?.name !== undefined) fields.name = text(req.body.name, "name", { max: LIMITS.subjectName });
  if (req.body?.group !== undefined) fields.group = groupField(req.body.group);
  if (req.body?.syllabus !== undefined) fields.syllabus = text(req.body.syllabus, "syllabus", { required: false, max: MAX_SYLLABUS }) || null;
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: "nothing to change - send name, group or syllabus" });
  const subject = await updateSubject(req.params.id, req.user.id, fields);
  if (!subject) return res.status(404).json({ error: "subject not found" });
  res.json({ subject: publicDoc(subject) });
});

router.get("/", async (req, res) => {
  const subjects = await findSubjectsByOwner(req.user.id);
  res.json({ subjects: subjects.map(publicDoc) });
});

// GET /api/subjects/summary - the home page in one call: every subject with
// its number of notes and links, the share of its topics that are linked,
// and its newest note. Home used to fetch each subject's whole graph for
// these four things (clustering, key terms and cross-subject links included,
// one request per subject); the numbers are worked out the same way:
//   noteCount - notes that are not a subtopic (a split document is one note)
//   edgeCount - links within the subject, without the ones marked as wrong
//   linkedPct - notes at either end of those links, out of the topics (every
//               note but a split document's own, which is never linked)
//   latest    - the newest note that is not a subtopic, with its key terms
router.get("/summary", async (req, res) => {
  const subjects = await findSubjectsByOwner(req.user.id);
  const subjectIds = subjects.map((s) => String(s._id));
  const [notes, edges] = await Promise.all([
    findNotesByOwner(req.user.id),
    // an array matches any of its values: every subject's links in one query
    subjectIds.length ? findEdgesBySubject(subjectIds) : [],
  ]);
  const notesOf = Map.groupBy(notes, (n) => String(n.subjectId));
  const edgesOf = Map.groupBy(edges, (e) => String(e.subjectId));

  res.json({
    summaries: subjects.map((subject) => {
      const nodes = notesOf.get(String(subject._id)) || [];
      const links = edgesOf.get(String(subject._id)) || [];
      const topLevel = nodes.filter((n) => !n.parentNoteId);
      const topics = nodes.filter((n) => !isSplitParent(n));
      const linked = new Set(links.flatMap((e) => [String(e.sourceNoteId), String(e.targetNoteId)]));
      const newest = topLevel.reduce((a, n) => (!a || new Date(n.createdAt) > new Date(a.createdAt) ? n : a), null);
      const [latest] = newest ? withKeyTerms([newest], nodes, { subject }) : [];
      return {
        subject: publicDoc(subject),
        noteCount: topLevel.length,
        edgeCount: links.length,
        linkedPct: topics.length ? Math.round((linked.size / topics.length) * 100) : 0,
        latest: latest ? { id: latest._id, title: latest.title, createdAt: latest.createdAt, keywords: latest.keywords, keyTerms: latest.keyTerms } : null,
      };
    }),
  });
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
//   clusters          - groups of notes within this subject that are linked
//                       to each other more than to the rest of it (Louvain;
//                       each node also gets a clusterId); see clusterNotes()
//   removedEdges      - links the student marked as wrong, same- or cross-
//                       subject, so the page can offer to restore them
//   containsEdges     - document -> subtopic links for long uploads that were
//                       split into subtopics (derived from parentNoteId, never
//                       stored). Each node also carries parentNoteId /
//                       childCount / order / sectionGroup. A split document's
//                       own node has no similarity links and no cluster: its
//                       subtopics are the topics that link and cluster.
// Removed links are left out of `edges`, the cross-subject lists, clusters
// and every count, exactly as if they had never been linked.
router.get("/:id/graph", loadOwnedSubject, async (req, res) => {
  res.json(await buildSubjectGraph(req.subject, req.user.id));
});

// POST /api/subjects/:id/graph/export?tz=Asia/Kolkata
//   body: { positions: { <note id>: [x, y] }, colorBy: "links" | "clusters" }
// The whole graph as a PDF: the drawing on the first page, then its clusters
// and links as tables. A POST because the page sends where its nodes are -
// see services/graphExport/.
router.post("/:id/graph/export", loadOwnedSubject, async (req, res) => {
  const graph = await buildSubjectGraph(req.subject, req.user.id);
  sendExport(res, await exportGraph({ subject: req.subject, graph, body: req.body, timeZone: req.query.tz }));
});

// GET /api/subjects/:id/export?format=pdf|docx&tz=Asia/Kolkata
// Every note of the subject in one formatted file, with a contents list.
router.get("/:id/export", loadOwnedSubject, async (req, res, next) => {
  const format = parseFormat(req.query.format);
  if (!format) return res.status(400).json({ error: "format must be pdf or docx" });
  try {
    sendExport(res, await exportSubject(req.subject, { format, timeZone: req.query.tz }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

export default router;
