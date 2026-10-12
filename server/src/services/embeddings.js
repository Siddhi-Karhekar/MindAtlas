// Sentence embeddings: text -> a vector whose direction encodes meaning, so two
// texts about the same thing point the same way whatever words they use. This
// is the "MiniLM" half of the architecture doc's dual extraction step; TF-IDF
// (tfidf.js) was the stand-in for it.
//
// What it is used for (studyText.js, keyTerms.js, testEngine.js):
//   - relevance: is this sentence about the note's topic, or is it the college
//     name / an exercise / a "prepared by" line?
//   - key terms: which candidate phrases best represent the note (the KeyBERT
//     method)?
//   - distractors: which other terms are close enough to the answer to be
//     plausible wrong options?
//
// The model is all-MiniLM-L6-v2 (22M parameters, Apache-2.0), run locally on
// the CPU through @huggingface/transformers. No API, no key, no per-use cost.
//
// It is an ADD-ON, and everything that uses it has a rule-based path for when
// it is missing. That is deliberate:
//   - the library is large to install (onnxruntime ships binaries for every
//     platform), so it lives in its own folder, server/semantic/, and is only
//     installed by `npm run semantic:install`. A normal `npm ci` - CI, Docker,
//     Render - is unchanged and installs nothing new;
//   - the model file is downloaded once from huggingface.co and cached in
//     server/.cache/. If that download is blocked or slow, nothing breaks;
//   - it holds about 125 MB of memory once loaded (measured: the process went
//     from 49 MB to 172 MB with the default 8-bit model). On a 512 MB host
//     that is affordable but not free, so SEMANTIC_MODEL=off switches it off,
//     and `npm run semantic:check` reports the figure on the machine at hand.
//
// getEmbedder() therefore never throws and never makes a request wait long:
// it answers with the embedder if one is ready (or becomes ready within
// `waitMs`), and null otherwise.

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ADDON_DIR = path.join(SERVER_ROOT, "semantic");
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const BATCH = 32;
const CACHE_LIMIT = 6000; // remembered vectors; ~1.5 KB each
const RETRY_AFTER_MS = 10 * 60_000; // after a failed load, try again this much later

let state = "idle"; // idle | loading | ready | unavailable
let reason = "not loaded yet";
let embedder = null;
let loading = null;
let failedAt = 0;
const cache = new Map();

const enabled = () => !/^(off|false|0|no)$/i.test(String(process.env.SEMANTIC_MODEL || "").trim());

/** For /api/health and logs: is meaning-based ranking active, and if not, why. */
export function semanticStatus() {
  if (!enabled()) return { active: false, state: "off", reason: "SEMANTIC_MODEL=off" };
  return { active: state === "ready", state, reason: state === "ready" ? null : reason, model: embedder?.model || null };
}

// The library is looked for in the add-on folder first, then wherever Node
// would normally find it (someone may have installed it in server/ directly).
async function loadLibrary() {
  const tries = [];
  if (fs.existsSync(path.join(ADDON_DIR, "node_modules"))) {
    tries.push(async () => {
      const require = createRequire(path.join(ADDON_DIR, "package.json"));
      return import(pathToFileURL(require.resolve("@huggingface/transformers")).href);
    });
  }
  tries.push(() => import("@huggingface/transformers"));
  for (const attempt of tries) {
    try {
      const mod = await attempt();
      const lib = mod.pipeline ? mod : mod.default;
      if (lib?.pipeline) return lib;
    } catch {
      // not installed here: try the next place
    }
  }
  return null;
}

async function load() {
  const lib = await loadLibrary();
  if (!lib) throw new Error("the model library is not installed - run `npm run semantic:install` in server/ to enable it");

  const modelId = process.env.SEMANTIC_MODEL_ID || DEFAULT_MODEL;
  if (process.env.SEMANTIC_MODEL_PATH) {
    // a folder that already holds the model: never touches the network
    lib.env.localModelPath = process.env.SEMANTIC_MODEL_PATH;
    lib.env.allowRemoteModels = false;
  } else {
    lib.env.cacheDir = path.join(SERVER_ROOT, ".cache", "models");
  }
  // q8 = 8-bit weights: a quarter of the download and memory, for a loss in
  // ranking quality too small to see in this use
  const extract = await lib.pipeline("feature-extraction", modelId, { dtype: process.env.SEMANTIC_MODEL_DTYPE || "q8" });

  const run = async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const tensor = await extract(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
      out.push(...tensor.tolist());
    }
    return out;
  };
  return wrap(run, modelId);
}

// Adds the cache: the same sentence is embedded once, however many tests are
// built from its note.
function wrap(run, model) {
  return {
    model,
    async embed(texts) {
      const list = texts.map((t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 1200));
      const missing = [...new Set(list.filter((t) => t && !cache.has(t)))];
      if (missing.length) {
        const vectors = await run(missing);
        missing.forEach((t, i) => {
          if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
          cache.set(t, vectors[i]);
        });
      }
      return list.map((t) => cache.get(t) || null);
    },
  };
}

function startLoading() {
  state = "loading";
  reason = "the model is still loading";
  loading = load()
    .then((e) => {
      embedder = e;
      state = "ready";
      console.log(`[semantic] ${e.model} ready - questions use meaning-based relevance and key terms`);
    })
    .catch((err) => {
      state = "unavailable";
      reason = String(err?.message || err).split("\n")[0];
      failedAt = Date.now();
      console.log(`[semantic] off, questions use rule-based ranking: ${reason}`);
    })
    .finally(() => {
      loading = null;
    });
}

/**
 * The embedder, or null if it is switched off, not installed, still loading
 * after `waitMs`, or failed to load. Callers must handle null: it is the
 * normal state of a default install.
 */
export async function getEmbedder({ waitMs = 0 } = {}) {
  if (!enabled()) return null;
  if (state === "ready") return embedder;
  if (state === "unavailable" && Date.now() - failedAt < RETRY_AFTER_MS) return null;
  if (!loading) startLoading();
  if (waitMs > 0 && loading) {
    await Promise.race([loading, new Promise((r) => setTimeout(r, waitMs))]);
  }
  return state === "ready" ? embedder : null;
}

/** Start loading in the background at server start, so the first test doesn't wait. */
export function warmSemanticModel() {
  getEmbedder().catch(() => {});
}

/** Tests only: use `fn(texts) -> vectors` as the model, or null to reset. */
export function setEmbedderForTests(fn) {
  cache.clear();
  loading = null;
  if (fn) {
    embedder = wrap(fn, "test-double");
    state = "ready";
  } else {
    embedder = null;
    state = "idle";
    reason = "not loaded yet";
    failedAt = 0;
  }
}

/** Cosine similarity of two normalised vectors (what the embedder returns). */
export function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** The normalised mean of several vectors: one vector for "what these are about". */
export function centroid(vectors) {
  const list = vectors.filter(Boolean);
  if (!list.length) return null;
  const sum = new Array(list[0].length).fill(0);
  for (const v of list) for (let i = 0; i < v.length; i++) sum[i] += v[i];
  const norm = Math.hypot(...sum) || 1;
  return sum.map((x) => x / norm);
}
