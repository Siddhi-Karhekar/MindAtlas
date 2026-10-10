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
  mcq: "mcq-v2",
  theory: "theory-v2",
  grade: "grade-v3",
  remark: "remark-v2",
  feedback: "feedback-v3",
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

async function once(body) {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS()),
  });
  if (res.ok) {
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content ?? null };
  }
  // 429 (rate limited) and 5xx (provider trouble) are worth one more try;
  // anything else (bad key, bad request) will fail the same way again
  const retryable = res.status === 429 || res.status >= 500;
  const after = Number(res.headers.get("retry-after"));
  // the status and the provider's error type only: an error body can echo
  // back part of the request, which is a student's notes or answer
  const detail = await res.json().catch(() => ({}));
  console.error("[llm] request failed:", res.status, redact(detail?.error?.type || detail?.error?.code || "", 80));
  return { retryable, waitMs: Number.isFinite(after) && after > 0 ? Math.min(5000, after * 1000) : 1000 };
}

/**
 * Send one prompt and get back the raw text response, or null if the LLM
 * isn't configured, timed out, or failed twice.
 *   system       the instructions (kept apart from student text)
 *   temperature  0..1
 */
export async function callLLM(prompt, { temperature = 0.3, system = null } = {}) {
  if (!llmAvailable()) return null;
  const body = {
    model: llmModel(),
    temperature,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await once(body);
      if (!out.retryable) return out.text ?? null;
      if (attempt === 1) await wait(out.waitMs);
    } catch (err) {
      // a timeout or a dropped connection: one more try, then give up
      console.error("[llm] request errored:", err.name === "TimeoutError" ? "timed out" : redact(err.message, 120));
      if (attempt === 1) await wait(500);
    }
  }
  return null;
}

/** Best-effort JSON parse of an LLM response that may be wrapped in prose or a ```json fence. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
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
