// The admin page's API end to end, against the real server: health, usage,
// the accounts list, the activity log, and acting on reported questions -
// above all, that a question an admin retires is never given to any student
// again, and that a non-admin cannot see or use any of it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 4588;
const API = `http://localhost:${PORT}/api`;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ma-admin-")), "db.json");
const PASSWORD = "river-Kettle-42x";
let server;
let serverLog = "";
const extraEnv = {};

async function startServer() {
  server = spawn(process.execPath, ["src/index.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: "",
      DB_FILE: DB,
      GROQ_API_KEY: "",
      SEMANTIC_MODEL: "off",
      NODE_ENV: "development",
      SIGNUP_CHALLENGE: "off",
      RATE_LIMIT_AUTH_MAX: "500",
      RATE_LIMIT_TEST_BUILD_MAX: "100",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) return;
    } catch {
      await wait(200);
    }
  }
  throw new Error(`API did not start on port ${PORT}\n${serverLog}`);
}
async function stopServer() {
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
}

const call = async (p, { method = "GET", body, token } = {}) => {
  const res = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost:5173", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { ...data, http: res.status };
};

const NOTE = `Paging

Paging is a memory management scheme that divides physical memory into fixed-size blocks called frames. Logical memory is divided into blocks of the same size called pages. The page table maps each page of a process to a frame in physical memory. Paging avoids external fragmentation because any free frame can hold any page. A translation lookaside buffer is a small fast cache that stores recent page table entries.

Deadlocks

A deadlock is a situation in which a set of processes wait forever for resources held by each other. Four conditions must hold for a deadlock: mutual exclusion, hold and wait, no preemption and circular wait. The banker's algorithm avoids deadlock by granting a request only when the system stays in a safe state. Deadlock detection builds a wait-for graph and looks for a cycle.

Scheduling

Round robin scheduling gives each process a fixed time quantum in turn. Shortest job first scheduling picks the process with the smallest next CPU burst. Priority scheduling can cause starvation, which aging prevents by raising the priority of waiting processes. Context switching saves the state of one process and loads the state of another.`;

