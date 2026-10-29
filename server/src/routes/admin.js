// The admin page's API: what a team running MindAtlas needs without editing
// the database by hand - whether the server and database are healthy, how
// the app is used, questions students reported (and acting on them: resolve,
// dismiss, retire a question for everyone), the accounts, suspending one that
// abuses the app, and a log of every admin action.
//
// Only accounts listed in ADMIN_USER_IDS may use it (config.js). Everyone
// else is told "not found", so the admin API is not even visible to them.
// Every change an admin makes is written to admin_log. A reported question
// is shown with its answer key and the passage of notes it was written from
// (to judge the report) and the reporters' comments, never who reported it;
// nothing else of a student's notes or answers is shown.

import fs from "node:fs";
import { dbInfo, dbStats, getCollection } from "../db/index.js";
import { adminIds, envNumber } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { safeRouter } from "../middleware/safeRouter.js";
import { email as emailField, id as idField, oneOf, text } from "../middleware/validate.js";
import { findQuestionsByIds, setQuestionRetired } from "../models/Question.js";
import { llmAvailable, llmModel, llmProvider, visionAvailable } from "../services/llm.js";
import { mailStatus } from "../services/mailer.js";
import { semanticStatus } from "../services/embeddings.js";
import { countUsers, findUserByEmail, findUserById, findUsersSince, setSuspended } from "../models/User.js";

const router = safeRouter();
router.use(requireAuth, (req, res, next) => {
  if (!adminIds().includes(req.user.id)) return res.status(404).json({ error: "not found" });
  next();
});

const DAY = 86_400_000;
const MB = 1024 * 1024;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
const log = (req, entry) => getCollection("admin_log").insertOne({ adminId: req.user.id, ...entry, at: new Date() });

// The memory this server may use before the host stops it: MEMORY_LIMIT_MB,
// else the container's own limit (cgroup v2, then v1), else 512 MB on Render's
// free plan. Null when unknown (a laptop has no such limit).
function memoryLimitBytes() {
  const set = envNumber("MEMORY_LIMIT_MB", 0);
  if (set) return set * MB;
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const n = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isFinite(n) && n > 0 && n < 64 * 1024 * MB) return n;
    } catch {
      // not in a container, or not this cgroup version
    }
  }
  return process.env.RENDER ? 512 * MB : null;
}

// Highest memory use since the server started, sampled every 5 s: a free
// instance is stopped when it goes over its limit, usually during an upload,
// so the peak says more than the reading at the moment the page is opened.
const startedAt = new Date();
let peakRss = process.memoryUsage().rss;
setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 5000).unref();

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
    // theory answers whose handwriting could not be read with confidence
    // (gradingEngine.gradeTheoryWithImages): a count only - no answer, picture
    // or student is shown here; the student sees the flag on their review
    answersFlaggedForReview: (await getCollection("responses").find({ needsReview: true })).length,
    answerImages: (await getCollection("answer_images").find({})).length,
  });
});

