// Thin wrapper around the Groq chat completions API (OpenAI-compatible),
// matching the architecture doc's "Cloud LLM API (Groq LLaMA 3.3-70B)".
// Every caller in this file must handle `null` back from callLLM - that's
// the signal to fall back to the rule-based generator, either because no
// GROQ_API_KEY is configured yet (this project ships with credentials
// stubbed out on purpose, see server/.env.example) or because the request
// failed. Nothing here should ever throw and take down a request.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

export function llmAvailable() {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

/**
 * Send a single-turn chat prompt and get back the raw text response, or
 * null if the LLM isn't configured / the call failed.
 */
export async function callLLM(prompt, { temperature = 0.3 } = {}) {
  if (!llmAvailable()) return null;

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("[llm] Groq request failed:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("[llm] Groq request errored:", err.message);
    return null;
  }
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
