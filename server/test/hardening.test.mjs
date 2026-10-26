// Checks for the fixes of the October 2026 security audit
// (docs/SECURITY_AUDIT.md). Each one shows the attack or failure the fix stops:
//   A. note edits cannot make the server ask the AI without limit
//   B. two starts of one test sent together open one attempt, not two
//   C. changes to notes are rate limited per student
//   D. a deploy's SIGTERM lets the request in flight finish, then stops
// (The answer-leak fix is checked in assessment.test.mjs, where tests are built.)
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + String(detail).slice(0, 200) : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the AI service: counts what it is asked, answers slowly when told to.
let aiCalls = 0;
let aiDelay = 0;
const fakeAi = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    aiCalls++;
    if (aiDelay) await wait(aiDelay);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"sections": []}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise((r) => fakeAi.listen(4761, r));

async function startServer(port, env = {}) {
  let log = "";
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), MONGODB_URI: "", DB_FILE: "memory", NODE_ENV: "development", SEMANTIC_MODEL: "off", RATE_LIMIT_AUTH_MAX: "500", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const API = `http://localhost:${port}/api`;
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) break;
    } catch {
      await wait(200);
    }
  }
  const call = async (path, { method = "GET", body, token } = {}) => {
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const signUp = async (name) => (await call("/auth/register", { method: "POST", body: { email: `${name}-${port}@example.com`, password: "river-Kettle-42x" } })).token;
  return { child, call, signUp, log: () => log };
}
const stop = (child) => new Promise((r) => (child.exitCode !== null ? r() : (child.once("exit", r), child.kill("SIGTERM"))));

const NOTE =
  "Paging divides memory into fixed frames. The page table maps each page to a frame. A translation lookaside buffer caches recent page table entries. A page fault occurs when a page is not in main memory. Segmentation divides memory into variable segments.";

