// Checks that a new test on the same chapter brings new questions.
//
// The bug this guards: rule-based questions come in a fixed order, and only
// one pool's worth of extra drafts was made to replace questions already
// asked, so from the third test on a chapter every question was a repeat. And
// an LLM given the same notes writes the same questions again even when shown
// the ones already asked; those repeats were used instead of new questions.
//
// Starts the real server twice (in-memory database): once with no AI, once
// with a stand-in AI service that always answers with the same questions.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { pickFresh } from "../src/services/testEngine.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const NOTES = fs.readFileSync(fileURLToPath(new URL("../../sample-notes/networks_unit2.md", import.meta.url)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The same five questions every time, each quoting the notes word for word.
const SAME = [
  ["A network topology describes the arrangement of nodes and links in a network.", "network topology", ["bus topology", "ring topology", "mesh topology"]],
  ["A local area network (LAN) connects computers within a building or campus.", "local area network", ["wide area network", "personal area network", "metropolitan area network"]],
  ["Transmission media are the physical paths that carry signals between devices.", "Transmission media", ["Routing tables", "Port numbers", "Mail servers"]],
  ["The transport layer provides end-to-end delivery, segmentation and reliability between processes.", "transport layer", ["network layer", "session layer", "physical layer"]],
  ["Guided media confine the signal to a physical conductor.", "Guided media", ["Unguided media", "Radio waves", "Microwaves"]],
].map(([excerpt, answer, wrong]) => ({
  topic: "",
  prompt: `Fill in the blank: "${excerpt.replace(answer, "_____")}"`,
  options: [answer, ...wrong],
  correctAnswer: answer,
  supportingExcerpt: excerpt,
  difficulty: "medium",
}));
let aiCalls = 0;
const fakeAi = createServer((req, res) => {
  aiCalls++;
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(SAME) } }] }));
  });
});
await new Promise((r) => fakeAi.listen(4586, r));

async function run(label, env, port, tests) {
  console.log(`\n=== ${label} ===`);
  const API = `http://localhost:${port}/api`;
  const server = spawn(process.execPath, ["src/index.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), MONGODB_URI: "", DB_FILE: "memory", NODE_ENV: "development", ...env },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`${API}/health`)).ok) break;
      } catch {
        await wait(200);
      }
    }
    let cookie = "";
    const call = async (path, { method = "GET", body } = {}) => {
      const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost:5173" }, body: body ? JSON.stringify(body) : undefined });
      const set = r.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return r.json();
    };
    await call("/auth/register", { method: "POST", body: { email: `fresh${Date.now()}@example.com`, password: "river-Kettle-42x" } });
    const { subject } = await call("/subjects", { method: "POST", body: { name: "Networks" } });
    const form = new FormData();
    form.append("file", new Blob([NOTES]), "networks_unit2.md");
    const up = await (await fetch(`${API}/subjects/${subject._id}/notes`, { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:5173" }, body: form })).json();
    const results = [];
    for (let t = 1; t <= tests; t++) {
      const r = await call(`/subjects/${subject._id}/tests`, { method: "POST", body: { title: `Test ${t}`, noteIds: [up.note._id], mcqCount: 5, theoryCount: 0 } });
      const q = await call(`/tests/${r.test._id}`);
      results.push({ prompts: q.questions.filter((x) => x.status === "accepted").map((x) => x.prompt), repeats: r.repeatsUsed, by: r.mcqGeneratedBy });
    }
    return results;
  } finally {
    server.kill();
  }
}

console.log("\n=== Which earlier questions come back first ===");
{
  const q = (prompt) => ({ prompt });
  const earlier = ["Define the term \u201cdeadlock\u201d.", "Define the term \u201cmutex\u201d.", "Define the term \u201csemaphore\u201d."];
  // deadlock: shown and right (band 2); mutex: never shown (band 0); semaphore: got wrong (band 1)
  const rank = new Map([[earlier[0], 2e6 + 0], [earlier[1], 1], [earlier[2], 1e6 + 2]]);
  const pick = pickFresh(earlier.map(q), earlier, 3, 3, rank);
  check("a question never shown comes back before one answered wrongly, and that before one answered rightly",
    pick.chosen.map((x) => x.prompt).join(" | ") === [earlier[1], earlier[2], earlier[0]].join(" | "), pick.chosen.map((x) => x.prompt).join(" | "));
  const plain = pickFresh(earlier.map(q), earlier, 3, 3);
  check("  ...and without a ranking they come back in the order written", plain.chosen.map((x) => x.prompt).join("|") === earlier.join("|"));
  const fresh = pickFresh([...earlier.map(q), q("Define the term \u201cmonitor\u201d.")], earlier, 1, 1, rank);
  check("  ...but a new question always comes before any repeat", fresh.chosen.length === 1 && fresh.chosen[0].prompt.includes("monitor"));
}

try {
  const rules = await run("No AI: five tests on one chapter", { GROQ_API_KEY: "" }, 4585, 5);
  const seen = new Set();
  const repeated = rules.map((t) => {
    const n = t.prompts.filter((p) => seen.has(p)).length;
    t.prompts.forEach((p) => seen.add(p));
    return n;
  });
  check("every test has a full set of questions", rules.every((t) => t.prompts.length >= 5), rules.map((t) => t.prompts.length).join(", "));
  check("five tests on a 20-topic chapter repeat nothing", repeated.every((n) => n === 0), `repeats per test: ${repeated.join(", ")}`);

  const ai = await run("An AI that always writes the same questions", { GROQ_API_KEY: "test-key", LLM_API_URL: "http://localhost:4586/v1/chat/completions" }, 4584, 3);
  check("the AI was asked", aiCalls > 0 && ai[0].by === "llm", `${aiCalls} calls`);
  check("the first test uses the AI's questions", SAME.every((q) => ai[0].prompts.includes(q.prompt)));
  const again = ai.slice(1).map((t) => t.prompts.filter((p) => ai[0].prompts.includes(p)).length);
  check("later tests replace the AI's repeats with new questions", again.every((n) => n === 0) && ai.slice(1).every((t) => t.prompts.length >= 5), `repeats: ${again.join(", ")}`);
} finally {
  fakeAi.close();
}

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
