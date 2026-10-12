// Exam-season load test: many students using MindAtlas at the same moment.
//
// Each virtual student signs up, makes a subject, adds a note, builds a test,
// then for the length of the run keeps taking that test (start, answer every
// question, submit) and opening their progress and subjects - what the days
// before an exam look like. At the end: requests per second and how long
// each kind of request took (median, 95th percentile, slowest), and errors.
//
// NEVER against the live site: it creates accounts and fills the database.
// Run it against a local server or a copy of the deployment, started with
// the limits raised so the test measures the server, not the rate limiter:
//
//   cd server
//   DB_FILE=memory RATE_LIMIT_API_MAX=100000 RATE_LIMIT_AUTH_MAX=100000 \
//   RATE_LIMIT_REGISTER_MAX=100000 RATE_LIMIT_TEST_BUILD_MAX=100000 npm start
//   npm run load-test -- --students 50 --seconds 60
//
// Options: --url http://localhost:4000  --students 20  --seconds 30
import { performance } from "node:perf_hooks";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg("url", "http://localhost:4000").replace(/\/+$/, "");
const STUDENTS = Math.max(1, Number(arg("students", 20)));
const SECONDS = Math.max(5, Number(arg("seconds", 30)));
const host = new URL(BASE).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host) && !process.argv.includes("--not-production")) {
  console.error(`Refusing to load-test ${host}: it is not this computer. If it is a copy of the deployment (never the live site), add --not-production.`);
  process.exit(2);
}

const NOTE = `Memory management

Paging divides physical memory into fixed-size frames and logical memory into pages of the same size. The page table maps each page to a frame. A translation lookaside buffer caches recent translations. Segmentation divides a program into variable-sized segments such as code, data and stack, each with a base and a limit.

Scheduling

Round robin scheduling gives each process a fixed time quantum in turn. Shortest job first picks the process with the smallest next CPU burst. Priority scheduling can starve low-priority processes, which aging prevents. A context switch saves one process's state and loads another's.

Deadlocks

A deadlock needs mutual exclusion, hold and wait, no preemption and circular wait. The banker's algorithm avoids deadlock by granting a request only when the system stays in a safe state. Detection looks for a cycle in the wait-for graph.`;

const timings = new Map(); // label -> [ms]
let errors = 0;
const errorKinds = new Map();
async function call(label, path, { method = "GET", body, token } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errors++;
      const kind = `${label} ${res.status}`;
      errorKinds.set(kind, (errorKinds.get(kind) || 0) + 1);
    }
    return data;
  } catch (err) {
    errors++;
    errorKinds.set(`${label} ${err.code || err.name}`, (errorKinds.get(`${label} ${err.code || err.name}`) || 0) + 1);
    return {};
  } finally {
    const ms = performance.now() - t0;
    if (!timings.has(label)) timings.set(label, []);
    timings.get(label).push(ms);
  }
}

async function student(i, until) {
  const email = `load-${Date.now()}-${i}@example.com`;
  const { token } = await call("sign up", "/auth/register", { method: "POST", body: { email, password: "river-Kettle-42x" } });
  if (!token) return;
  const { subject } = await call("create subject", "/subjects", { method: "POST", token, body: { name: `Load ${i}` } });
  const { note } = await call("add note", `/subjects/${subject?._id}/notes`, { method: "POST", token, body: { title: "OS", content: NOTE } });
  const { test } = await call("build test", `/subjects/${subject?._id}/tests`, {
    method: "POST",
    token,
    body: { title: "Practice", noteIds: [note?._id], mcqCount: 4, theoryCount: 1, marksPerQuestion: 1, durationMinutes: 30 },
  });
  if (!test) return;
  while (Date.now() < until) {
    const start = await call("start test", `/tests/${test._id}/attempts`, { method: "POST", token });
    let q = start.question;
    for (let n = 0; q && n < 10; n++) {
      const answer = q.type === "theory" ? "Paging uses fixed-size frames and a page table." : q.options?.[0];
      q = (await call("answer", `/attempts/${start.attempt._id}/responses`, { method: "POST", token, body: { questionId: q._id, answer } })).nextQuestion;
    }
    if (start.attempt) await call("submit", `/attempts/${start.attempt._id}/submit`, { method: "POST", token });
    await call("progress", `/subjects/${subject._id}/progress`, { token });
    await call("subjects", "/subjects", { token });
  }
}

const pick = (list, p) => list[Math.min(list.length - 1, Math.floor((p / 100) * list.length))];
console.log(`Load test: ${STUDENTS} students for ${SECONDS} s against ${BASE}`);
const began = performance.now();
const until = Date.now() + SECONDS * 1000;
await Promise.all(Array.from({ length: STUDENTS }, (_, i) => student(i, until)));
const elapsed = (performance.now() - began) / 1000;
const total = [...timings.values()].reduce((n, l) => n + l.length, 0);
console.log(`\n${total} requests in ${elapsed.toFixed(1)} s = ${(total / elapsed).toFixed(1)} per second, ${errors} errors\n`);
console.log("request".padEnd(16), "count".padStart(7), "median".padStart(9), "95%".padStart(9), "slowest".padStart(9));
for (const [label, list] of timings) {
  list.sort((a, b) => a - b);
  const f = (ms) => `${Math.round(ms)} ms`.padStart(9);
  console.log(label.padEnd(16), String(list.length).padStart(7), f(pick(list, 50)), f(pick(list, 95)), f(list[list.length - 1]));
}
if (errorKinds.size) {
  console.log("\nErrors:");
  for (const [k, n] of errorKinds) console.log(`  ${k}: ${n}`);
}
