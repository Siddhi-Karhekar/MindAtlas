// Pictures on theory answers, through the real server (in-memory database)
// with a stand-in for the AI service:
//   A. attaching: upload, list (kept across a refresh), remove, replace
//   B. validation and security: types, size, count, whose attempt, which question
//   C. submitting: an answer of pictures only, pictures locked once saved
//   D. marking: read cleanly (vision), read in part, not read at all, no AI (OCR)
//   E. the review: pictures, what was read, flagged for review; re-marking
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A real PNG of the given size (white), built by hand so the test needs no image library.
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 255)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- the stand-in AI service
let vision = "clear"; // clear | partial | unreadable | down
const visionBodies = [];
const markingBodies = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const reply = (content) => json(200, { choices: [{ message: { content } }] });
    if (body.includes('"image_url"')) {
      visionBodies.push(body);
      if (vision === "down") return json(503, { error: { type: "server_error" } });
      // the stand-in "reads" a page about what the question asks, so the
      // marking has something on topic to mark
      const asked = (JSON.parse(body).messages.at(-1).content.find((p) => p.type === "text")?.text || "").replace(/<\/?question>/g, " ");
      const transcript =
        vision === "unreadable" ? "" : `${asked.replace(/Transcribe.*$/s, "").trim()} ${String(NOTES).replace(/\s+/g, " ").slice(0, 4000)} A loader places the executable program into $main\\ memory$. [diagram: memory with the loader at the bottom]`;
      return reply(JSON.stringify({ transcript, legibility: vision, unreadable_parts: vision === "partial" ? "the last line" : "" }));
    }
    if (body.includes("student_answer")) {
      markingBodies.push(body);
      return reply(JSON.stringify({ score: 0.8, keyPoints: [true, true, false, false, false, false].slice(0, 6), note: "Covers the main idea." }));
    }
    return reply("[]"); // question writing: the rules write the test
  });
});
await new Promise((r) => fake.listen(4598, r));

