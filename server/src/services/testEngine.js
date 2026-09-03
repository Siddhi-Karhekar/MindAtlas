import { callLLM, llmAvailable, parseJsonLoose } from "./llm.js";

// Mirrors Diagram 3, step 1 of the architecture doc: an LLM drafts
// candidate questions, but every single one passes through a decision
// diamond first - "answer key supported by passage?" - before a student
// ever sees it. The model is only allowed to use the selected notes'
// own text as context (retrieval-augmented, never open-domain), and if
// it can't point to a passage that supports its own answer, the item is
// discarded here, server-side, not left for the student to catch.

function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isSupportedByContext(excerpt, contextText) {
  const needle = normalize(excerpt);
  if (needle.length < 8) return false; // too short to meaningfully "support" anything
  return normalize(contextText).includes(needle);
}

function buildContext(notes) {
  return notes.map((n) => `### ${n.title}\n${n.rawText}`).join("\n\n");
}

async function generateWithLLM(notes, mcqCount) {
  const context = buildContext(notes);
  const prompt = `You are drafting multiple-choice questions for a student's self-test, using ONLY the notes below as source material. Do not use any outside knowledge - every question's correct answer must be directly supported by a verbatim short excerpt from these notes.

NOTES:
${context}

Return a JSON array of exactly ${mcqCount} objects, each shaped like:
{
  "topic": "<the note title this question is drawn from>",
  "prompt": "<the question text>",
  "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
  "correctAnswer": "<must exactly match one of the options>",
  "supportingExcerpt": "<a short verbatim quote from the notes above that supports the correct answer>"
}
Return ONLY the JSON array, no other text.`;

  const raw = await callLLM(prompt);
  const parsed = parseJsonLoose(raw);
  if (!Array.isArray(parsed)) return null;
  return parsed;
}

// Zero-dependency fallback so the whole feature is runnable and testable
// without a GROQ_API_KEY - see server/.env.example. Builds a "fill in the
// blank" MCQ per note by blanking out that note's top TF-IDF keyword in a
// sentence that actually contains it, with distractors drawn from other
// notes' keywords. Deterministic, always grounded by construction (the
// supporting excerpt IS the sentence the blank came from).
function generateWithFallback(notes, mcqCount) {
  const drafts = [];
  const allKeywords = [...new Set(notes.flatMap((n) => n.keywords))];

  for (let i = 0; i < mcqCount; i++) {
    const note = notes[i % notes.length];
    const keyword = note.keywords[i % Math.max(note.keywords.length, 1)];
    if (!keyword) continue;

    const sentences = note.rawText.split(/(?<=[.!?])\s+/);
    const sentence = sentences.find((s) => normalize(s).includes(keyword)) || sentences[0] || note.rawText;
    const blanked = sentence.replace(new RegExp(keyword, "i"), "_____");

    const distractors = allKeywords.filter((k) => k !== keyword).sort(() => Math.random() - 0.5).slice(0, 3);
    while (distractors.length < 3) distractors.push(`${keyword}-related term`);

    const options = [...distractors, keyword].sort(() => Math.random() - 0.5);

    drafts.push({
      topic: note.title,
      prompt: `Fill in the blank: "${blanked}"`,
      options,
      correctAnswer: keyword,
      supportingExcerpt: sentence,
    });
  }

  return drafts;
}

/**
 * Generate `mcqCount` MCQs grounded in `notes`, then apply the
 * hallucination gate. Returns { accepted, discarded, generatedBy }.
 */
export async function generateQuestions(notes, { mcqCount, marksPerQuestion }) {
  let drafts = null;
  let generatedBy = "rule-based-fallback";

  if (llmAvailable()) {
    drafts = await generateWithLLM(notes, mcqCount);
    if (drafts) generatedBy = "llm";
  }
  if (!drafts || drafts.length === 0) {
    drafts = generateWithFallback(notes, mcqCount);
    generatedBy = "rule-based-fallback";
  }

  const contextText = buildContext(notes);
  const accepted = [];
  const discarded = [];

  for (const d of drafts) {
    const supported =
      d?.prompt &&
      Array.isArray(d.options) &&
      d.options.includes(d.correctAnswer) &&
      isSupportedByContext(d.supportingExcerpt, contextText);

    const item = {
      type: "mcq",
      topic: d?.topic || notes[0]?.title || "General",
      prompt: d?.prompt,
      options: d?.options,
      answerKey: d?.correctAnswer,
      supportingExcerpt: d?.supportingExcerpt,
      marks: marksPerQuestion,
      status: supported ? "accepted" : "discarded",
      generatedBy,
    };

    (supported ? accepted : discarded).push(item);
  }

  return { accepted, discarded, generatedBy };
}