const servers = [];
try {
  console.log("\n=== A. Note edits cannot run up the AI bill ===");
  {
    const s = await startServer(4762, { GROQ_API_KEY: "test-key", LLM_API_URL: "http://localhost:4761/v1/chat/completions", AI_TERMS_PER_HOUR: "3" });
    servers.push(s.child);
    const me = await s.signUp("ai");
    const subject = (await s.call("/subjects", { method: "POST", token: me, body: { name: "OS" } })).subject;
    const note = (await s.call(`/subjects/${subject._id}/notes`, { method: "POST", token: me, body: { title: "Paging", content: NOTE } })).note;
    await wait(500);
    const start = aiCalls;
    for (let i = 0; i < 12; i++) {
      const r = await s.call(`/notes/${note._id}`, { method: "PATCH", token: me, body: { content: `${NOTE} Edit number ${i}.` } });
      if (r.status !== 200) throw new Error(`edit failed: ${r.status} ${r.error}`);
    }
    await wait(1500);
    const asked = aiCalls - start;
    check("12 quick edits of one note ask the AI at most the hourly budget (3, counting the upload)", asked <= 3, `${asked} asks`);
    check("...and the skips are logged (counts, no text)", /hourly limit for this student reached/.test(s.log()) && !s.log().includes("Edit number"));
    const other = await s.signUp("ai-other");
    const subj2 = (await s.call("/subjects", { method: "POST", token: other, body: { name: "OS" } })).subject;
    const before = aiCalls;
    await s.call(`/subjects/${subj2._id}/notes`, { method: "POST", token: other, body: { title: "Paging", content: NOTE } });
    await wait(1000);
    check("another student's budget is their own", aiCalls > before, `${aiCalls - before} asks`);
  }

  console.log("\n=== B. One test, one open attempt ===");
  {
    const s = await startServer(4763);
    servers.push(s.child);
    const me = await s.signUp("race");
    const subject = (await s.call("/subjects", { method: "POST", token: me, body: { name: "OS" } })).subject;
    const note = (await s.call(`/subjects/${subject._id}/notes`, { method: "POST", token: me, body: { title: "Paging", content: NOTE } })).note;
    const built = await s.call(`/subjects/${subject._id}/tests`, { method: "POST", token: me, body: { title: "Race", noteIds: [note._id], mcqCount: 2, theoryCount: 0, marksPerQuestion: 1, durationMinutes: 5 } });
    check("a test was built", built.status === 201, built.error);
    // different bodies, so the double-submit guard (once) does not merge them
    const starts = await Promise.all([{}, { a: 1 }, { b: 2 }, { c: 3 }].map((body) => s.call(`/tests/${built.test._id}/attempts`, { method: "POST", token: me, body })));
    const ids = new Set(starts.map((r) => r.attempt?._id).filter(Boolean));
    check("four starts sent together open exactly one attempt", ids.size === 1, starts.map((r) => `${r.status}:${r.attempt?._id}`).join(" "));
    check("...the others carry on that attempt", starts.filter((r) => r.resumed).length === 3);
  }

  console.log("\n=== C. Changes to notes are rate limited ===");
  {
    const s = await startServer(4764, { RATE_LIMIT_NOTE_EDIT_MAX: "5" });
    servers.push(s.child);
    const me = await s.signUp("limit");
    const subject = (await s.call("/subjects", { method: "POST", token: me, body: { name: "OS" } })).subject;
    const note = (await s.call(`/subjects/${subject._id}/notes`, { method: "POST", token: me, body: { title: "Paging", content: NOTE } })).note;
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await s.call(`/notes/${note._id}`, { method: "PATCH", token: me, body: { content: `${NOTE} ${i}` } })).status);
    check("the sixth change in 15 minutes is refused (limit 5 here)", codes.slice(0, 5).every((c) => c === 200) && codes[5] === 429, codes.join(","));
    const lines = (await s.call(`/notes/${note._id}/lines`, { method: "PATCH", token: me, body: { op: "delete", index: 0 } })).status;
    check("...line edits share the same limit", lines === 429, String(lines));
    const other = await s.signUp("limit-other");
    const subj2 = (await s.call("/subjects", { method: "POST", token: other, body: { name: "OS" } })).subject;
    const n2 = (await s.call(`/subjects/${subj2._id}/notes`, { method: "POST", token: other, body: { title: "Paging", content: NOTE } })).note;
    check("...and another student is not affected", (await s.call(`/notes/${n2._id}`, { method: "PATCH", token: other, body: { content: `${NOTE} x` } })).status === 200);
  }

  console.log("\n=== D. A deploy lets the request in flight finish ===");
  {
    const s = await startServer(4765, { GROQ_API_KEY: "test-key", LLM_API_URL: "http://localhost:4761/v1/chat/completions", KEYTERMS_AI: "off", SHUTDOWN_GRACE_SECONDS: "20" });
    const me = await s.signUp("stop");
    const subject = (await s.call("/subjects", { method: "POST", token: me, body: { name: "OS" } })).subject;
    const note = (await s.call(`/subjects/${subject._id}/notes`, { method: "POST", token: me, body: { title: "Paging", content: NOTE } })).note;
    aiDelay = 2500; // the AI is slow: the build is still running when SIGTERM arrives
    const building = s.call(`/subjects/${subject._id}/tests`, { method: "POST", token: me, body: { title: "During a deploy", noteIds: [note._id], mcqCount: 2, theoryCount: 0, marksPerQuestion: 1, durationMinutes: 5 } });
    await wait(700);
    const exited = new Promise((r) => s.child.once("exit", (code) => r(code)));
    s.child.kill("SIGTERM");
    const built = await building;
    aiDelay = 0;
    check("the test being built when the stop signal came is still answered", built.status === 201, `${built.status} ${built.error || ""}`);
    check("...then the server stops on its own, cleanly", (await exited) === 0);
    let refused = false;
    try {
      await fetch("http://localhost:4765/api/health");
    } catch {
      refused = true;
    }
    check("...and takes no new requests", refused);
  }
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await Promise.all(servers.map(stop));
  fakeAi.close();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
