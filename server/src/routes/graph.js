import { requireAuth } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { findEdgeById, isRemoved, setEdgeCorrection, toApiEdge } from "../models/GraphEdge.js";
import { findNotesByIds } from "../models/Note.js";
import { findOwnedSubject } from "../models/Subject.js";
import { buildKeywordMap } from "../services/keywordMap.js";
import { exportKeywordMap } from "../services/graphExport/index.js";
import { sendExport } from "../services/noteExport/index.js";

const router = safeRouter();
router.use(requireAuth);

// POST /api/graph/edges/:id/correct   body: { action: "remove" | "restore" }
//
// The student's correction loop (named in the deep-dive doc's route table):
// "remove" marks a link as wrong, "restore" undoes that. The edge is flagged,
// never deleted - see models/GraphEdge.js. Feeding corrections back into the
// linking rule itself is post-prototype backlog (CONTRIBUTING.md, Member 2).
router.post("/edges/:id/correct", async (req, res) => {
  const { action } = req.body || {};
  if (action !== "remove" && action !== "restore") {
    return res.status(400).json({ error: 'action must be "remove" or "restore"' });
  }

  const edge = await findEdgeById(req.params.id);
  // Edges carry no owner of their own, so ownership is checked on the two
  // notes they join. Someone else's link is reported as not found.
  const ends = edge ? await findNotesByIds([edge.sourceNoteId, edge.targetNoteId]) : [];
  if (!edge || ends.length !== 2 || !ends.every((n) => String(n.ownerId) === String(req.user.id))) {
    return res.status(404).json({ error: "link not found" });
  }
  if (edge.edgeType === "rejected") {
    return res.status(400).json({ error: "these notes were never linked, so there is nothing to correct" });
  }

  const updated = await setEdgeCorrection(edge._id, action === "remove" ? "removed" : null);
  res.json({ edge: { ...toApiEdge(updated), removed: isRemoved(updated) } });
});

// The student's own note, or a 404: someone else's note is reported as not found.
async function loadOwnedNote(req, res, next) {
  const [note] = await findNotesByIds([req.params.noteId]);
  if (!note || String(note.ownerId) !== String(req.user.id)) {
    return res.status(404).json({ error: "note not found" });
  }
  req.note = note;
  next();
}

// GET /api/graph/notes/:noteId/keyword-map
// One note's keywords, the words each appears with, and the sentences it is
// used in - see services/keywordMap.js.
router.get("/notes/:noteId/keyword-map", loadOwnedNote, async (req, res) => {
  const { note } = req;
  res.json({
    note: { id: note._id, title: note.title, subjectId: note.subjectId },
    keywords: buildKeywordMap(note),
  });
});

// POST /api/graph/notes/:noteId/keyword-map/export?tz=Asia/Kolkata   body: { keyword? }
// The keyword map as a PDF, with `keyword` open as on the page, then every
// keyword's related words and sentences as a table - see services/graphExport/.
router.post("/notes/:noteId/keyword-map/export", loadOwnedNote, async (req, res) => {
  const subject = await findOwnedSubject(req.note.subjectId, req.user.id);
  sendExport(res, await exportKeywordMap({ note: req.note, subjectName: subject?.name || "", body: req.body, timeZone: req.query.tz }));
});

export default router;
