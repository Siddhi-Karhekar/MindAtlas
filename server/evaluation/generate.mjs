// Generates the material for the question-quality evaluation.
//
//   npm run eval:generate -- <files or folders...> [options]
//
// For every note file it builds the notes the app would build, then generates
// the same number of questions from them with each strategy:
//
//   tfidf       the previous generator (evaluation/baseline/): single TF-IDF
//               keywords, one word blanked, one theory template
//   terms       the current generator, rules only: study sentences and whole
//               key terms
//   embeddings  the current generator with the MiniLM model ranking relevance,
//               terms and distractors (only if `npm run semantic:install` was run)
//   llm         the current generator drafting with the configured LLM
//               (only with --llm and a GROQ_API_KEY)
//
// and writes, into one output folder:
//
//   rating_sheet.csv  what the raters fill in. Questions from all strategies,
//                     shuffled, with no sign of which strategy wrote which.
//   key.csv           which strategy wrote each question. Keep it from raters.
//   metrics.md/.json  the automatic measures per strategy (lib/metrics.js).
//   questions.json    everything, for the record.
//
// Options:
//   --out <dir>       output folder (default evaluation-output/<timestamp>)
//   --mcq <n>         fill-in-the-blank questions per file and strategy (default 6)
//   --theory <n>      theory questions per file and strategy (default 4)
//   --seed <n>        makes the run repeatable (default 1)
//   --labels <dir>    folder of "<file>.offtopic.txt" labels (default: beside each file)
//   --no-embeddings   skip the embeddings strategy even if the model is installed
//   --llm             add the llm strategy
//
// docs/EVALUATION.md has the full protocol.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateQuestions as generateBaseline, isQuestionWorthy as baselineKeeps } from "./baseline/testEngine.tfidf.js";
import { collectFiles, notesFromFile, readOffTopicLabels } from "./lib/ingest.js";
import { allSentences, automaticMetrics, gateMetrics } from "./lib/metrics.js";
import { seededRandom, shuffled, toCsv } from "./lib/stats.js";
import { getEmbedder, semanticStatus } from "../src/services/embeddings.js";
import { clearStudyCache, studyFor } from "../src/services/keyTerms.js";
import { generateQuestions } from "../src/services/testEngine.js";

export const RATING_COLUMNS = ["relevant", "correct", "clear", "whole_term", "distractors", "usable", "comment"];
const SHEET_COLUMNS = ["qid", "document", "topic", "type", "question", "option_a", "option_b", "option_c", "option_d", "marked_answer", "model_answer", "source_sentence", ...RATING_COLUMNS];

function parseArgs(argv) {
  const opts = { inputs: [], out: null, mcq: 6, theory: 4, seed: 1, labels: null, embeddings: true, llm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--mcq") opts.mcq = Number(argv[++i]);
    else if (a === "--theory") opts.theory = Number(argv[++i]);
    else if (a === "--seed") opts.seed = Number(argv[++i]);
    else if (a === "--labels") opts.labels = argv[++i];
    else if (a === "--no-embeddings") opts.embeddings = false;
    else if (a === "--llm") opts.llm = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else opts.inputs.push(a);
  }
  return opts;
}

const clozeOf = (q) => String(q.prompt || "").match(/^Fill in the blank:\s*["“]([\s\S]*)["”]\s*$/)?.[1] ?? null;

/**
 * Run the whole generation. Exported so the tests can call it without a
 * child process. Returns { outDir, strategies, metrics, sheet, key }.
 */