// GET /api/admin/health - is it working, and how close to its limits: memory
// against the host's limit, database storage against its quota (Atlas M0:
// 512 MB, DB_QUOTA_MB to change), and which optional services are on.
router.get("/health", async (req, res) => {
  const mem = process.memoryUsage();
  peakRss = Math.max(peakRss, mem.rss);
  const info = dbInfo();
  const stats = await dbStats().catch(() => null);
  res.json({
    server: {
      rssBytes: mem.rss,
      peakRssBytes: peakRss,
      heapUsedBytes: mem.heapUsed,
      memoryLimitBytes: memoryLimitBytes(),
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      commit: (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || null,
    },
    database: {
      kind: info.kind,
      persistent: info.persistent,
      usedBytes: stats ? stats.dataBytes + stats.indexBytes : null,
      quotaBytes: info.kind === "mongodb" ? envNumber("DB_QUOTA_MB", 512) * MB : null,
      collections: stats ? [...stats.collections].sort((a, b) => b.bytes - a.bytes) : [],
    },
    ai: { enabled: llmAvailable(), provider: llmProvider().name, model: llmModel(), vision: visionAvailable() },
    email: mailStatus(),
    semantic: semanticStatus(),
  });
});

// GET /api/admin/usage - how much the app is used: active accounts, totals,
// and sign-ups per week for the last 12 weeks (oldest first).
router.get("/usage", async (req, res) => {
  const now = Date.now();
  const users = await findUsersSince(new Date(0));
  const activeWithin = (days) => users.filter((u) => u.lastActiveAt && now - new Date(u.lastActiveAt) < days * DAY).length;
  const count = (name, filter = {}) => getCollection(name).countDocuments(filter);
  const [subjects, notes, tests, attempts, finishedAttempts, questions, answerImages, reports] = await Promise.all([
    count("subjects"),
    count("notes"),
    count("tests"),
    count("attempts"),
    count("attempts", { status: "submitted" }),
    count("questions", { status: "accepted" }),
    count("answer_images"),
    count("question_reports"),
  ]);
  const signupsByWeek = Array.from({ length: 12 }, (_, i) => {
    const end = now - (11 - i) * 7 * DAY;
    const start = end - 7 * DAY;
    const signups = users.filter((u) => {
      const t = new Date(u.createdAt).getTime();
      return t >= start && t < end;
    }).length;
    return { weekStart: new Date(start), signups };
  });
  res.json({
    accounts: users.length,
    active7: activeWithin(7),
    active30: activeWithin(30),
    suspended: users.filter((u) => u.suspended).length,
    totals: { subjects, notes, tests, attempts, finishedAttempts, questions, answerImages, reports },
    signupsByWeek,
  });
});

// GET /api/admin/users - every account (newest activity first, up to 500)
// with what it holds. No email addresses: the list shows that accounts are
// used, not who they are. To find a particular student, look the address up
// (POST /users/find).
router.get("/users", async (req, res) => {
  const admins = new Set(adminIds());
  const all = await findUsersSince(new Date(0));
  const recent = (u) => new Date(u.lastActiveAt || u.createdAt).getTime();
  const shown = [...all].sort((a, b) => recent(b) - recent(a)).slice(0, 500);
  const count = (name, ownerId) => getCollection(name).countDocuments({ ownerId });
  const users = await Promise.all(
    shown.map(async (u) => {
      const ownerId = String(u._id);
      const [notes, tests, attempts] = await Promise.all([count("notes", ownerId), count("tests", ownerId), count("attempts", ownerId)]);
      return {
        id: ownerId,
        createdAt: u.createdAt,
        lastActiveAt: u.lastActiveAt || null,
        suspended: Boolean(u.suspended),
        admin: admins.has(ownerId),
        you: ownerId === req.user.id,
        notes,
        tests,
        attempts,
      };
    })
  );
  res.json({ total: all.length, users });
});

// GET /api/admin/log - the latest 100 admin actions, newest first.
router.get("/log", async (req, res) => {
  const rows = await getCollection("admin_log").find({}, { sort: { at: -1 } });
  res.json({
    entries: rows.slice(0, 100).map((r) => ({
      action: r.action,
      targetUserId: r.targetUserId || null,
      targetQuestionId: r.targetQuestionId || null,
      reason: r.reason || "",
      at: r.at,
      by: r.adminId === req.user.id ? "you" : String(r.adminId).slice(-6),
    })),
  });
});

// POST /api/admin/questions/:id/review  { status: open|resolved|dismissed, note? }
// Record what the team decided about a reported question. Reports stay as
// they are (each still hides the question from the student who made it).
router.post("/questions/:id/review", async (req, res) => {
  const questionId = idField(req.params.id, "question id");
  const status = oneOf(req.body?.status, "status", ["open", "resolved", "dismissed"]);
  const note = text(req.body?.note, "note", { required: false, max: 500 });
  const [question] = await findQuestionsByIds([questionId]);
  if (!question) return res.status(404).json({ error: "no such question" });
  await getCollection("question_reviews").findOneAndUpdate(
    { questionId },
    { $set: { questionId, status, note, adminId: req.user.id, at: new Date() } },
    { upsert: true }
  );
  await log(req, { action: `report-${status}`, targetQuestionId: questionId, reason: note });
  res.json({ questionId, status });
});

// POST /api/admin/questions/:id/retire  { retired: true|false, reason? }
// Take a broken question out of every future attempt, for every student.
router.post("/questions/:id/retire", async (req, res) => {
  const questionId = idField(req.params.id, "question id");
  if (typeof req.body?.retired !== "boolean") return res.status(400).json({ error: "retired must be true or false" });
  const reason = text(req.body?.reason, "reason", { required: false, max: 500 });
  const [question] = await findQuestionsByIds([questionId]);
  if (!question) return res.status(404).json({ error: "no such question" });
  const updated = await setQuestionRetired(questionId, req.body.retired, { by: req.user.id, reason });
  await log(req, { action: req.body.retired ? "retire-question" : "unretire-question", targetQuestionId: questionId, reason });
  res.json({ questionId, retired: Boolean(updated?.retiredAt) });
});

// GET /api/admin/reports - reported questions, most-reported first: the
// question, its answer key and source passage, the reasons and comments
// (never who reported it), what the team decided, and whether it is retired.
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
  const reviews = new Map((await getCollection("question_reviews").find({})).map((r) => [String(r.questionId), r]));
  res.json({
    total: rows.length,
    questions: top.map((t) => {
      const q = questions.get(String(t.questionId));
      const review = reviews.get(String(t.questionId));
      return {
        ...t,
        status: review?.status || "open",
        reviewNote: review?.note || "",
        reviewedAt: review?.at || null,
        retired: Boolean(q?.retiredAt),
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
