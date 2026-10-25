// Thin wrapper around the Groq chat completions API (OpenAI-compatible),
// matching the architecture doc's "Cloud LLM API (Groq LLaMA 3.3-70B)".
// Every caller in this file must handle `null` back from callLLM - that's
// the signal to fall back to the rule-based generator, either because no
// GROQ_API_KEY is configured yet (this project ships with credentials
// stubbed out on purpose, see server/.env.example) or because the request
// failed. Nothing here should ever throw and take down a request.
//
// Two rules every caller follows, because the text sent to the model is
// written by students (their notes, their answers):
//   - the instructions go in `system`, and the student's text goes in the
//     user message inside tags (see `asData`), described there as material to
//     work on, never as instructions;
//   - nothing the model says is trusted on its own: questions must quote the
//     notes (testEngine.js), marks are checked against the answer itself
//     (gradingEngine.js), and the feedback ranking is fixed before the model
//     words it (feedbackEngine.js).

import { redact } from "./log.js";

// ONE PLACE FOR THE AI PROVIDER. Every LLM call in the app goes through
// callLLM below, so changing provider or model is a matter of settings, not
// code: any OpenAI-compatible chat-completions endpoint works.
//   LLM_API_URL  the endpoint (default: Groq)
//   LLM_MODEL    the model name (default: Llama 3.3 70B on Groq)
//   GROQ_API_KEY the key sent to that endpoint (the name is historical)
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const llmModel = () => process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
/**
 * Who the provider is, for telling students where their text goes: Groq by
 * name (its terms say it does not train on what it is sent), any other one
 * only as "an outside AI service" - its address may be internal, and what it
 * does with the text is in its own terms, not known here.
 */
export const llmProvider = () => {
  let host = "";
  try {
    host = new URL(apiUrl()).hostname;
  } catch {
    /* not a URL: treated as unknown */
  }
  const groq = host === "groq.com" || host.endsWith(".groq.com");
  return { name: groq ? "Groq" : "an outside AI service", trainsOnInputs: groq ? false : null };
};

// VERSIONS OF THE PROMPTS. Stored with every question, grade and feedback
// text an LLM produced (with the model's name), so bad output can be traced
// to the prompt and model that wrote it. Change the version whenever the
// wording of that prompt changes. ("v1" was the wording before notes and
// answers were passed as tagged data.)
export const PROMPT_VERSIONS = Object.freeze({
  mcq: "mcq-v7",
  theory: "theory-v6",
  grade: "grade-v3",
  remark: "remark-v2",
  feedback: "feedback-v3",
  verify: "verify-v1",
  keyterms: "keyterms-v1",
});

/** What to store alongside LLM output: which prompt and which model made it. */
export const producedBy = (kind) => ({ promptVersion: PROMPT_VERSIONS[kind], model: llmModel() });

// How long one call may take before it is abandoned. A test build or a
// submission must not hang because the provider is slow: the caller falls
// back to the rules instead.
const TIMEOUT_MS = () => Math.max(1000, Number(process.env.LLM_TIMEOUT_MS) || 20_000);