export async function runGeneration(options) {
  const opts = { mcq: 6, theory: 4, seed: 1, labels: null, embeddings: true, llm: false, quiet: false, ...options };
  const log = (...a) => !opts.quiet && console.log(...a);
  const files = collectFiles(opts.inputs);
  if (!files.length) throw new Error("no note files found - pass files or folders of PDF, Word, PowerPoint, text or image notes");

  // one seed drives every random choice (option order, distractor draws), so
  // the same command always produces the same sheet
  const random = seededRandom(opts.seed);
  const realRandom = Math.random;
  Math.random = random;
  const savedEnv = { key: process.env.GROQ_API_KEY, semantic: process.env.SEMANTIC_MODEL };
  const restoreSemantic = () => (savedEnv.semantic === undefined ? delete process.env.SEMANTIC_MODEL : (process.env.SEMANTIC_MODEL = savedEnv.semantic));

  try {
    const strategies = ["tfidf", "terms"];
    let embedder = null;
    if (opts.embeddings) {
      log("Loading the embedding model (the first run downloads it) ...");
      embedder = await getEmbedder({ waitMs: 180_000 });
      if (embedder) strategies.push("embeddings");
      else log(`  embeddings strategy skipped: ${semanticStatus().reason}`);
    }
    if (opts.llm) {
      if (savedEnv.key?.trim()) strategies.push("llm");
      else log("  llm strategy skipped: GROQ_API_KEY is not set");
    }

    const counts = { mcqCount: opts.mcq, theoryCount: opts.theory, marksPerQuestion: 1 };
    const run = {
      // every strategy but llm runs with no LLM key, so nothing is drafted by a model by accident
      tfidf: async (notes) => {
        delete process.env.GROQ_API_KEY;
        return generateBaseline(notes, counts);
      },
      terms: async (notes) => {
        delete process.env.GROQ_API_KEY;
        process.env.SEMANTIC_MODEL = "off";
        clearStudyCache();
        try {
          return await generateQuestions(notes, counts);
        } finally {
          restoreSemantic();
        }
      },
      embeddings: async (notes) => {
        delete process.env.GROQ_API_KEY;
        clearStudyCache();
        return generateQuestions(notes, counts);
      },
      llm: async (notes) => {
        process.env.GROQ_API_KEY = savedEnv.key;
        clearStudyCache();
        return generateQuestions(notes, counts);
      },
    };

    const all = []; // { strategy, file, ...question }
    const perStrategy = Object.fromEntries(strategies.map((s) => [s, { questions: [], termsByNote: new Map(), labelsByFile: new Map(), requested: 0 }]));
    const gate = {}; // strategy -> [gateMetrics per labelled file]
    const documents = [];

    for (const [index, filePath] of files.entries()) {
      let doc;
      try {
        doc = await notesFromFile(filePath, { idPrefix: `d${index + 1}` });
      } catch (err) {
        log(`  skipped ${path.basename(filePath)}: ${err.message}`);
        continue;
      }
      const labels = readOffTopicLabels(filePath, opts.labels);
      log(`${doc.file}: ${doc.notes.length} topic note${doc.notes.length === 1 ? "" : "s"}${labels.length ? `, ${labels.length} off-topic labels` : ""}`);
      documents.push({ file: doc.file, title: doc.title, kind: doc.kind, topics: doc.notes.length, split: doc.splitMethod, labels: labels.length });

      // the reference for "what is a whole term": the rule-based key terms
      process.env.SEMANTIC_MODEL = "off";
      clearStudyCache();
      const ruleStudies = new Map();
      for (const n of doc.notes) ruleStudies.set(n, await studyFor(n, { corpus: doc.notes, embedder: null }));
      restoreSemantic();
      clearStudyCache();
      const embStudies = new Map();
      if (embedder) for (const n of doc.notes) embStudies.set(n, await studyFor(n, { corpus: doc.notes, embedder }));
      clearStudyCache();

      for (const strategy of strategies) {
        const result = await run[strategy](doc.notes);
        const bucket = perStrategy[strategy];
        bucket.requested += opts.mcq + opts.theory;
        bucket.labelsByFile.set(doc.file, labels);
        for (const n of doc.notes) bucket.termsByNote.set(String(n._id), ruleStudies.get(n).terms);
        for (const q of [...result.accepted, ...result.discarded]) {
          const item = { ...q, strategy, file: doc.file };
          bucket.questions.push(item);
          if (q.status === "accepted") all.push(item);
        }
      }

      if (labels.length) {
        // how well each gate separates subject sentences from the labelled rest
        const sentences = doc.notes.flatMap(allSentences);
        const keptBy = {
          tfidf: new Set(sentences.filter((s) => baselineKeeps(s))),
          terms: new Set(doc.notes.flatMap((n) => ruleStudies.get(n).sentences.map((s) => s.text))),
          ...(embedder ? { embeddings: new Set(doc.notes.flatMap((n) => embStudies.get(n).sentences.map((s) => s.text))) } : {}),
        };
        for (const [strategy, kept] of Object.entries(keptBy)) (gate[strategy] ||= []).push({ file: doc.file, ...gateMetrics(sentences, kept, labels) });
      }
    }
    if (!documents.length) throw new Error("none of the files could be read");

    // ---- automatic metrics
    const metrics = { generatedAt: new Date().toISOString(), seed: opts.seed, per_file: { mcq: opts.mcq, theory: opts.theory }, documents, strategies: {}, relevance_gate: gate };
    for (const strategy of strategies) {
      const b = perStrategy[strategy];
      metrics.strategies[strategy] = automaticMetrics(b.questions, { requested: b.requested, termsByNote: b.termsByNote, labelsByFile: b.labelsByFile });
    }

    // ---- the rating sheet: identical questions from two strategies are rated once
    const unique = new Map();
    for (const q of all) {
      const id = [q.type, q.prompt, [...(q.options || [])].sort().join("|"), q.answerKey].join("\u0001");
      if (!unique.has(id)) unique.set(id, { q, strategies: new Set() });
      unique.get(id).strategies.add(q.strategy);
    }
    const order = shuffled([...unique.values()], random);
    const width = String(order.length).length;
    const sheet = [];
    const key = [];
    order.forEach(({ q, strategies: by }, i) => {
      const qid = `Q${String(i + 1).padStart(Math.max(3, width), "0")}`;
      const options = q.options || [];
      sheet.push({
        qid,
        document: q.file,
        topic: q.subtopic || q.topic,
        type: q.type === "mcq" ? "fill in the blank" : "theory",
        question: clozeOf(q) ?? `${q.prompt}${q.guidance ? ` (${q.guidance})` : ""}`,
        option_a: options[0] ?? "",
        option_b: options[1] ?? "",
        option_c: options[2] ?? "",
        option_d: options[3] ?? "",
        marked_answer: q.type === "mcq" ? q.answerKey : "",
        model_answer: q.type === "theory" ? q.answerKey : "",
        source_sentence: q.supportingExcerpt,
      });
      for (const strategy of by) key.push({ qid, strategy, type: q.type, difficulty: q.difficulty, document: q.file });
    });

    const outDir = opts.out || path.join("evaluation-output", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "rating_sheet.csv"), toCsv(sheet, SHEET_COLUMNS));
    fs.writeFileSync(path.join(outDir, "key.csv"), toCsv(key, ["qid", "strategy", "type", "difficulty", "document"]));
    fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));
    fs.writeFileSync(path.join(outDir, "metrics.md"), metricsMarkdown(metrics));
    fs.writeFileSync(path.join(outDir, "questions.json"), JSON.stringify(all.map(({ vector: _vector, ...q }) => q), null, 2));

    log(`\n${sheet.length} questions to rate (${all.length} generated, identical ones merged) -> ${path.join(outDir, "rating_sheet.csv")}`);
    log(metricsMarkdown(metrics));
    return { outDir, strategies, metrics, sheet, key };
  } finally {
    Math.random = realRandom;
    if (savedEnv.key === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedEnv.key;
    restoreSemantic();
    clearStudyCache();
  }
}