try {
  await startServer();
  const register = async (email) => (await call("/auth/register", { method: "POST", body: { email, password: PASSWORD } })).token;
  let adminToken = await register("admin-page@example.com");
  let studentToken = await register("admin-student@example.com");
  const adminId = (await call("/auth/me", { token: adminToken })).user.id;

  // the student's material: a subject, a note, a test
  const subject = (await call("/subjects", { method: "POST", token: studentToken, body: { name: "Operating Systems" } })).subject;
  await call(`/subjects/${subject._id}/notes`, { method: "POST", token: studentToken, body: { title: "OS notes", content: NOTE } });
  const notes = (await call(`/subjects/${subject._id}/notes`, { token: studentToken })).notes;
  const topics = notes.filter((n) => n.parentNoteId).map((n) => n._id);
  const built = await call(`/subjects/${subject._id}/tests`, {
    method: "POST",
    token: studentToken,
    body: { title: "Unit test", noteIds: topics.length ? topics : notes.map((n) => n._id), mcqCount: 4, theoryCount: 0, durationMinutes: 15 },
  });
  const testId = built.test?._id;
  check("the student's test was built", Boolean(testId), built.error || "");
  const testView = await call(`/tests/${testId}`, { token: studentToken });
  const questionIds = (testView.questions || testView.test?.questions || []).map((q) => q._id);
  check("the test has questions to act on", questionIds.length >= 2, `${questionIds.length} questions`);
  const first = questionIds[0];
  await call(`/questions/${first}/report`, { method: "POST", token: studentToken, body: { reason: "wrong-answer", comment: "Key is wrong" } });

  // restart with the admin account named in ADMIN_USER_IDS, and a known memory limit
  await stopServer();
  extraEnv.ADMIN_USER_IDS = adminId;
  extraEnv.MEMORY_LIMIT_MB = "300";
  await startServer();
  adminToken = (await call("/auth/login", { method: "POST", body: { email: "admin-page@example.com", password: PASSWORD } })).token;
  studentToken = (await call("/auth/login", { method: "POST", body: { email: "admin-student@example.com", password: PASSWORD } })).token;

  console.log("\n=== Only admins ===");
  for (const p of ["/admin/health", "/admin/usage", "/admin/users", "/admin/log"]) {
    check(`a student gets 404 from ${p}`, (await call(p, { token: studentToken })).http === 404);
  }
  check("a student cannot retire a question", (await call(`/admin/questions/${first}/retire`, { method: "POST", token: studentToken, body: { retired: true } })).http === 404);
  check("a student cannot review a report", (await call(`/admin/questions/${first}/review`, { method: "POST", token: studentToken, body: { status: "dismissed" } })).http === 404);
  check("signed out gets nothing", (await call("/admin/health")).http === 401);

  console.log("\n=== Health ===");
  const health = await call("/admin/health", { token: adminToken });
  check("memory is reported", health.server?.rssBytes > 0 && health.server.peakRssBytes >= health.server.rssBytes);
  check("MEMORY_LIMIT_MB sets the limit shown", health.server?.memoryLimitBytes === 300 * 1024 * 1024, String(health.server?.memoryLimitBytes));
  check("the database and its size are reported", health.database?.kind === "local-file" && health.database.usedBytes > 0);
  check("collections are listed largest first", health.database?.collections?.length > 0 && health.database.collections[0].bytes >= health.database.collections.at(-1).bytes);
  check("no AI key: AI shown as off", health.ai?.enabled === false);
  check("the meaning model shows as off", health.semantic?.state === "off");

  console.log("\n=== Usage ===");
  const usage = await call("/admin/usage", { token: adminToken });
  check("both accounts are counted", usage.accounts === 2, String(usage.accounts));
  check("notes and tests are counted", usage.totals?.notes > 0 && usage.totals?.tests === 1);
  check("12 weeks of sign-ups, this week holding both", usage.signupsByWeek?.length === 12 && usage.signupsByWeek.at(-1).signups === 2);
  check("the report is counted", usage.totals?.reports === 1);

  console.log("\n=== Accounts ===");
  const users = await call("/admin/users", { token: adminToken });
  const raw = JSON.stringify(users);
  check("both accounts are listed", users.total === 2 && users.users.length === 2);
  check("no email address is in the list", !raw.includes("@example.com") && !raw.includes('"email"'));
  const me = users.users.find((u) => u.id === adminId);
  const student = users.users.find((u) => u.id !== adminId);
  check("the admin's own row says so", me?.you === true && me?.admin === true);
  check("the student's notes and tests are counted", student?.notes > 0 && student?.tests === 1);

  console.log("\n=== Acting on a report ===");
  let reports = await call("/admin/reports", { token: adminToken });
  let row = reports.questions.find((r) => r.questionId === first);
  check("a new report is open and not retired", row?.status === "open" && row?.retired === false);
  check("an unknown status is refused", (await call(`/admin/questions/${first}/review`, { method: "POST", token: adminToken, body: { status: "deleted" } })).http === 400);
  check("an unknown question is 404", (await call(`/admin/questions/${"a".repeat(24)}/review`, { method: "POST", token: adminToken, body: { status: "resolved" } })).http === 404);
  const reviewed = await call(`/admin/questions/${first}/review`, { method: "POST", token: adminToken, body: { status: "resolved", note: "Key fixed in notes" } });
  check("marking it resolved works", reviewed.http === 200 && reviewed.status === "resolved");
  reports = await call("/admin/reports", { token: adminToken });
  row = reports.questions.find((r) => r.questionId === first);
  check("the report now shows resolved, with the note", row?.status === "resolved" && row?.reviewNote === "Key fixed in notes");

  console.log("\n=== Retiring questions ===");
  check("retired must be true or false", (await call(`/admin/questions/${first}/retire`, { method: "POST", token: adminToken, body: { retired: "yes" } })).http === 400);
  for (const q of questionIds) {
    await call(`/admin/questions/${q}/retire`, { method: "POST", token: adminToken, body: { retired: true, reason: "Faulty batch" } });
  }
  reports = await call("/admin/reports", { token: adminToken });
  check("the report shows the question as retired", reports.questions.find((r) => r.questionId === first)?.retired === true);
  const blocked = await call(`/tests/${testId}/attempts`, { method: "POST", token: studentToken, body: {} });
  check("with every question retired, the student cannot start the test", blocked.http === 400 && blocked.code === "all_retired", `${blocked.http} ${blocked.code}`);
  check("and is told why, not that they marked them invalid", /withdrawn/.test(blocked.error || ""), blocked.error);

  const keep = questionIds[1];
  const back = await call(`/admin/questions/${keep}/retire`, { method: "POST", token: adminToken, body: { retired: false } });
  check("a question can be brought back", back.retired === false);
  const attempt = await call(`/tests/${testId}/attempts`, { method: "POST", token: studentToken, body: {} });
  const given = attempt.question?._id || attempt.currentQuestion?._id || attempt.questions?.[0]?._id;
  check("a new attempt starts", attempt.http === 201, `${attempt.http} ${attempt.error || ""}`);
  check("and gives only the question that was brought back", given === keep, `given ${given}, expected ${keep}`);

  console.log("\n=== Activity log ===");
  const log = await call("/admin/log", { token: adminToken });
  const actions = log.entries?.map((e) => e.action) || [];
  check("retiring is logged, with its reason", log.entries?.some((e) => e.action === "retire-question" && e.reason === "Faulty batch"));
  check("bringing back and resolving are logged", actions.includes("unretire-question") && actions.includes("report-resolved"));
  check("entries say who acted", log.entries?.every((e) => e.by === "you"));
  check("newest first", new Date(log.entries[0].at) >= new Date(log.entries.at(-1).at));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  if (server) await stopServer();
}

console.log(`\n${failures === 0 ? "All checks passed." : failures + " FAILING CHECK(S)"}`);
process.exit(failures === 0 ? 0 : 1);
