// Request timing (middleware/timing.js) and the CORS preflight cache. Starts
// the real server (in-memory database, no API keys) with every request
// counted as slow, so each one is logged, and checks:
//   - a signed-in answer carries Server-Timing with the database's share and
//     the number of queries, also after a JSON or file body has been read;
//   - sign-in and sign-up answers carry none (the number of queries would say
//     whether an account exists);
//   - the slow-request log names the route pattern, never ids, query strings
//     or email addresses;
//   - a preflight answer may be reused for two hours.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 4621;
const API = `http://localhost:${PORT}/api`;
const DEV_ORIGIN = "http://localhost:5173"; // allowed outside production
const server = spawn(process.execPath, ["src/index.js"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, PORT: String(PORT), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", SEMANTIC_MODEL: "off", SMTP_HOST: "", NODE_ENV: "development", SLOW_REQUEST_MS: "0.001" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, { method = "GET", body, token, form } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { Origin: DEV_ORIGIN, ...(form ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, timing: res.headers.get("server-timing"), data: await res.json().catch(() => ({})) };
}
// "db;dur=0.4;desc=\"3 queries\", total;dur=2.1" -> { db: 0.4, queries: 3, total: 2.1 }
function parseTiming(header) {
  const m = String(header || "").match(/^db;dur=([\d.]+);desc="(\d+) queries", total;dur=([\d.]+)$/);
  return m ? { db: Number(m[1]), queries: Number(m[2]), total: Number(m[3]) } : null;
}

try {
  let up = false;
  for (let i = 0; i < 300 && !up && server.exitCode === null; i++) {
    up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    if (!up) await wait(200);
  }
  if (!up) throw new Error(`server did not start\n${serverLog}`);

  console.log("\n=== Server-Timing ===");
  const email = "timing.student@example.com";
  const password = "river-Kettle-42x";
  const register = await call("/auth/register", { method: "POST", body: { email, password } });
  const token = register.data.token;
  check("sign-up answers without it", register.status === 201 && register.timing === null, register.timing || "");
  const login = await call("/auth/login", { method: "POST", body: { email, password } });
  check("sign-in answers without it", login.status === 200 && login.timing === null, login.timing || "");
  const wrong = await call("/auth/login", { method: "POST", body: { email: "nobody@example.com", password } });
  check("a failed sign-in answers without it", wrong.status === 401 && wrong.timing === null, wrong.timing || "");
  check("a request that is not signed in gets none", (await call("/subjects")).timing === null);

  const list = await call("/subjects", { token });
  const t = parseTiming(list.timing);
  check("a signed-in request gets db time, queries and total", list.status === 200 && t !== null, list.timing || "missing");
  check("  ...its queries are counted (the session's account, the subjects)", t?.queries >= 2, `${t?.queries} queries`);
  check("  ...and db time is part of the total", t && t.db <= t.total, list.timing || "");

  const made = await call("/subjects", { method: "POST", token, body: { name: "Operating systems" } });
  const madeT = parseTiming(made.timing);
  // the insert happens after the JSON body is read: still counted
  check("queries after a JSON body is read are counted", made.status === 201 && madeT?.queries >= 2, made.timing || "missing");
  const subjectId = made.data.subject?._id;

  const form = new FormData();
  form.append("file", new Blob(["# Paging\n\nPaging divides memory into fixed-size frames. The page table maps each page to a frame."]), "paging.md");
  const uploaded = await call(`/subjects/${subjectId}/notes`, { method: "POST", token, form });
  const upT = parseTiming(uploaded.timing);
  check("queries after an uploaded file is read are counted", uploaded.status === 201 && upT?.queries >= 3, uploaded.timing || "missing");

  await call(`/subjects/${subjectId}/graph?view=full`, { token });
  await wait(100); // the log line is written when the answer has gone

  console.log("\n=== Slow-request log ===");
  const slow = serverLog.split("\n").filter((l) => l.startsWith("[slow] "));
  check("each slow request is logged", slow.length >= 8, `${slow.length} lines`);
  check("with the route pattern, its status, total and db time",
    slow.some((l) => /^\[slow\] GET \/api\/subjects\/:id\/graph 200 \d+ ms \(db \d+ ms, \d+ queries\)$/.test(l)),
    slow.find((l) => l.includes("graph")) || "none");
  check("a route's trailing slash is dropped", slow.some((l) => l.startsWith("[slow] GET /api/subjects 200 ")));
  check("no id appears in a line", !slow.some((l) => /[0-9a-f]{24}/i.test(l)));
  check("no query string appears in a line", !slow.some((l) => l.includes("?")));
  check("no email address appears in a line", !slow.some((l) => l.includes("@")));

  console.log("\n=== CORS preflight ===");
  const preflight = await fetch(`${API}/subjects`, {
    method: "OPTIONS",
    headers: { Origin: DEV_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  check("a browser may reuse the answer for two hours", preflight.headers.get("access-control-max-age") === "7200",
    preflight.headers.get("access-control-max-age") || "missing");
} catch (err) {
  console.error("FAILED:", err.message);
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