const pct = (x) => (x === null || x === undefined ? "-" : `${Math.round(x * 100)}%`);
const num = (x) => (x === null || x === undefined ? "-" : String(x));

/** The automatic measures as a table that can go straight into a report. */
export function metricsMarkdown(metrics) {
  const names = Object.keys(metrics.strategies);
  const row = (label, f) => `| ${label} | ${names.map((n) => f(metrics.strategies[n])).join(" | ")} |`;
  const lines = [
    "# Automatic measures",
    "",
    `${metrics.documents.length} document(s), ${metrics.per_file.mcq} fill-in-the-blank and ${metrics.per_file.theory} theory questions requested per document and strategy. Seed ${metrics.seed}.`,
    "",
    `| Measure | ${names.join(" | ")} |`,
    `| --- | ${names.map(() => "---").join(" | ")} |`,
    row("Questions produced / requested", (s) => `${s.produced} / ${s.requested}`),
    row("Blank answers that are whole multi-word terms", (s) => pct(s.mcq.multi_word_answer_rate)),
    row("Mean answer length (words)", (s) => num(s.mcq.mean_answer_words)),
    row("Blanks hiding only part of a term (lower is better)", (s) => pct(s.mcq.partial_term_rate)),
    row("Answer still readable in its own question (lower is better)", (s) => pct(s.mcq.answer_visible_in_question_rate)),
    row("Same answer used twice (lower is better)", (s) => pct(s.mcq.repeated_answer_rate)),
    row("Questions with a placeholder option (lower is better)", (s) => pct(s.mcq.placeholder_option_rate)),
    row("Option length gap from the answer, words (lower is better)", (s) => num(s.mcq.mean_option_length_gap_words)),
    row("Distinct command words in theory questions", (s) => num(s.theory.distinct_command_words)),
    row("Theory questions that say \"your notes\" (lower is better)", (s) => pct(s.theory.mentions_the_notes_rate)),
    row("Theory questions stating how much to write", (s) => pct(s.theory.states_expected_length_rate)),
  ];
  if (names.some((n) => metrics.strategies[n].off_topic)) {
    lines.push(row("Questions built from labelled off-topic text (lower is better)", (s) => (s.off_topic ? `${s.off_topic.questions_from_off_topic_text} of ${s.off_topic.questions_in_labelled_documents} (${pct(s.off_topic.off_topic_rate)})` : "-")));
  }
  const gates = Object.entries(metrics.relevance_gate || {});
  if (gates.length) {
    lines.push("", "## Relevance gate against hand labels", "", "Off-topic sentences are the ones a gate should drop.", "", "| Gate | Sentences | Off topic | Precision | Recall | F1 | Subject sentences kept |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const [strategy, files] of gates) {
      // pooled over the labelled files, from each file's counts
      const sum = (k) => files.reduce((a, f) => a + (f.counts?.[k] ?? f[k] ?? 0), 0);
      const tp = sum("off_topic_dropped");
      const dropped = tp + sum("subject_dropped");
      const off = tp + sum("off_topic_kept");
      const precision = dropped ? tp / dropped : null;
      const recall = off ? tp / off : null;
      const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null;
      const subject = sum("sentences") - off;
      const keptSubject = sum("subject_kept");
      lines.push(`| ${strategy} | ${sum("sentences")} | ${off} | ${pct(precision)} | ${pct(recall)} | ${f1 === null ? "-" : f1.toFixed(2)} | ${pct(subject ? keptSubject / subject : null)} |`);
    }
  }
  lines.push("", "These are computed, not judged. \"Part of a term\" uses the app's own key-term finder as its reference, so it favours `terms` and `embeddings`; the raters' `whole_term` column is the independent measure.", "");
  return lines.join("\n");
}

// Windows paths differ only by case ("d:\\" and "D:\\" are the same folder)
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// run directly: `node evaluation/generate.mjs ...`
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.inputs.length) {
      console.log("Usage: npm run eval:generate -- <files or folders...> [--out dir] [--mcq 6] [--theory 4] [--seed 1] [--labels dir] [--no-embeddings] [--llm]");
      process.exit(1);
    }
    await runGeneration(opts);
    process.exit(0);
  } catch (err) {
    console.error(`eval:generate failed: ${err.message}`);
    process.exit(1);
  }
}
