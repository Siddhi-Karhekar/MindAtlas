// The Groq path measurement: does the app's AI path work, how fast is it, and how
// often do its questions pass the filter? docs/measurements/groq-path.md has the
// method, the limits and the results.
//
//   npm run eval:groq -- [--notes <file or folder>]... [--only <names>] [--out <dir>] [--seed <n>]
//                        [--mcq <n>] [--theory <n>] [--pacing spaced|back-to-back|both] [--gap <seconds>]
//                        [--repeats <n>] [--no-rules] [--no-ai]
//
// Builds a test from each document with the app's own generateQuestions, one
// build at a time, three ways: with no key (rules only), with the AI and time for
// the minute limit to recover between builds (spaced), and with the AI and no wait
// (back to back, like busy students). LLM_MODEL picks the model, as it does in the
// app. It needs GROQ_API_KEY in .env, and it stops at once if Groq says a daily
// limit is used up or refuses the key.
//
// --notes defaults to the DEDV and ML folders of evaluation-output/links-notes,
// which are sent to Groq. --only picks documents by file name, comma-separated.
// --mcq and --theory (default 9 and 6) are the pool routes/tests.js asks for on a
// test of 6 MCQs and 4 theory questions.
//
// Writes into --out (default evaluation-output/groq-<timestamp>), which stays
// git-ignored: results.md and results.json hold counts only; builds.jsonl and
// requests.jsonl hold counts, statuses, times, tokens and rate-limit headers, and
// never the key or a request body; app.log holds the app's log lines; replies.jsonl
// holds the AI's raw replies, so it is never shared. A stopped run is picked up
// again from these files, but only on the same commit. App behaviour does not change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearStudyCache } from "../src/services/keyTerms.js";
import { llmModel } from "../src/services/llm.js";
import { generateQuestions } from "../src/services/testEngine.js";
import { isDailyStop, LOG_LINE, recordingFetch, replayReplies, resultsMarkdown, scoreRun, buildRow, spacedWaitMs } from "./lib/groqPath.js";
import { collectFiles, notesFromFile } from "./lib/ingest.js";
import { seedFor } from "./lib/ocr.js";
import { seededRandom } from "./lib/stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..");
const DEFAULT_NOTES = [path.join(SERVER, "evaluation-output", "links-notes", "DEDV"), path.join(SERVER, "evaluation-output", "links-notes", "ML")];
const OLD_PARSER_COMMIT = "d72ac82"; // the fix to escapeLatexBackslashes: the parser as it was is its parent

function parseArgs(argv) {
  const opts = { notes: [] };
  const numbers = { "--seed": "seed", "--mcq": "mcq", "--theory": "theory", "--gap": "gap", "--repeats": "repeats" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--notes") opts.notes.push(argv[++i]);
    else if (a === "--only") opts.only = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--pacing") opts.pacing = argv[++i];
    else if (a === "--no-rules") opts.rules = false;
    else if (a === "--no-ai") opts.ai = false;
    else if (numbers[a]) {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) throw new Error(`${a} needs a whole number`);
      opts[numbers[a]] = v;
    } else throw new Error(`unknown option ${a}`);
  }
  if (!opts.notes.length) delete opts.notes;
  if (opts.pacing && !["spaced", "back-to-back", "both"].includes(opts.pacing)) throw new Error("--pacing is spaced, back-to-back or both");
  return opts;
}

function gitCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const changed = execFileSync("git", ["status", "--porcelain"], { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { commit, uncommitted_changes: changed !== "" };
  } catch {
    return { commit: null, uncommitted_changes: null };
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readRows = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The app's parser as it was before the fix, from git, so it does not have to stay in the app. */
export async function oldParser() {
  const source = execFileSync("git", ["show", `${OLD_PARSER_COMMIT}~1:server/src/services/llm.js`], { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindatlas-old-llm-"));
  const file = path.join(dir, "llm-old.mjs");
  fs.writeFileSync(file, source.replace('"./log.js"', JSON.stringify(pathToFileURL(path.join(SERVER, "src", "services", "log.js")).href)));
  try {
    return (await import(pathToFileURL(file).href)).parseJsonLoose;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Saved builds, and a way to add to them. Requests and replies go in only with a finished build, so a stopped build leaves nothing half-counted. */
function openRun(dir, meta) {
  const files = { builds: path.join(dir, "builds.jsonl"), requests: path.join(dir, "requests.jsonl"), replies: path.join(dir, "replies.jsonl"), log: path.join(dir, "app.log") };
  const rows = readRows(files.builds);
  if (rows.length) {
    const was = rows[0].meta;
    for (const k of Object.keys(meta)) if (was?.[k] !== meta[k]) throw new Error(`${files.builds} is from ${k} ${was?.[k]}, not ${meta[k]} - use a new --out`);
  } else fs.writeFileSync(files.builds, `${JSON.stringify({ meta })}\n`);
  const done = new Map(rows.slice(1).map((b) => [b.key, b]));
  return {
    files,
    done,
    add(row, requests, replies, lines) {
      done.set(row.key, row);
      fs.appendFileSync(files.builds, `${JSON.stringify(row)}\n`);
      for (const r of requests) fs.appendFileSync(files.requests, `${JSON.stringify(r)}\n`);
      for (const r of replies) fs.appendFileSync(files.replies, `${JSON.stringify(r)}\n`);
      for (const l of lines) fs.appendFileSync(files.log, `build=${row.key} ${l}\n`);
    },
  };
}

/** While a build runs: its [testgen], [quality] and [llm] lines are kept. They hold counts and kinds only, by the app's own rule. */
function captureLog(lines, quiet) {
  const real = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(real)) {
    console[level] = (...args) => {
      const line = args.map(String).join(" ");
      if (LOG_LINE.test(line)) lines.push(line);
      if (!quiet) real[level](...args);
    };
  }
  return () => Object.assign(console, real);
}

/**
 * Run the measurement. Exported so the tests can run it against a stand-in for
 * Groq, with no waiting. Returns what results.json holds.
 */
export async function runGroqPath(options = {}) {
  const opts = { seed: 1, mcq: 9, theory: 6, pacing: "both", gap: 65, repeats: 1, rules: true, ai: true, notes: DEFAULT_NOTES, only: null, quiet: false, wait, parser: oldParser, ...options };
  const log = (...a) => !opts.quiet && console.log(...a);

  const keySet = Boolean(process.env.GROQ_API_KEY?.trim());
  if (opts.ai && !keySet) throw new Error("GROQ_API_KEY is not set: the AI builds cannot run. In a git worktree, pass it with node --env-file=<path to server/.env>");
  const allFiles = collectFiles(opts.notes);
  const files = opts.only ? allFiles.filter((f) => opts.only.includes(path.basename(f))) : allFiles;
  if (!files.length) throw new Error(`no note files in ${opts.notes.join(", ")}${opts.only ? ` named ${opts.only.join(", ")}` : ""}`);

  const git = gitCommit();
  const model = llmModel();
  const outDir = opts.out || path.join("evaluation-output", `groq-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const saved = openRun(outDir, { commit: git.commit, seed: opts.seed, model, mcq: opts.mcq, theory: opts.theory });

  const documents = [];
  for (const file of files) {
    // numbered in the whole list, so a document's ids do not depend on --only
    const doc = await notesFromFile(file, { idPrefix: `d${allFiles.indexOf(file) + 1}` });
    const bytes = fs.readFileSync(file);
    documents.push({ ...doc, name: path.basename(file), info: { file: path.basename(file), folder: path.basename(path.dirname(file)), bytes: bytes.length, sha256: sha256(bytes), topics: doc.notes.length, split: doc.splitMethod, chars: doc.fullText.length } });
  }

  // One build. Each starts from the same random numbers and an empty study cache,
  // so the way of building is all that differs between two builds of a document.
  const realFetch = globalThis.fetch;
  const realRandom = Math.random;
  const savedEnv = { key: process.env.GROQ_API_KEY, semantic: process.env.SEMANTIC_MODEL };
  const pendingRequests = [];
  const pendingReplies = [];
  const isLlm = (url) => {
    try {
      const { pathname } = new URL(url);
      return /\/chat\/completions$/.test(pathname);
    } catch {
      return false;
    }
  };
  const recorder = recordingFetch(realFetch, { isLlm, add: (r) => pendingRequests.push(r), addReply: (r) => pendingReplies.push(r) });
  // no meaning model, as on the live site (render.yaml)
  process.env.SEMANTIC_MODEL = "off";
  globalThis.fetch = recorder;

  let lastRequests = null;
  let lastEndedAt = 0;
  let stopped = null;
  const leaveGap = async () => {
    const needed = spacedWaitMs(lastRequests || [], opts.gap);
    const left = lastRequests ? needed - (Date.now() - lastEndedAt) : needed;
    if (left > 0) {
      log(`  waiting ${Math.ceil(left / 1000)} s for the minute limit to recover`);
      await opts.wait(left);
    }
  };

  const oneBuild = async (doc, mode, pacing, rep) => {
    const key = [mode, pacing || "-", doc.name, rep].join("|");
    if (saved.done.has(key)) return false;
    if (mode === "rules") delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedEnv.key;
    Math.random = seededRandom(seedFor(opts.seed, doc.name));
    clearStudyCache();
    recorder.build = key;
    pendingRequests.length = 0;
    pendingReplies.length = 0;
    const lines = [];
    const release = captureLog(lines, opts.quiet);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let result;
    try {
      result = await generateQuestions(doc.notes, { mcqCount: opts.mcq, theoryCount: opts.theory, marksPerQuestion: 1 });
    } finally {
      release();
    }
    const wallMs = Date.now() - started;
    await recorder.settle();
    const requests = [...pendingRequests].sort((a, b) => a.seq - b.seq);
    const row = buildRow({ key, doc: doc.name, mode, pacing, rep, model: mode === "rules" ? null : model, startedAt, wallMs, result, lines, asked: { mcq: opts.mcq, theory: opts.theory } });
    saved.add(row, requests, pendingReplies, lines);
    if (mode === "ai") {
      lastRequests = requests;
      lastEndedAt = Date.now();
      const stop = requests.find(isDailyStop);
      if (stop) stopped = stop.outcome === "auth" ? `Groq refused the key (${stop.status}), on ${key}` : `Groq says a daily limit is used up (${stop.refusal?.limit_name}), on ${key}`;
    }
    log(`  ${key}: ${row.produced} questions, ${row.by_llm} by the AI, ${requests.length} requests`);
    return true;
  };

  try {
    if (opts.rules) {
      log("Rules only ...");
      for (const doc of documents) for (let rep = 1; rep <= opts.repeats; rep++) await oneBuild(doc, "rules", null, rep);
    }
    const pacings = !opts.ai ? [] : opts.pacing === "both" ? ["spaced", "back-to-back"] : [opts.pacing];
    for (const pacing of pacings) {
      log(`AI, ${pacing} (${model}) ...`);
      let first = true;
      for (let rep = 1; rep <= opts.repeats && !stopped; rep++) {
        for (const doc of documents) {
          if (stopped) break;
          if (saved.done.has(["ai", pacing, doc.name, rep].join("|"))) continue;
          if (pacing === "spaced" || first) await leaveGap();
          first = false;
          await oneBuild(doc, "ai", pacing, rep);
        }
      }
      if (stopped) break;
    }
  } finally {
    globalThis.fetch = realFetch;
    Math.random = realRandom;
    if (savedEnv.key === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedEnv.key;
    if (savedEnv.semantic === undefined) delete process.env.SEMANTIC_MODEL;
    else process.env.SEMANTIC_MODEL = savedEnv.semantic;
    clearStudyCache();
  }

  log("Scoring ...");
  const builds = [...saved.done.values()];
  const requests = readRows(saved.files.requests);
  const replies = readRows(saved.files.replies);
  let replay = null;
  if (replies.length) {
    try {
      replay = replayReplies(replies, await opts.parser());
    } catch (err) {
      replay = { reason: `the old parser could not be read from git: ${String(err?.message).slice(0, 80)}` };
    }
  }
  const results = {
    created: new Date().toISOString(),
    ...git,
    seed: opts.seed,
    mcq: opts.mcq,
    theory: opts.theory,
    gap_seconds: opts.gap,
    repeats: opts.repeats,
    model,
    model_from_setting: Boolean(process.env.LLM_MODEL?.trim()),
    timeout_ms: process.env.LLM_TIMEOUT_MS || "20000 (the default)",
    stopped,
    documents: documents.map((d) => d.info),
    ...scoreRun(builds, requests, replay),
  };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, "results.md"), resultsMarkdown(results));
  results.outDir = outDir;
  log(resultsMarkdown(results));
  return results;
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// run directly: `node evaluation/groqPath.mjs ...`
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try {
    (await import("dotenv")).config(); // only when run, so the tests can never reach the key
    const results = await runGroqPath(parseArgs(process.argv.slice(2)));
    console.log(`Written to ${path.join(results.outDir, "results.md")}, results.json, builds.jsonl, requests.jsonl, replies.jsonl and app.log`);
    process.exit(results.stopped ? 2 : 0);
  } catch (err) {
    console.error(`eval:groq failed: ${err.message}`);
    process.exit(1);
  }
}
