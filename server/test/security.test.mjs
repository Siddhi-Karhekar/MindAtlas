// Security checks (docs/SECURITY.md lists what each one guards against).
//
// Three parts:
//   1. the building blocks on their own: password rules, sign-up challenge,
//      login throttle, database filter guard, upload content checks;
//   2. the real server in its development setup (port 4593): malformed
//      requests, sessions and cookies, cross-site requests, reaching other
//      students' records, tampering with fields, what answers leave out;
//   3. the real server set up as in production (port 4592), with a stand-in
//      mail server (port 4591): HTTPS only, the sign-up challenge, confirming
//      an email address, resetting a password, the sign-up limit.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import net from "node:net";
import JSZip from "jszip";
import { passwordProblem } from "../src/services/passwordPolicy.js";
import { challengeProblem, issueChallenge, spendChallenge } from "../src/services/signupChallenge.js";
import { beginAttempt, lockedFor, recordSuccess } from "../src/services/loginThrottle.js";
import { assertSafeFilter } from "../src/db/filter.js";
import { createMemoryDb } from "../src/db/memoryStore.js";
import { checkUploadContent, imageSize } from "../src/services/uploadCheck.js";
import { mailStatus } from "../src/services/mailer.js";
import { APP_CSP } from "../src/middleware/securityHeaders.js";
import { blocksFromPlainText, normalizeContent, segmentDocument } from "../src/services/documentStructure.js";
import { studyFor } from "../src/services/keyTerms.js";
import { contentToEditText } from "../src/services/noteView.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOD = "river-Kettle-42x";
const throws = async (fn) => {
  try {
    await fn();
    return "";
  } catch (err) {
    return err.message || "error";
  }
};

// ---------------------------------------------------------------------------
console.log("\n=== Password rules ===");
const weak = (p, email = "siddhi@example.com") => passwordProblem(p, { email });
check("a long, unusual password is accepted", weak(GOOD) === null && weak("correct horse battery") === null && weak("monsoon-chai-27") === null);
check("under 10 characters is refused", /at least 10/.test(weak("Sh0rt!pw")));
check("the usual suspects are refused, however dressed up", ["password123", "Password@123", "P@ssw0rd2024!", "qwertyuiop12", "welcome@1234", "iloveyou2024", "Admin@12345", "mypassword1", "passwordpassword"].every((p) => /commonly used/.test(weak(p))));
check("only digits is refused (a phone number)", /only digits/.test(weak("9823012345")));
check("one or two characters repeated is refused", /too few/.test(weak("aaaaaaaaaaaa")) && /too few/.test(weak("abababababab")));
check("a keyboard-order sequence is refused", /sequence/.test(weak("abcdefghijkl")) && /sequence/.test(weak("12345678ab")));
check("the email name inside the password is refused", /email name/.test(weak("siddhi-2026-xy")));
check("longer than bcrypt reads is refused, not cut short", /too long/.test(weak("x7-".repeat(30))));
check("something that is not text is refused", weak({ length: 20 }) !== null && weak(undefined) !== null);

console.log("\n=== Sign-up challenge ===");
process.env.SIGNUP_CHALLENGE = "on";
const now = Date.now();
const fresh = issueChallenge(now);
check("a challenge sent back after a moment passes", challengeProblem({ challenge: fresh }, now + 5000) === null);
check("sent back at once: too fast for a person", /too fast/.test(challengeProblem({ challenge: fresh }, now + 200)));
check("a stale one is refused", /too long/.test(challengeProblem({ challenge: fresh }, now + 3 * 3600_000)));
check("a missing or made-up one is refused", challengeProblem({}, now) !== null && challengeProblem({ challenge: `${now - 9000}.abc.forged` }, now) !== null);
const tampered = fresh.replace(/^\d+/, String(now - 60_000));
check("changing its time breaks its signature", challengeProblem({ challenge: tampered }, now) !== null);
check("the hidden field filled in means a bot", challengeProblem({ challenge: fresh, website: "http://spam.example" }, now + 5000) !== null);
spendChallenge({ challenge: fresh });
check("a challenge that has made an account cannot make another", challengeProblem({ challenge: fresh }, now + 5000) !== null && challengeProblem({ challenge: issueChallenge(now) }, now + 5000) === null);
process.env.SIGNUP_CHALLENGE = "off";
check("...and is checked even where the challenge is off", challengeProblem({ website: "x" }) !== null && challengeProblem({}) === null);
delete process.env.SIGNUP_CHALLENGE;

console.log("\n=== Wrong-password throttle ===");
for (let i = 0; i < 4; i++) beginAttempt("a@x.io", "1.1.1.1");
check("four wrong passwords: still allowed", lockedFor("a@x.io", "1.1.1.1") === 0);
check("the fifth is still checked", beginAttempt("a@x.io", "1.1.1.1") === 0);
check("...and then that account is locked from that address", lockedFor("a@x.io", "1.1.1.1") > 0 && beginAttempt("a@x.io", "1.1.1.1") > 0);
check("...but not from another address, nor another account", lockedFor("a@x.io", "2.2.2.2") === 0 && lockedFor("b@x.io", "1.1.1.1") === 0);
// a burst arriving together: each is counted as it arrives, so only five get as far as a password check
const burst = Array.from({ length: 25 }, () => beginAttempt("burst@x.io", "3.3.3.3"));
check("25 at once: five are let through, twenty refused", burst.filter((w) => w === 0).length === 5, String(burst.filter((w) => w === 0).length));
for (let i = 0; i < 95; i++) beginAttempt("a@x.io", `9.9.${i >> 4}.${i & 15}`);
check("a hundred from many addresses lock the account everywhere", lockedFor("a@x.io", "7.7.7.7") > 0);
for (let i = 0; i < 3; i++) beginAttempt("c@x.io", "1.1.1.1");
beginAttempt("c@x.io", "1.1.1.1");
recordSuccess("c@x.io", "1.1.1.1");
for (let i = 0; i < 4; i++) beginAttempt("c@x.io", "1.1.1.1");
check("a successful sign-in clears that address's count", lockedFor("c@x.io", "1.1.1.1") === 0);