export function llmAvailable() {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

const apiUrl = () => process.env.LLM_API_URL?.trim() || GROQ_URL;

/**
 * Wrap student-written text so the model can tell it apart from the
 * instructions: inside <tag>...</tag>, with any copy of the tag inside the
 * text taken out, so the text cannot close the block early and carry on as
 * if it were the prompt.
 */
export function asData(tag, text) {
  const clean = String(text ?? "").replace(new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*>`, "gi"), " ");
  return `<${tag}>\n${clean}\n</${tag}>`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Why a call produced no text, in a few words a log or a status line can use.
// The key and the request body are never part of it.
//   not-configured  no GROQ_API_KEY
//   rate-limited    429: too many requests or tokens for now
//   quota           429/402 saying the plan's quota is used up
//   auth            401/403: the key is wrong, revoked or not allowed
//   bad-request     400/404/413/422: the request or model name was refused
//   server-error    5xx from the provider
//   timeout         no answer within LLM_TIMEOUT_MS
//   network         the provider could not be reached
//   empty-response  an answer with no text in it
function failureKind(status, code) {
  const c = String(code || "").toLowerCase();
  if (status === 402 || /quota|insufficient|billing|limit_exceeded_for_plan/.test(c)) return "quota";
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server-error";
  return "bad-request";
}

async function once(body) {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS()),
  });
  if (res.ok) {
    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content ?? null;
    // tokens the provider counted (OpenAI-compatible "usage"), for cost reports
    const usage = data?.usage ? { prompt: Number(data.usage.prompt_tokens) || 0, completion: Number(data.usage.completion_tokens) || 0 } : null;
    return text ? { text, usage } : { error: { kind: "empty-response", status: res.status } };
  }
  const after = Number(res.headers.get("retry-after"));
  // the status and the provider's error type only: an error body can echo
  // back part of the request, which is a student's notes or answer
  const detail = await res.json().catch(() => ({}));
  const code = redact(detail?.error?.code || detail?.error?.type || "", 80);
  const kind = failureKind(res.status, code);
  console.error("[llm] request failed:", res.status, kind, code);
  // 429 (rate limited) and 5xx (provider trouble) are worth one more try;
  // a used-up quota, a bad key or a bad request will fail the same way again
  const retryable = kind === "rate-limited" || kind === "server-error";
  return { retryable, error: { kind, status: res.status, code }, waitMs: Number.isFinite(after) && after > 0 ? Math.min(5000, after * 1000) : 1000 };
}

/**
 * Send one prompt and report what happened:
 *   { text, attempts, durationMs }                on success
 *   { text: null, error: { kind, status?, code? }, attempts, durationMs }
 * `error.kind` is one of the kinds listed at failureKind. Never throws.
 *   system       the instructions (kept apart from student text)
 *   temperature  0..1
 */
export async function callLLMDetailed(prompt, { temperature = 0.3, system = null } = {}) {
  if (!llmAvailable()) return { text: null, error: { kind: "not-configured" }, attempts: 0, durationMs: 0 };
  return sendWithRetry({
    model: llmModel(),
    temperature,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
  });
}

// ---------------------------------------------------------------------------
// Reading pictures (handwritten theory answers)
// ---------------------------------------------------------------------------
// The same provider and key, a model that accepts images. On Groq that is
// qwen/qwen3.8-27b (up to 3 images a request, each counted as 2,048 input
// tokens - see console.groq.com/docs/vision). LLM_VISION_MODEL=off turns it
// off, and pictures are then read with OCR (services/ocr.js) and flagged.
const DEFAULT_VISION_MODEL = "qwen/qwen3.8-27b";
export const visionModel = () => process.env.LLM_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
export const visionAvailable = () => llmAvailable() && visionModel().toLowerCase() !== "off";
export const MAX_VISION_IMAGES = 3;

/**
 * Send instructions, text and up to three pictures ({ mime, data: base64 }) to
 * the vision model. Same result shape as callLLMDetailed. The pictures are
 * sent as data URLs, never as links, so nothing about them is public.
 */
export async function callVisionDetailed(prompt, images, { temperature = 0, system = null } = {}) {
  if (!visionAvailable()) return { text: null, error: { kind: "not-configured" }, attempts: 0, durationMs: 0 };
  const parts = [{ type: "text", text: prompt }, ...images.slice(0, MAX_VISION_IMAGES).map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } }))];
  return sendWithRetry({
    model: visionModel(),
    temperature,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: parts }],
  });
}

async function sendWithRetry(body) {
  const started = Date.now();
  let error = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    try {
      const out = await once(body);
      if (out.text) return { text: out.text, usage: out.usage || null, attempts, durationMs: Date.now() - started };
      error = out.error;
      if (!out.retryable) break;
      if (attempt === 1) await wait(out.waitMs);
    } catch (err) {
      // a timeout or a dropped connection: one more try, then give up
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      error = { kind: timedOut ? "timeout" : "network" };
      console.error("[llm] request errored:", timedOut ? "timed out" : redact(err?.message, 120));
      if (attempt === 1) await wait(500);
    }
  }
  return { text: null, error, attempts, durationMs: Date.now() - started };
}

/**
 * Send one prompt and get back the raw text response, or null if the LLM
 * isn't configured, timed out, or failed twice. (callLLMDetailed says why.)
 */
export async function callLLM(prompt, options = {}) {
  return (await callLLMDetailed(prompt, options)).text;
}

// LaTeX commands that begin with a letter JSON also uses as an escape (\b \f
// \n \r \t \u): written with one backslash inside a JSON string, "\frac" would
// be read as a form feed and "rac", "\theta" as a tab and "heta".
const LATEX_AFTER_JSON_ESCAPE =
  /^(?:b(?:eta|ar|f|ig|inom|igcup|igcap|ullet|ackslash|oldsymbol|ot|ox|egin)|f(?:rac|orall|lat|rown)|n(?:abla|eq|e|u|ot|otin|eg|i|ewline|less|parallel)|r(?:ho|ightarrow|ight|m|angle|ceil|floor|e)|t(?:au|heta|imes|ext|extbf|extit|an|anh|o|op|riangle|ilde|frac|imes)|u(?:nderline|parrow|nion|psilon))(?![A-Za-z])/;

/**
 * An LLM writing formulas inside JSON strings usually escapes the backslash
 * once, not twice: "\frac{a}{b}" arrives as \frac{a}{b}. JSON then either
 * fails to parse (\sqrt, \alpha: not escapes at all, so every question in the
 * reply was lost) or silently corrupts it (\frac, \theta, \beta, \neq: read as
 * control characters). Backslashes that start a LaTeX command are doubled
 * here, before parsing; real escapes (\" \\ \n between words, \u00e9) are kept.
 */
export function escapeLatexBackslashes(text) {
  const s = String(text ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = s[i + 1] ?? "";
    if (next === "\\" || next === '"' || next === "/") {
      out += c + next; // an escape that is already right
      i++;
      continue;
    }
    const rest = s.slice(i + 1, i + 24);
    const latex = /^[a-zA-Z]/.test(next) && (!/^[bfnrtu]/.test(next) || LATEX_AFTER_JSON_ESCAPE.test(rest)) && !/^u[0-9a-fA-F]{4}/.test(rest);
    out += latex ? "\\\\" : c;
  }
  return out;
}

/** Best-effort JSON parse of an LLM response that may be wrapped in prose or a ```json fence. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = escapeLatexBackslashes(fenced ? fenced[1] : text);
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("[") !== -1 ? candidate.indexOf("[") : candidate.indexOf("{");
    const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
    if (start === -1 || end === -1) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