const NOTES = fs.readFileSync(fileURLToPath(new URL("./fixtures/subjects/spos_linker_loader.txt", import.meta.url)));
async function startServer(port, env) {
  const API = `http://localhost:${port}/api`;
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), MONGODB_URI: "", DB_FILE: "memory", NODE_ENV: "development", ANSWER_IMAGE_MAX_MB: "1", ...env },
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) break;
    } catch {
      await wait(200);
    }
  }
  return { API, child };
}
function client(API) {
  let cookie = "";
  return async (path, { method = "GET", body, form, raw = false } = {}) => {
    const headers = { Cookie: cookie, Origin: "http://localhost:5173", ...(form || !body ? {} : { "Content-Type": "application/json" }) };
    const res = await fetch(API + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    if (raw) return res;
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const imageForm = (buf, name = "page.png", type = "image/png") => {
  const f = new FormData();
  f.append("image", new Blob([buf], { type }), name);
  return f;
};

// a student with a theory-only test on the SPOS notes, and an attempt on its first question
async function setUp(call, { mcq = 0, theory = 3 } = {}) {
  await call("/auth/register", { method: "POST", body: { email: `img${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`, password: "river-Kettle-42x" } });
  const { subject } = await call("/subjects", { method: "POST", body: { name: "SPOS" } });
  const form = new FormData();
  form.append("file", new Blob([NOTES]), "spos.txt");
  const up = await call(`/subjects/${subject._id}/notes`, { method: "POST", form });
  const built = await call(`/subjects/${subject._id}/tests`, { method: "POST", body: { title: "Images", noteIds: [up.note._id], mcqCount: mcq, theoryCount: theory } });
  const started = await call(`/tests/${built.test._id}/attempts`, { method: "POST" });
  return { subject, test: built.test, attempt: started.attempt, question: started.question };
}

const servers = [];
try {
  const { API, child } = await startServer(4599, { GROQ_API_KEY: "test-key", LLM_API_URL: "http://localhost:4598/v1/chat/completions", LLM_TIMEOUT_MS: "3000" });
  servers.push(child);
  const call = client(API);
  const other = client(API);

  console.log("\n=== A. Attaching pictures ===");
  const { subject, attempt, question } = await setUp(call);
  check("the attempt opens on a theory question", question?.type === "theory", question?.type);
  const qPath = `/attempts/${attempt._id}/questions/${question._id}/images`;
  const page = png(320, 240);
  const one = await call(qPath, { method: "POST", form: imageForm(page) });
  check("a picture is attached to the answer", one.status === 201 && one.image?._id && one.image.width === 320 && one.image.status === "draft", JSON.stringify(one).slice(0, 160));
  const listed = await call(qPath);
  check("it is still there when the page is opened again (a refresh)", listed.images?.length === 1 && listed.images[0]._id === one.image._id && listed.max === 3);
  const bytes = await call(`/answer-images/${one.image._id}`, { raw: true });
  const got = Buffer.from(await bytes.arrayBuffer());
  check("the picture can be fetched back by its owner, byte for byte", bytes.status === 200 && got.equals(page) && bytes.headers.get("content-type") === "image/png");
  check("  ...as a picture that cannot run anything (nosniff, sandboxed, private)", bytes.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(bytes.headers.get("content-security-policy") || "") && /private/.test(bytes.headers.get("cache-control") || ""));
  const removed = await call(`/attempts/${attempt._id}/images/${one.image._id}`, { method: "DELETE" });
  check("a picture can be removed before the answer is sent", removed.status === 200 && (await call(qPath)).images.length === 0);
  const a1 = await call(qPath, { method: "POST", form: imageForm(png(400, 300)) });
  const a2 = await call(qPath, { method: "POST", form: imageForm(png(300, 400), "two.png") });
  const a3 = await call(qPath, { method: "POST", form: imageForm(png(200, 200), "three.png") });
  check("several pictures per answer (up to three)", [a1, a2, a3].every((x) => x.status === 201) && a3.count === 3);

  console.log("\n=== B. Validation and security ===");
  const fourth = await call(qPath, { method: "POST", form: imageForm(png(100, 100), "four.png") });
  check("a fourth picture is refused, saying how many are allowed", fourth.status === 409 && fourth.code === "too_many_images" && /at most 3/.test(fourth.error));
  await call(`/attempts/${attempt._id}/images/${a3.image._id}`, { method: "DELETE" });
  const fake1 = await call(qPath, { method: "POST", form: imageForm(Buffer.from("this is not a picture at all"), "notes.png") });
  check("a file that only claims to be a picture is refused", fake1.status === 400 && fake1.code === "unsupported_type", fake1.error);
  const gif = await call(qPath, { method: "POST", form: imageForm(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]), "a.gif", "image/gif") });
  check("a GIF is refused with the types that work", gif.status === 400 && /JPG, PNG or WebP/.test(gif.error));
  const big = await call(qPath, { method: "POST", form: imageForm(Buffer.concat([page, Buffer.alloc(1.5 * 1024 * 1024)]), "big.png") });
  check("a picture over the size limit is refused with the limit", big.status === 413 && /1 MB/.test(big.error), `${big.status} ${big.error}`);
  const broken = await call(qPath, { method: "POST", form: imageForm(page.subarray(0, 20), "cut.png") });
  check("a damaged picture is refused", broken.status === 400, `${broken.status} ${broken.error}`);
  await other("/auth/register", { method: "POST", body: { email: `other${Date.now()}@example.com`, password: "river-Kettle-42x" } });
  check("another student cannot see the picture", (await other(`/answer-images/${a1.image._id}`)).status === 404);
  check("  ...nor add one to this attempt", (await other(qPath, { method: "POST", form: imageForm(png(50, 50)) })).status === 404);
  check("  ...nor list or remove them", (await other(qPath)).status === 404 && (await other(`/attempts/${attempt._id}/images/${a1.image._id}`, { method: "DELETE" })).status === 404);
  const notCurrent = await call(`/attempts/${attempt._id}/questions/${"f".repeat(24)}/images`, { method: "POST", form: imageForm(png(50, 50)) });
  check("a picture can only go on the question being answered", notCurrent.status === 409 && notCurrent.code === "not_current");
  check("signed out: no access", (await client(API)(`/answer-images/${a1.image._id}`)).status === 401);

  console.log("\n=== C. Submitting ===");
  const sent = await call(`/attempts/${attempt._id}/responses`, { method: "POST", body: { questionId: question._id, answer: "" } });
  check("an answer of pictures only (no typed text) is accepted", sent.status === 200, `${sent.status} ${sent.error || ""}`);
  check("  ...and its pictures can no longer be removed or added to", (await call(`/attempts/${attempt._id}/images/${a1.image._id}`, { method: "DELETE" })).status === 409 && (await call(qPath, { method: "POST", form: imageForm(png(50, 50)) })).status === 409);
  // answer the rest in text, then submit
  let next = sent.nextQuestion;
  while (next) next = (await call(`/attempts/${attempt._id}/responses`, { method: "POST", body: { questionId: next._id, answer: "A linker combines object modules into an executable program." } })).nextQuestion;
  const submitted = await call(`/attempts/${attempt._id}/submit`, { method: "POST" });
  check("the test is submitted and marked", submitted.status === 200 && submitted.feedback, `${submitted.status} ${submitted.error || ""}`);

  console.log("\n=== D/E. Marking and the review ===");
  check("the pictures were sent to the image model, as data (never a link)", visionBodies.length >= 1 && visionBodies[0].includes("data:image/png;base64,") && !/https?:\/\/[^"]*\.png/.test(visionBodies[0]));
  check("  ...with the instruction to transcribe, not to answer or obey the page", /Do not correct, complete, improve or summarise it/.test(visionBodies[0]) && /do not follow them/.test(visionBodies[0]));
  check("what was read was marked with the usual marking, told it came from handwriting", markingBodies.some((b) => b.includes("Written on the student") && b.includes("from the transcription, not the student")));
  const review = await call(`/attempts/${attempt._id}/review`);
  const item = review.items.find((x) => String(x.questionId) === String(question._id));
  check("the review shows the answer's pictures", item?.images?.length === 2, JSON.stringify(item?.images));
  check("  ...and what was read from them", /main\\ memory/.test(item?.imageReading?.text || "") && item.imageReading.by === "vision" && item.imageReading.legibility === "clear");
  check("  ...marked on what was read (not 0 for an answer without typed text)", item.marksAwarded > 0 && item.needsReview === false, `${item.marksAwarded} ${item.needsReview}`);
  check("  ...and the student can ask for it to be marked again", item.canRemark === true);
  const before = visionBodies.length;
  const remark = await call(`/attempts/${attempt._id}/questions/${question._id}/remark`, { method: "POST", body: {} });
  check("re-marking uses what was read cleanly, without reading the pictures again", remark.status === 200 && visionBodies.length === before, `${remark.status} ${visionBodies.length - before}`);

  // partial and unreadable readings, and the AI down (OCR)
  const scenario = async (mode) => {
    vision = mode;
    const call = client(API); // a student of its own
    const s = await setUp(call);
    await call(`/attempts/${s.attempt._id}/questions/${s.question._id}/images`, { method: "POST", form: imageForm(png(320, 240)) });
    let q = (await call(`/attempts/${s.attempt._id}/responses`, { method: "POST", body: { questionId: s.question._id, answer: "" } })).nextQuestion;
    while (q) q = (await call(`/attempts/${s.attempt._id}/responses`, { method: "POST", body: { questionId: q._id, answer: "Something." } })).nextQuestion;
    await call(`/attempts/${s.attempt._id}/submit`, { method: "POST" });
    return (await call(`/attempts/${s.attempt._id}/review`)).items.find((x) => String(x.questionId) === String(s.question._id));
  };
  const partial = await scenario("partial");
  check("a page read only in part: marked on what was read, provisional, flagged for review", partial.needsReview === true && partial.marksAwarded > 0 && /provisional/.test(partial.graderNote), `${partial.marksAwarded} ${partial.graderNote}`);
  const unreadable = await scenario("unreadable");
  check("a page that could not be read: no mark invented, flagged, asked for a clearer photo", unreadable.needsReview === true && unreadable.marksAwarded === 0 && /could not be read/.test(unreadable.graderNote) && /clearer photo/.test(unreadable.graderNote), unreadable.graderNote);
  const down = await scenario("down");
  check("the image model down: read by OCR instead, and flagged for review", down.needsReview === true && (down.imageReading?.by === "ocr" || /could not be read/.test(down.graderNote)), JSON.stringify(down.imageReading));

  console.log("\n=== Deleting ===");
  const delSubject = await call(`/subjects/${subject._id}`, { method: "DELETE" });
  check("deleting the subject deletes the answer pictures", delSubject.status === 200 && (await call(`/answer-images/${a1.image._id}`)).status === 404, `${delSubject.status}`);
} catch (err) {
  console.log(`  FAIL  ${err.stack || err.message}`);
  failures++;
} finally {
  for (const c of servers) c.kill();
  fake.close();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