console.log("\n=== Database filters ===");
check("plain values and lists of them are allowed", !!assertSafeFilter({ _id: "a", ownerId: ["a", "b"], n: 3, at: new Date(), x: { $in: ["a"] }, gone: null }));
check("a value that was never set is refused, not matched against everything", /unsafe/.test(await throws(() => assertSafeFilter({ _id: undefined }))));
check("an operator in a value is refused", /unsafe/.test(await throws(() => assertSafeFilter({ email: { $ne: null } }))));
check("...also inside a list, and as a field name", /unsafe/.test(await throws(() => assertSafeFilter({ _id: [{ $gt: "" }] }))) && /unsafe/.test(await throws(() => assertSafeFilter({ $where: "1" }))));
const db = createMemoryDb({ file: null });
await db.collection("users").insertOne({ email: "real@x.io", passwordHash: "h" });
check("the store refuses it too, for every operation",
  /unsafe/.test(await throws(() => db.collection("users").findOne({ email: { $ne: null } }))) &&
  /unsafe/.test(await throws(() => db.collection("users").find({ email: { $regex: ".*" } }))) &&
  /unsafe/.test(await throws(() => db.collection("users").deleteMany({ email: { $exists: true } }))) &&
  /unsafe/.test(await throws(() => db.collection("users").findOneAndUpdate({ email: { $ne: "" } }, { $set: { passwordHash: "x" } }))));
check("...and the account is untouched", (await db.collection("users").findOne({ email: "real@x.io" })).passwordHash === "h");

