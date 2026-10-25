// Who wrote a test's questions, in words a student can read. The server
// reports, per question type, what actually happened (routes/tests.js
// `generation`): the AI wrote them, the built-in rules did, or both - and,
// when the rules stepped in, why. Technical detail (status codes, error
// bodies) stays in the server log; only a plain reason is shown here.

const REASONS = {
  "not-configured": "no AI writer is set up on this server",
  "rate-limited": "the AI writer's usage limit was reached for now",
  quota: "the AI writer's quota is used up",
  auth: "the AI writer is unavailable",
  "bad-request": "the AI writer could not take the request",
  "server-error": "the AI writer did not respond",
  timeout: "the AI writer did not respond in time",
  network: "the AI writer could not be reached",
  "invalid-response": "the AI writer's reply could not be used",
  "empty-response": "the AI writer's reply could not be used",
  "no-questions": "the AI writer returned no questions",
  "no-material": "these notes had nothing the AI writer could be asked about",
  "llm-questions-rejected": "the AI's questions did not pass the quality checks",
  "llm-questions-repeated": "the AI's questions repeated your earlier tests",
};

/** A plain reason for the fallback, or "" when there is none to give. */
export const fallbackReasonText = (reason) => REASONS[reason] || (reason ? "the AI writer was unavailable" : "");

const TYPE = { mcq: "MCQs", theory: "Theory" };

/**
 * One line per question type: { type, status, text }. `status` is "llm",
 * "mixed", "rule-based-fallback", "failed". `legacy` covers a build result
 * from before `generation` existed ({ mcqGeneratedBy, theoryGeneratedBy }).
 */
export function describeGeneration(generation, legacy = {}) {
  const g = generation || {
    mcq: legacy.mcqGeneratedBy ? { status: legacy.mcqGeneratedBy } : null,
    theory: legacy.theoryGeneratedBy ? { status: legacy.theoryGeneratedBy } : null,
  };
  const lines = [];
  for (const type of ["mcq", "theory"]) {
    const x = g?.[type];
    if (!x || !x.status || x.status === "none") continue;
    const ai = `AI (${x.provider || "Groq"})`;
    const why = fallbackReasonText(x.fallbackReason);
    let text;
    if (x.status === "llm") text = `written by ${ai}`;
    else if (x.status === "mixed")
      text =
        typeof x.byLlm === "number"
          ? `${x.byLlm} written by ${ai}, ${x.byRules} by MindAtlas's built-in rules${why ? ` (${why})` : ""}`
          : `written by ${ai} and MindAtlas's built-in rules`;
    else if (x.status === "failed") text = `could not be made${why ? ` (${why})` : ""}`;
    else text = `written by MindAtlas's built-in rules${why ? ` — ${why}` : ""}`;
    lines.push({ type, status: x.status, text: `${TYPE[type]}: ${text}` });
  }
  return lines;
}

/** A one-word badge for a test in a list: "AI", "AI + rules", "Rules". */
export function generationBadge(generation) {
  const statuses = ["mcq", "theory"].map((t) => generation?.[t]?.status).filter((s) => s && s !== "none" && s !== "failed");
  if (!statuses.length) return null;
  if (statuses.every((s) => s === "llm")) return "AI";
  if (statuses.every((s) => s === "rule-based-fallback")) return "Rules";
  return "AI + rules";
}
