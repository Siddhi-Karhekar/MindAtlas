import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { findEdgeById, isRemoved, setEdgeCorrection, toApiEdge } from "../models/GraphEdge.js";
import { findNotesByIds } from "../models/Note.js";

const router = Router();
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

export default router;