console.log("\n=== What an uploaded file really is ===");
const file = (name, buffer) => ({ originalname: name, buffer });
const png = (w, h) => {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
check("a program renamed to .pdf is refused", /not a PDF/.test(await throws(() => checkUploadContent(file("notes.pdf", Buffer.from("MZ\x90\x00 this is an executable")), "pdf"))));
check("text renamed to .png is refused", /not a picture/.test(await throws(() => checkUploadContent(file("photo.png", Buffer.from("<script>alert(1)</script>")), "image"))));
check("a picture renamed to .docx is refused", /not a valid \.docx/.test(await throws(() => checkUploadContent(file("notes.docx", png(10, 10)), "docx"))));
check("binary data named .txt is refused", /does not look like a text file/.test(await throws(() => checkUploadContent(file("a.txt", Buffer.from([1, 2, 0, 3, 0, 0])), "text"))));
check("a real PNG's size is read from its header", JSON.stringify(imageSize(png(800, 600))) === '{"width":800,"height":600}');
check("a picture of 400 megapixels is refused before it is decoded", /too large in pixels/.test(await throws(() => checkUploadContent(file("huge.png", png(20000, 20000)), "image"))));
check("an ordinary one passes", (await throws(() => checkUploadContent(file("ok.png", png(1200, 900)), "image"))) === "");
const webp = Buffer.alloc(40);
webp.write("RIFF", 0, "latin1");
webp.write("WEBP", 8, "latin1");
webp.write("VP8X", 12, "latin1");
webp.writeUIntLE(16382, 24, 3);
webp.writeUIntLE(16382, 27, 3);
check("the limit holds for WebP too", /too large in pixels/.test(await throws(() => checkUploadContent(file("huge.webp", webp), "image"))));
check("a picture whose size cannot be read is refused, not passed to the decoder", /could not read this image/.test(await throws(() => checkUploadContent(file("odd.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 3, 4, 5, 6])), "image"))));
const zipOf = async (parts) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(parts)) zip.file(name, data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
};
const bomb = await zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": Buffer.alloc(61 * 1024 * 1024, 0x20) });
check(`a Word file of ${Math.round(bomb.length / 1024)} KB that unpacks to 61 MB is refused`, /too large to open safely/.test(await throws(() => checkUploadContent(file("bomb.docx", bomb), "docx"))));
// the same file claiming, in its own index, that the part is 1,000 bytes
const lying = Buffer.from(bomb);
let patched = 0;
for (let i = 0; i < lying.length - 4; i++) {
  if (lying.readUInt32LE(i) === 61 * 1024 * 1024) {
    lying.writeUInt32LE(1000, i);
    patched += 1;
  }
}
const rssBefore = process.memoryUsage().rss;
check("...and so is one that lies about its size: the bytes are counted, not the claim", patched === 2 && /too large to open safely|damaged/.test(await throws(() => checkUploadContent(file("liar.docx", lying), "docx"))));
check("...without the memory being spent finding out", process.memoryUsage().rss - rssBefore < 60 * 1024 * 1024, `${Math.round((process.memoryUsage().rss - rssBefore) / 1e6)} MB`);
check("a zip that is not a document is refused", /not a valid \.pptx/.test(await throws(async () => checkUploadContent(file("x.pptx", await zipOf({ "readme.txt": "hi" })), "pptx"))));
check("a real Word file passes", (await throws(() => checkUploadContent(file("notes.docx", fs.readFileSync(new URL("fixtures/notes.docx", import.meta.url))), "docx"))) === "");

console.log("\n=== Text built to be slow to process ===");
// Each of these took 20 to 90 seconds before the patterns involved were made
// to run in time proportional to the text. The limits are loose on purpose:
// they catch a return to minutes, not a slow machine.
const timed = async (fn) => {
  const t = Date.now();
  await fn();
  return Date.now() - t;
};
const spaces = `A lock controls access${" ".repeat(300_000)}to a data item.`;
let ms = await timed(() => studyFor({ _id: "slow1", title: "T", rawText: spaces, content: normalizeContent(blocksFromPlainText(spaces)), keywords: [] }, { corpus: [], embedder: null }));
check("300,000 spaces inside a sentence: study sentences", ms < 5000, `${ms} ms`);
const bold = "**a".repeat(100_000);
ms = await timed(() => contentToEditText(normalizeContent(blocksFromPlainText(bold))));
check("100,000 bold markers: back to editable text", ms < 5000, `${ms} ms`);
const headings = "1.1 Head\n\ntext text text text text text.\n\n".repeat(30_000);
let parts = 0;
ms = await timed(() => {
  parts = segmentDocument(blocksFromPlainText(headings)).sections.length;
});
check("30,000 headings: split into at most 30 parts", ms < 15_000 && parts <= 30, `${ms} ms, ${parts} parts`);

console.log("\n=== Email settings ===");
const savedEnv = { ...process.env };
process.env.NODE_ENV = "production";
process.env.EMAIL_MODE = "log";
delete process.env.SMTP_HOST;
check("printing emails to the log is refused in production", mailStatus().enabled === false);
process.env.NODE_ENV = "development";
check("...and allowed in development", mailStatus().mode === "log");
Object.assign(process.env, savedEnv);
delete process.env.EMAIL_MODE;
if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;

const viteConfig = new URL("../../client/vite.config.js", import.meta.url);
if (fs.existsSync(viteConfig)) {
  const text = fs.readFileSync(viteConfig, "utf8");
  // frame-ancestors only works as a header; connect-src gains the API's address at build time
  const shared = APP_CSP.split("; ").filter((d) => !d.startsWith("frame-ancestors") && !d.startsWith("connect-src"));
  check("the client's built-in policy matches the one the server sends", shared.every((d) => text.includes(`"${d}"`)) && text.includes("connect-src 'self'"), shared.filter((d) => !text.includes(`"${d}"`)).join(" | "));
}

// ---------------------------------------------------------------------------
// A running server
// ---------------------------------------------------------------------------
function startServer(port, env) {
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), MONGODB_URI: "", DB_FILE: "memory", GROQ_API_KEY: "", SEMANTIC_MODEL: "off", CLIENT_DIST: "/nonexistent", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = { text: "" };
  child.stdout.on("data", (d) => (log.text += d));
  child.stderr.on("data", (d) => (log.text += d));
  return { child, log };
}
async function waitUp(api, server) {
  for (let i = 0; i < 300 && server.child.exitCode === null; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) return;
    } catch {
      await wait(200);
    }
  }
  throw new Error(`API did not start\n${server.log.text}`);
}
// one request; returns status, parsed body, raw text and headers
const requester = (api) => async (route, { method = "GET", body, raw, token, cookie, origin, headers = {} } = {}) => {
  const res = await fetch(api + route, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, text, headers: res.headers, setCookie: res.headers.getSetCookie?.() || [], ...json };
};
const cookiePair = (setCookie) => (setCookie[0] || "").split(";")[0];

const DEV = "http://localhost:4593/api";
const dev = startServer(4593, { NODE_ENV: "development", RATE_LIMIT_AUTH_MAX: "100000", TRUST_PROXY: "1", CORS_ORIGIN: "http://localhost:5173,https://app.example", EXTRACT_TIMEOUT_SECONDS: "3" });
const SMTP_PORT = 4591;
const PROD = "http://localhost:4592/api";
let prod = null;
let smtp = null;

try {
  await waitUp(DEV, dev);
  const call = requester(DEV);
  const alive = async () => (await call("/health")).status === 200;
  const signUp = async (name) => {
    const email = `${name}${Date.now()}@example.com`;
    const r = await call("/auth/register", { method: "POST", body: { email, password: GOOD } });
    return { email, token: r.token, cookie: cookiePair(r.setCookie), id: r.user?.id, raw: r };
  };

  console.log("\n=== Requests that used to crash the server ===");
  const a = await signUp("alice");
  let r = await call("/auth/login", { method: "POST", body: { email: a.email, password: { x: 1 } } });
  check("a password sent as an object -> 400", r.status === 400 && (await alive()), `HTTP ${r.status}`);
  r = await call("/auth/register", { method: "POST", body: { email: "arr@example.com", password: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] } });
  check("a password sent as a list -> 400", r.status === 400 && (await alive()), `HTTP ${r.status}`);
  r = await call("/subjects", { method: "POST", token: a.token, body: { name: { toString: 1 } } });
  check("a subject name that is not text -> 400", r.status === 400 && (await alive()));
  const subj = (await call("/subjects", { method: "POST", token: a.token, body: { name: "Networks" } })).subject;
  r = await call(`/subjects/${subj._id}/tests`, { method: "POST", token: a.token, body: { title: { a: 1 }, noteIds: ["x"] } });
  check("a test title that is not text -> 400", r.status === 400 && (await alive()));
  r = await call(`/subjects/${subj._id}/notes`, { method: "POST", token: a.token, body: { title: 7, content: [] } });
  check("a note whose title is a number -> 400", r.status === 400 && (await alive()));
  r = await call("/auth/login", { method: "POST", raw: '{"email":' });
  check("a body that is not JSON -> 400, and no stack trace", r.status === 400 && !/at |SyntaxError|node_modules/.test(r.text), r.text);
  r = await call("/auth/login", { method: "POST", raw: "[1,2,3]" });
  check("a body that is a list, not an object -> 400", r.status === 400);
  r = await call("/auth/login", { method: "POST", raw: JSON.stringify({ email: "x", pad: "y".repeat(2_200_000) }) });
  check("a body over the size limit -> 413", r.status === 413 && !/at /.test(r.text), `HTTP ${r.status}`);
  check("the server is still up after all of that", await alive());

  console.log("\n=== Database operators in a request ===");
  r = await call("/auth/login", { method: "POST", body: { email: { $ne: null }, password: { $ne: null } } });
  check("an operator in the sign-in fields -> 400, nobody signed in", r.status === 400 && !r.token, r.error);
  r = await call("/auth/login", { method: "POST", body: { email: a.email, password: GOOD, extra: { "a.b": 1 } } });
  check("a dotted field name anywhere in the body -> 400", r.status === 400);
  r = await call("/auth/login", { method: "POST", raw: `{"email":"${a.email}","password":"${GOOD}","__proto__":{"admin":true}}` });
  check("a __proto__ field -> 400", r.status === 400);
  r = await call(`/subjects/${subj._id}/export?format=pdf&format=docx`, { token: a.token });
  check("a query parameter given twice -> 400", r.status === 400);
  r = await call(`/subjects/${subj._id}/export?format[$ne]=x`, { token: a.token });
  check("an operator in a query parameter -> 400", r.status === 400);
  r = await call("/subjects/not-an-id/notes", { token: a.token });
  check("something that is not an id in an id position -> 404", r.status === 404);
  r = await call(`/subjects/${subj._id}/tests`, { method: "POST", token: a.token, body: { title: "T", noteIds: [{ $gt: "" }] } });
  check("an operator in a list of ids -> 400", r.status === 400);

  console.log("\n=== Response headers ===");
  r = await call("/health");
  const h = (name) => r.headers.get(name) || "";
  check("no script, frame or form allowed by an API answer", h("content-security-policy").includes("default-src 'none'") && h("content-security-policy").includes("frame-ancestors 'none'"));
  check("no type sniffing, no framing, no referrer", h("x-content-type-options") === "nosniff" && h("x-frame-options") === "DENY" && h("referrer-policy") === "no-referrer");
  check("device features are switched off", /camera=\(\)/.test(h("permissions-policy")) && /geolocation=\(\)/.test(h("permissions-policy")));
  check("isolated from other sites' pages", h("cross-origin-opener-policy") === "same-origin" && h("cross-origin-resource-policy") === "same-origin");
  check("answers are not cached", h("cache-control") === "no-store");
  check("the server does not say what it runs on", !r.headers.has("x-powered-by"));
  check("no HSTS over plain http", !r.headers.has("strict-transport-security"));
  r = await call("/health", { headers: { "X-Forwarded-Proto": "https" } });
  check("HSTS for a year over https", /max-age=31536000/.test(r.headers.get("strict-transport-security") || ""));
  check("the health page gives away no file path", !/[\\/](home|Users|data|server)[\\/]/.test(r.text) && r.email?.enabled === false, r.text);

  console.log("\n=== Sessions ===");
  const set = a.raw.setCookie[0] || "";
  check("signing up sets a session cookie scripts cannot read", /^ma_session=[\w-]+\.[\w-]+\.[\w-]+;/.test(set) && /; HttpOnly/.test(set), set.slice(0, 40));
  check("  ...for this site only, for a week", /; SameSite=Lax/.test(set) && /; Path=\//.test(set) && /Max-Age=604800/.test(set));
  r = await call("/auth/me", { cookie: a.cookie });
  check("the cookie alone signs the student in", r.status === 200 && r.user.email === a.email);
  check("the account is described without its password hash", !/passwordHash|\$2[aby]\$/.test(JSON.stringify(a.raw)) && !/passwordHash/.test(r.text));
  r = await call("/auth/login", { method: "POST", body: { email: a.email, password: GOOD }, origin: "https://app.example", headers: { "X-Forwarded-Proto": "https" } });
  const cross = r.setCookie[0] || "";
  check("over https the cookie is Secure and cannot be planted by another site (__Host-)", cross.startsWith('__Host-ma_session=') && /; Secure/.test(cross), cross.replace(/=[^;]+/, "=...").slice(0, 120));
  check("  ...and to a client on another address it is SameSite=None; Partitioned", /SameSite=None/.test(cross) && /Partitioned/.test(cross));
  const second = await call("/auth/login", { method: "POST", body: { email: a.email, password: GOOD } });
  const secondCookie = cookiePair(second.setCookie);
  r = await call("/auth/logout", { method: "POST", cookie: secondCookie, origin: "http://localhost:5173" });
  check("signing out clears the cookie", r.status === 200 && /^ma_session=;/.test(r.setCookie[0] || "") && /Max-Age=0/.test(r.setCookie[0] || ""));
  check("...and retires the session itself: a copy of its token is refused", (await call("/auth/me", { token: second.token })).status === 401 && (await call("/auth/me", { cookie: secondCookie })).status === 401);
  check("...without touching the student's other sessions", (await call("/auth/me", { token: a.token })).status === 200);
  r = await call("/subjects", { token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0." });
  check("a token signed with 'none' is refused", r.status === 401);
  r = await call("/subjects", { token: `${a.token.slice(0, -3)}abc` });
  check("a token with a changed signature is refused", r.status === 401);
  r = await call("/subjects");
  check("nothing without signing in", r.status === 401);

  console.log("\n=== Requests made by another website ===");
  r = await call("/subjects", { method: "POST", cookie: a.cookie, origin: "https://evil.example", body: { name: "Planted" } });
  check("another site using the student's cookie -> 403", r.status === 403, `HTTP ${r.status}`);
  r = await call("/subjects", { method: "POST", cookie: a.cookie, body: { name: "Planted" } });
  check("the cookie with no Origin at all -> 403", r.status === 403);
  r = await call("/subjects", { method: "POST", cookie: a.cookie, origin: "http://localhost:5173", body: { name: "Mine" } });
  check("the web client's own address -> allowed", r.status === 201);
  r = await call("/auth/login", { method: "POST", origin: "https://evil.example", body: { email: a.email, password: GOOD } });
  check("another site cannot sign a visitor in either", r.status === 403);
  r = await call("/subjects", { cookie: a.cookie });
  check("nothing was planted", r.subjects.every((s) => s.name !== "Planted") && r.subjects.some((s) => s.name === "Mine"));
  r = await call("/subjects", { cookie: a.cookie, origin: "https://evil.example" });
  check("another site is not allowed to read answers (CORS)", !r.headers.has("access-control-allow-origin"));
  r = await call("/subjects", { cookie: a.cookie, origin: "http://localhost:5173" });
  check("the web client is, by name - never '*'", r.headers.get("access-control-allow-origin") === "http://localhost:5173" && r.headers.get("access-control-allow-credentials") === "true");

  console.log("\n=== Wrong passwords ===");
  const victim = await signUp("victim");
  let last;
  for (let i = 0; i < 5; i++) last = await call("/auth/login", { method: "POST", body: { email: victim.email, password: `wrong-guess-${i}-zz` } });
  check("five wrong passwords are each just 'invalid'", last.status === 401);
  r = await call("/auth/login", { method: "POST", body: { email: victim.email, password: GOOD } });
  check("then the account is locked from that address, even for the right one", r.status === 429 && Number(r.headers.get("retry-after")) > 0, `HTTP ${r.status} ${r.error}`);
  r = await call("/auth/login", { method: "POST", body: { email: a.email, password: GOOD } });
  check("other accounts sign in as usual", r.status === 200);
  const unknown = await call("/auth/login", { method: "POST", body: { email: "nobody-here@example.com", password: "whatever-it-is-99" } });
  const wrongPw = await call("/auth/login", { method: "POST", body: { email: a.email, password: "whatever-it-is-99" } });
  check("an unknown address and a wrong password get the same answer", unknown.status === 401 && unknown.error === wrongPw.error);

  console.log("\n=== Password rules at the API ===");
  r = await call("/auth/register", { method: "POST", body: { email: "weak1@example.com", password: "Password@123" } });
  check("sign-up with a common password -> 400 saying why", r.status === 400 && /commonly used/.test(r.error), r.error);
  r = await call("/auth/register", { method: "POST", body: { email: "weak2@example.com", password: "short1!" } });
  check("sign-up with a short one -> 400", r.status === 400 && /at least 10/.test(r.error));
  r = await call("/auth/password", { method: "POST", token: a.token, body: { currentPassword: GOOD, newPassword: "qwertyuiop1" } });
  check("changing to a weak one -> 400, password unchanged", r.status === 400 && (await call("/auth/login", { method: "POST", body: { email: a.email, password: GOOD } })).status === 200);
  r = await call("/auth/register", { method: "POST", body: { email: "not-an-email", password: GOOD } });
  check("an address that is not one -> 400", r.status === 400);

  console.log("\n=== Other students' records ===");
  const b = await signUp("bob");
  const note = (await call(`/subjects/${subj._id}/notes`, { method: "POST", token: a.token, body: { title: "Framing", content: "A frame is the unit the data link layer sends. Byte stuffing adds an escape byte before a flag byte inside the data. Bit stuffing inserts a zero after five consecutive ones in the data." } })).note;
  const note2 = (await call(`/subjects/${subj._id}/notes`, { method: "POST", token: a.token, body: { title: "Flow control", content: "Stop-and-wait flow control makes the sender wait for an acknowledgement after every frame. Sliding window flow control lets the sender transmit several frames before an acknowledgement arrives." } })).note;
  const test = (await call(`/subjects/${subj._id}/tests`, { method: "POST", token: a.token, body: { title: "Quiz", noteIds: [note._id, note2._id], mcqCount: 2, theoryCount: 1 } })).test;
  const started = await call(`/tests/${test._id}/attempts`, { method: "POST", token: a.token });
  const attemptId = started.attempt._id;
  const graph = await call(`/subjects/${subj._id}/graph`, { token: a.token });
  const edgeId = graph.edges?.[0]?.id || graph.edges?.[0]?._id || "a".repeat(24);
  const asBob = (route, opts = {}) => call(route, { token: b.token, ...opts });
  const attempts = [
    ["read the subject's notes", await asBob(`/subjects/${subj._id}/notes`)],
    ["add a note to it", await asBob(`/subjects/${subj._id}/notes`, { method: "POST", body: { title: "x", content: "y y y" } })],
    ["read its graph", await asBob(`/subjects/${subj._id}/graph`)],
    ["read its progress", await asBob(`/subjects/${subj._id}/progress`)],
    ["download it", await asBob(`/subjects/${subj._id}/export?format=pdf`)],
    ["list its tests", await asBob(`/subjects/${subj._id}/tests`)],
    ["build a test from its notes", await asBob(`/subjects/${subj._id}/tests`, { method: "POST", body: { title: "T", noteIds: [note._id] } })],
    ["read a note", await asBob(`/notes/${note._id}`)],
    ["edit a note", await asBob(`/notes/${note._id}`, { method: "PATCH", body: { title: "Taken over" } })],
    ["delete a note", await asBob(`/notes/${note._id}`, { method: "DELETE" })],
    ["download a note", await asBob(`/notes/${note._id}/export?format=docx`)],
    ["read a note's keyword map", await asBob(`/graph/notes/${note._id}/keyword-map`)],
    ["change a link", await asBob(`/graph/edges/${edgeId}/correct`, { method: "POST", body: { action: "remove" } })],
    ["read a test", await asBob(`/tests/${test._id}`)],
    ["start an attempt on a test", await asBob(`/tests/${test._id}/attempts`, { method: "POST" })],
    ["answer in an attempt", await asBob(`/attempts/${attemptId}/responses`, { method: "POST", body: { questionId: started.question._id, answer: "x" } })],
    ["submit an attempt", await asBob(`/attempts/${attemptId}/submit`, { method: "POST" })],
    ["read an attempt's feedback", await asBob(`/attempts/${attemptId}/feedback`)],
  ];
  for (const [what, res] of attempts) check(`another student cannot ${what}`, res.status === 404, `HTTP ${res.status}`);
  r = await call(`/subjects/${subj._id}/tests`, { method: "POST", token: b.token, body: { title: "T", noteIds: [note._id] } });
  const bobSubject = (await asBob("/subjects", { method: "POST", body: { name: "Bob's" } })).subject;
  r = await asBob(`/subjects/${bobSubject._id}/tests`, { method: "POST", body: { title: "Sneaky", noteIds: [note._id] } });
  check("...nor build a test in his own subject from her notes", r.status === 400, `HTTP ${r.status}`);
  r = await call(`/notes/${note._id}`, { token: a.token });
  check("her note is exactly as it was", r.note.title === "Framing");

  console.log("\n=== Fields a client must not set ===");
  r = await call("/auth/register", { method: "POST", body: { email: `tamper${Date.now()}@example.com`, password: GOOD, emailVerified: true, role: "admin", _id: "f".repeat(24), passwordHash: "x", createdAt: "2000-01-01" } });
  check("extra fields at sign-up are ignored", r.status === 201 && r.user.id !== "f".repeat(24) && !("role" in r.user) && new Date(r.user.createdAt).getFullYear() > 2020, JSON.stringify(r.user));
  r = await asBob("/subjects", { method: "POST", body: { name: "Mine really", ownerId: a.id, _id: subj._id } });
  check("a subject cannot be created under someone else's name or id", r.status === 201 && r.subject._id !== subj._id && (await call("/subjects", { token: a.token })).subjects.every((s) => s.name !== "Mine really"));
  r = await call(`/notes/${note._id}`, { method: "PATCH", token: a.token, body: { title: "Framing", ownerId: b.id, subjectId: bobSubject._id, parentNoteId: note2._id } });
  check("a note cannot be moved to another owner or subject by editing it", r.status === 200 && (await asBob(`/subjects/${bobSubject._id}/notes`)).notes.length === 0 && (await call(`/notes/${note._id}`, { token: a.token })).note.subjectId === subj._id);
  r = await call(`/subjects/${subj._id}/tests`, { method: "POST", token: a.token, body: { title: "Big", noteIds: [note._id], mcqCount: 2, theoryCount: 0, targetQuestionCount: 999, ownerId: b.id, marksPerQuestion: 5 } });
  check("a test's stored fields come from the checked ones only", r.status === 201 && r.test.targetQuestionCount === 2 && r.test.marksPerQuestion === 5 && (await asBob(`/tests/${r.test._id}`)).status === 404);
  // answer the first question wrongly while claiming it was right
  const q = started.question;
  const wrong = q.type === "mcq" ? "certainly not one of the options" : "no idea";
  r = await call(`/attempts/${attemptId}/responses`, { method: "POST", token: a.token, body: { questionId: q._id, answer: wrong, isCorrect: true, score: 1, timeMs: 1000 } });
  check("an answer cannot carry its own mark", r.status === 200 && !("isCorrect" in r.response) && !("score" in r.response));
  let next = r.nextQuestion;
  while (next) next = (await call(`/attempts/${attemptId}/responses`, { method: "POST", token: a.token, body: { questionId: next._id, answer: "no idea", score: 1 } })).nextQuestion;
  const fb = (await call(`/attempts/${attemptId}/submit`, { method: "POST", token: a.token })).feedback;
  check("...the wrong answers are marked wrong", fb.marksAwarded === 0, `${fb.marksAwarded} of ${fb.marksPossible}`);
  r = await call(`/attempts/${attemptId}/responses`, { method: "POST", token: a.token, body: { questionId: q._id, answer: "x".repeat(7000) } });
  check("an over-long answer or a bad time is refused or ignored, not stored", r.status === 400 || r.status === 409);

  console.log("\n=== What answers leave out ===");
  const tour = [
    await call("/auth/me", { token: a.token }),
    await call("/subjects", { token: a.token }),
    await call(`/subjects/${subj._id}/notes`, { token: a.token }),
    await call(`/notes/${note._id}`, { token: a.token }),
    await call(`/subjects/${subj._id}/graph`, { token: a.token }),
    await call(`/subjects/${subj._id}/tests`, { token: a.token }),
    await call(`/subjects/${subj._id}/progress`, { token: a.token }),
    await call(`/attempts/${attemptId}/feedback`, { token: a.token }),
  ];
  check("no password hash, owner id or internal vector in any answer", tour.every((t) => t.status === 200 && !/"passwordHash"|"ownerId"|"vector"/.test(t.text)), tour.map((t) => t.status).join(","));
  r = await call(`/tests/${test._id}`, { token: a.token });
  check("a test's questions come without their answers", r.status === 200 && r.questions.length > 0 && !/"answerKey"|"supportingExcerpt"|"keyPoints"/.test(r.text));
  r = await call(`/tests/${test._id}?keys=1`, { token: a.token });
  check("...and asking for them does nothing on a server not set up for it", !/"answerKey"/.test(r.text));
  check("a question in an attempt has no answer either", !/answerKey|supportingExcerpt|keyPoints/.test(JSON.stringify(started.question)));

  console.log("\n=== Size and range limits ===");
  const post = (route, body) => call(route, { method: "POST", token: a.token, body });
  check("a 300-character subject name", (await post("/subjects", { name: "n".repeat(300) })).status === 400);
  check("a 500-character note title", (await post(`/subjects/${subj._id}/notes`, { title: "t".repeat(500), content: "some words here" })).status === 400);
  check("a note of 500,000 characters", (await post(`/subjects/${subj._id}/notes`, { title: "Big", content: "word ".repeat(100_000) })).status === 400);
  check("201 note ids in one test", (await post(`/subjects/${subj._id}/tests`, { title: "T", noteIds: Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(24, "0")) })).status === 400);
  check("a question count that is not a number", (await post(`/subjects/${subj._id}/tests`, { title: "T", noteIds: [note._id], mcqCount: "lots" })).status === 400);
  check("a question count out of range", (await post(`/subjects/${subj._id}/tests`, { title: "T", noteIds: [note._id], mcqCount: 500 })).status === 400);
  check("a duration that is an object", (await post(`/subjects/${subj._id}/tests`, { title: "T", noteIds: [note._id], durationMinutes: { $gt: 0 } })).status === 400);
  check("a 300-character email", (await call("/auth/login", { method: "POST", body: { email: `${"e".repeat(300)}@example.com`, password: GOOD } })).status === 400);

  console.log("\n=== Uploads through the API ===");
  const upload = async (parts, token = a.token) => {
    const form = new FormData();
    for (const [field, value, name] of parts) {
      if (name) form.append(field, new Blob([value]), name);
      else form.append(field, value);
    }
    const res = await fetch(`${DEV}/subjects/${subj._id}/notes`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  r = await upload([["file", Buffer.from("MZ\x90\x00\x03 not a pdf"), "notes.pdf"]]);
  check("a program named .pdf -> 400", r.status === 400 && /not a PDF/.test(r.error), r.error);
  r = await upload([["file", Buffer.from("just some text pretending"), "photo.png"]]);
  check("text named .png -> 400", r.status === 400 && /not a picture/.test(r.error), r.error);
  r = await upload([["file", png(20000, 20000), "huge.png"]]);
  check("a 400-megapixel picture -> 400", r.status === 400 && /too large in pixels/.test(r.error), r.error);
  r = await upload([["file", Buffer.from("first file text here"), "a.txt"], ["file", Buffer.from("second"), "b.txt"]]);
  check("two files in one upload -> 400", r.status === 400, `HTTP ${r.status} ${r.error}`);
  r = await upload([["file", Buffer.from("some text for a note"), "a.txt"], ["title", "t".repeat(20_000)]]);
  check("an oversized form field -> 400", r.status === 400, `HTTP ${r.status}`);
  r = await upload([["file", Buffer.from("A sliding window lets the sender transmit several frames before an acknowledgement."), "../../etc/passwd.txt"]]);
  check("a file name with a path in it is only ever a title", r.status === 201 && !/[\\/]/.test(r.note.title), r.note?.title);
  check("the server is still up", await alive());

  console.log("\n=== A file built to keep the server busy ===");
  // a slide whose markup makes the slide reader's pattern matching take minutes
  const slowDeck = await zipOf({
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": "<p:presentation/>",
    "ppt/slides/slide1.xml": "<p:sp ".repeat(400_000),
  });
  const began = Date.now();
  const pending = upload([["file", slowDeck, "slow.pptx"]]);
  await wait(800); // the reader is now busy with it
  const pings = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await call("/subjects", { token: a.token });
    pings.push(Date.now() - t);
    await wait(150);
  }
  check("while it is being read, other requests are answered at once", Math.max(...pings) < 1000, `${pings.join(", ")} ms`);
  r = await pending;
  check(`the upload is stopped at the time limit and refused (${((Date.now() - began) / 1000).toFixed(1)} s)`, r.status === 400 && /took too long/.test(r.error) && Date.now() - began < 12_000, `HTTP ${r.status} ${r.error}`);
  r = await upload([["file", Buffer.from(`a${" ".repeat(300_000)}a. A sliding window lets the sender transmit several frames before an acknowledgement arrives.`), "padded.txt"]]);
  check("a text file padded with 300,000 spaces is read in a moment", r.status === 201, `HTTP ${r.status} ${r.error || ""}`);
  check("the server is still up", await alive());

  console.log("\n=== A deleted account's session ===");
  const gone = await signUp("gone");
  await call("/auth/me", { method: "DELETE", token: gone.token, body: { password: GOOD } });
  check("stops working at once", (await call("/auth/me", { token: gone.token })).status === 401 && (await call("/subjects", { cookie: gone.cookie })).status === 401);

  // -------------------------------------------------------------------------
  // The production setup, with email
  // -------------------------------------------------------------------------
  const mails = [];
  smtp = net.createServer((socket) => {
    let data = "";
    let inData = false;
    socket.write("220 test smtp\r\n");
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (inData) {
        if (data.endsWith("\r\n.\r\n")) {
          // quoted-printable: soft line breaks and =XX escapes
          mails.push(data.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
          data = "";
          inData = false;
          socket.write("250 queued\r\n");
        }
        return;
      }
      for (const line of data.split("\r\n").slice(0, -1)) {
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250-test\r\n250 OK\r\n");
        else if (cmd === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
      data = inData ? "" : data.slice(data.lastIndexOf("\r\n") + 2);
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => smtp.listen(SMTP_PORT, "127.0.0.1", resolve));
  const linkTo = (address, page) => {
    const mail = [...mails].reverse().find((m) => m.includes(`To: ${address}`) && m.includes(`/${page}#token=`));
    return mail?.match(new RegExp(`${page}#token=([\\w-]+)`))?.[1] || null;
  };
  const mailFor = async (address, page, count) => {
    for (let i = 0; i < 50 && mails.filter((m) => m.includes(`To: ${address}`)).length < count; i++) await wait(100);
    return linkTo(address, page);
  };

  prod = startServer(4592, {
    NODE_ENV: "production",
    JWT_SECRET: "test-secret-that-is-long-enough-for-production-use-0123456789",
    TRUST_PROXY: "1",
    CORS_ORIGIN: "https://app.example",
    APP_URL: "https://app.example",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(SMTP_PORT),
    SMTP_ALLOW_PLAIN: "1",
    MAIL_FROM: "Mind Atlas <no-reply@app.example>",
    SIGNUP_MIN_SECONDS: "1",
    RATE_LIMIT_REGISTER_MAX: "4",
    TEST_REVEAL_KEYS: "1",
  });
  await waitUp(PROD, prod);
  const https = { "X-Forwarded-Proto": "https" };
  const pcall = (route, opts = {}) => requester(PROD)(route, { origin: "https://app.example", ...opts, headers: { ...https, ...opts.headers } });

  console.log("\n=== Production: HTTPS only ===");
  r = await requester(PROD)("/health", { headers: { "X-Forwarded-Proto": "http" } });
  check("a page asked for over http is sent to https", r.status === 308 && /^https:\/\//.test(r.headers.get("location") || ""), `HTTP ${r.status} ${r.headers.get("location")}`);
  r = await requester(PROD)("/auth/login", { method: "POST", body: { email: "x@example.com", password: "y" }, headers: { "X-Forwarded-Proto": "http" } });
  check("a password posted over http is refused, not redirected", r.status === 403);
  r = await pcall("/health");
  check("the health page says little: no file path, no reasons", r.status === 200 && r.email.enabled === true && !("reason" in r.semantic) && !("file" in r.db), r.text);

  console.log("\n=== Production: signing up ===");
  const config = await pcall("/auth/config");
  check("the sign-up form is given a challenge, and told email is on", config.signup.challengeRequired === true && typeof config.signup.challenge === "string" && config.email.enabled === true);
  const carol = `carol${Date.now()}@example.com`;
  r = await pcall("/auth/register", { method: "POST", body: { email: carol, password: GOOD } });
  check("a sign-up without the challenge -> 400", r.status === 400, r.error);
  r = await pcall("/auth/register", { method: "POST", body: { email: carol, password: GOOD, challenge: config.signup.challenge } });
  check("one sent the instant the form opened -> 400, too fast", r.status === 400 && /too fast/.test(r.error), r.error);
  await wait(1200);
  r = await pcall("/auth/register", { method: "POST", body: { email: carol, password: GOOD, challenge: config.signup.challenge, website: "http://spam.example" } });
  check("one with the hidden field filled in -> 400", r.status === 400);
  r = await pcall("/auth/register", { method: "POST", body: { email: carol, password: GOOD, challenge: config.signup.challenge, website: "" } });
  check("a person's sign-up is accepted", r.status === 201 && r.emailVerificationRequired === true && r.verificationSent === true, `HTTP ${r.status} ${r.error || ""}`);
  const carolToken = r.token;

  console.log("\n=== Production: confirming the email address ===");
  const verifyToken = await mailFor(carol, "verify-email", 1);
  check("a confirmation link is emailed, pointing at the web app", Boolean(verifyToken) && mails.some((m) => m.includes("https://app.example/verify-email#token=")), `${mails.length} mail(s)`);
  r = await pcall("/subjects", { token: carolToken });
  check("until it is opened, the account can do nothing", r.status === 403 && r.code === "email_unverified", `HTTP ${r.status}`);
  r = await pcall("/auth/me", { token: carolToken });
  check("...except see who it is and that it must confirm", r.status === 200 && r.emailVerificationRequired === true && r.user.emailVerified === false);
  r = await pcall("/auth/resend-verification", { method: "POST", token: carolToken });
  check("asking for the link again straight away -> 429", r.status === 429, `HTTP ${r.status}`);
  r = await pcall("/auth/verify-email", { method: "POST", body: { token: "A".repeat(43) } });
  check("a made-up link -> 400", r.status === 400);
  r = await pcall("/auth/verify-email", { method: "POST", body: { token: verifyToken } });
  check("the real link confirms the address", r.status === 200);
  check("...and then the account works", (await pcall("/subjects", { token: carolToken })).status === 200);
  r = await pcall("/auth/verify-email", { method: "POST", body: { token: verifyToken } });
  check("the link works once", r.status === 400);

  console.log("\n=== Production: resetting a forgotten password ===");
  const before = mails.length;
  r = await pcall("/auth/forgot", { method: "POST", body: { email: "nobody-at-all@example.com" } });
  const known = await pcall("/auth/forgot", { method: "POST", body: { email: carol } });
  check("the answer is the same for an unknown address as for a real one", r.status === 200 && known.status === 200 && r.text === known.text);
  const resetToken = await mailFor(carol, "reset-password", 2);
  check("only the real account is sent a link", Boolean(resetToken) && mails.length === before + 1, `${mails.length - before} new mail(s)`);
  r = await pcall("/auth/reset", { method: "POST", body: { token: resetToken, password: "Password@123" } });
  check("a weak new password -> 400", r.status === 400 && /commonly used/.test(r.error));
  r = await pcall("/auth/reset", { method: "POST", body: { token: resetToken, password: "lantern-Quilt-77" } });
  check("...without using the link up: a good one is then accepted", r.status === 200 && typeof r.token === "string", `HTTP ${r.status} ${r.error || ""}`);
  check("the old password no longer signs in; the new one does",
    (await pcall("/auth/login", { method: "POST", body: { email: carol, password: GOOD } })).status === 401 &&
    (await pcall("/auth/login", { method: "POST", body: { email: carol, password: "lantern-Quilt-77" } })).status === 200);
  check("every session from before the reset is over", (await pcall("/subjects", { token: carolToken })).status === 401);
  r = await pcall("/auth/reset", { method: "POST", body: { token: resetToken, password: "another-Good-one-55" } });
  check("the reset link works once", r.status === 400);
  check("no email carries the password or its hash", mails.every((m) => !m.includes(GOOD) && !/\$2[aby]\$/.test(m)));

  console.log("\n=== Production: limits and switches ===");
  let limited = null;
  for (let i = 0; i < 4 && !limited; i++) {
    const res = await pcall("/auth/register", { method: "POST", body: { email: `flood${i}${Date.now()}@example.com`, password: GOOD, challenge: config.signup.challenge } });
    if (res.status === 429) limited = res;
  }
  check("sign-ups from one address are capped", limited?.status === 429 && /too many new accounts/.test(limited.error), `HTTP ${limited?.status}`);
  r = await pcall("/auth/login", { method: "POST", body: { email: carol, password: "lantern-Quilt-77" } });
  const t = r.token;
  const s = (await pcall("/subjects", { method: "POST", token: t, body: { name: "Chem" } })).subject;
  const n = (await pcall(`/subjects/${s._id}/notes`, { method: "POST", token: t, body: { title: "Atoms", content: "An atom has a nucleus of protons and neutrons, surrounded by electrons in shells around it. Isotopes of an element differ in their number of neutrons." } })).note;
  const tt = (await pcall(`/subjects/${s._id}/tests`, { method: "POST", token: t, body: { title: "Q", noteIds: [n._id], mcqCount: 1 } })).test;
  r = await pcall(`/tests/${tt._id}?keys=1`, { token: t });
  check("the development switch for answer keys does nothing in production", r.status === 200 && !/"answerKey"/.test(r.text));
  r = await requester(PROD)("/subjects", { method: "POST", token: t, origin: "http://localhost:5173", body: { name: "x" }, headers: https });
  check("the local dev address is not an allowed origin in production", r.status === 403);
} catch (err) {
  console.log(`  FAIL  ${err.stack || err.message}`);
  failures++;
} finally {
  dev.child.kill();
  prod?.child.kill();
  smtp?.close();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
