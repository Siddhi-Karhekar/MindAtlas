import { Router } from "express";
import { createSubject, findSubjectsByOwner, findOwnedSubject } from "../models/Subject.js";
import { findNotesBySubject } from "../models/Note.js";
import { findEdgesBySubject } from "../models/GraphEdge.js";
import { requireAuth } from "../middleware/auth.js";

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

router.get("/:id/graph", loadOwnedSubject, async (req, res) => {
  const notes = await findNotesBySubject(req.subject._id);
  const edges = await findEdgesBySubject(req.subject._id);

  res.json({
    nodes: notes.map((n) => ({
      id: n._id,
      title: n.title,
      keywords: n.keywords,
      sourceType: n.sourceType,
      createdAt: n.createdAt,
    })),
    edges: edges.map((e) => ({
      id: e._id,
      source: e.sourceNoteId,
      target: e.targetNoteId,
      weight: e.weight,
      sharedKeywords: e.sharedKeywords,
    })),
  });
});

export default router;
