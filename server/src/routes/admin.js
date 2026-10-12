// The admin page's API: what a team running MindAtlas needs without editing
// the database by hand - questions students reported, suspending an account
// that abuses the app, and two numbers on whether new students get going.
//
// Only accounts listed in ADMIN_USER_IDS may use it (config.js). Everyone
// else is told "not found", so the admin API is not even visible to them.
// Every change an admin makes is written to admin_log. A reported question
// is shown with its answer key and the passage of notes it was written from
// (to judge the report) and the reporters' comments, never who reported it;
// nothing else of a student's notes or answers is shown.

import { getCollection } from "../db/index.js";
import { adminIds } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { email as emailField, text } from "../middleware/validate.js";
import { findQuestionsByIds } from "../models/Question.js";
import { countUsers, findUserByEmail, findUserById, findUsersSince, setSuspended } from "../models/User.js";

const router = safeRouter();
router.use(requireAuth, (req, res, next) => {
  if (!adminIds().includes(req.user.id)) return res.status(404).json({ error: "not found" });
  next();
});

const DAY = 86_400_000;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

// GET /api/admin/overview - sign-ups and the two health numbers, for the
// students who joined in the last 90 days:
//   started    added a note in their first week (their first graph);
//   tested     finished a test in their first week;
//   returned   used the app in their second week (counted only for those who
//              joined at least 14 days ago, so the week is over).
router.get("/overview", async (req, res) => {
  const now = Date.now();
  const cohort = await findUsersSince(new Date(now - 90 * DAY));
  const inFirstWeek = (u, field) => u[field] && new Date(u[field]) - new Date(u.createdAt) < 7 * DAY;
  const matured = cohort.filter((u) => now - new Date(u.createdAt) >= 14 * DAY);
  const started = cohort.filter((u) => inFirstWeek(u, "firstNoteAt")).length;
  const tested = cohort.filter((u) => inFirstWeek(u, "firstTestAt")).length;
  const returned = matured.filter((u) => u.activeInWeek2).length;
  res.json({
    accounts: await countUsers(),
    last90Days: {
      signedUp: cohort.length,
      startedInWeek1: { count: started, percent: pct(started, cohort.length) },
      testedInWeek1: { count: tested, percent: pct(tested, cohort.length) },
      returnedInWeek2: { count: returned, of: matured.length, percent: pct(returned, matured.length) },
    },
    suspended: cohort.filter((u) => u.suspended).length,
  });
});

// GET /api/admin/reports - reported questions, most-reported first: the
// question, its answer key and source passage, and the reasons and comments
// (never who reported it).
router.get("/reports", async (req, res) => {
  const rows = await getCollection("question_reports").find({});
  const byQuestion = new Map();
  for (const r of rows) {
    const key = String(r.questionId);
    if (!byQuestion.has(key)) byQuestion.set(key, { questionId: r.questionId, reports: [], lastAt: r.reportedAt });
    const entry = byQuestion.get(key);
    entry.reports.push({ reason: r.reason, comment: r.comment || "", at: r.reportedAt });
    if (new Date(r.reportedAt) > new Date(entry.lastAt)) entry.lastAt = r.reportedAt;
  }
  const top = [...byQuestion.values()].sort((a, b) => b.reports.length - a.reports.length || new Date(b.lastAt) - new Date(a.lastAt)).slice(0, 200);
  const questions = new Map((await findQuestionsByIds(top.map((t) => t.questionId))).map((q) => [String(q._id), q]));
  res.json({
    total: rows.length,
    questions: top.map((t) => {
      const q = questions.get(String(t.questionId));
      return {
        ...t,
        question: q
          ? { type: q.type, prompt: q.prompt, options: q.options || null, answerKey: q.answerKey, source: q.supportingExcerpt, topic: q.topic, generatedBy: q.generatedBy, promptVersion: q.promptVersion || null, model: q.model || null }
          : null,
      };
    }),
  });
});

// POST /api/admin/users/find  { email } - look an account up (by POST, so the
// address stays out of server and proxy logs). Returns only what deciding on
// a suspension needs.
router.post("/users/find", async (req, res) => {
  const user = await findUserByEmail(emailField(req.body?.email));
  if (!user) return res.status(404).json({ error: "no account with that email" });
  res.json({ user: { id: user._id, createdAt: user.createdAt, suspended: Boolean(user.suspended), lastActiveAt: user.lastActiveAt || null } });
});

// POST /api/admin/users/:id/suspend  { suspended: true|false, reason }
router.post("/users/:id/suspend", async (req, res) => {
  if (typeof req.body?.suspended !== "boolean") return res.status(400).json({ error: "suspended must be true or false" });
  const reason = text(req.body?.reason, "reason", { max: 500 });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "you cannot suspend your own account" });
  if (!(await findUserById(req.params.id))) return res.status(404).json({ error: "no such account" });
  const user = await setSuspended(req.params.id, req.body.suspended);
  await getCollection("admin_log").insertOne({
    adminId: req.user.id,
    action: req.body.suspended ? "suspend" : "restore",
    targetUserId: req.params.id,
    reason,
    at: new Date(),
  });
  res.json({ user: { id: user._id, suspended: Boolean(user.suspended) } });
});

export default router;
