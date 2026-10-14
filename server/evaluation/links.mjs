// The link evaluation: are the knowledge graph's links right, and which
// thresholds should the linking rule (services/graphEngine.js) use?
// docs/LINK_EVALUATION.md has the full protocol.
//
//   npm run eval:links -- generate <notes folder> [options]
//   npm run eval:links -- score <output folder> [ratings files...] [options]
//
// generate: the notes folder holds one subfolder per subject, with that
// subject's files in it (a file directly in the folder is a subject of its
// own). It makes the files into topics as an upload would, works out every
// topic's keywords as a relink would, scores every pair of topics with the
// current rule, picks the pairs to rate (lib/links.js, choosePairs) and
// writes, into one output folder:
//
//   for-raters/         everything the raters get, and nothing else:
//     rating_sheet.csv  the pairs to rate: two topics' subjects, titles and
//                       openings. Shuffled; no scores, keywords or decisions.
//     practice_sheet.csv  10 other pairs for the raters to do together first
//     topics.md         the full text of every topic, by T number
//     HOW_TO_RATE.txt   the instructions
//   key.csv             each rated pair's similarity, shared keywords, current
//                       decision and stratum. Keep it from the raters.
//   pairs.csv           every pair, for the record (and the similarity chart)
//   manifest.json       the run: seed, commit, rule, subjects, stratum sizes
//
// Options: --out <dir> (default evaluation-output/links-<timestamp>),
// --seed <n> (default 1), --per-bin <n> same-subject pairs per similarity
// bin (default 10), --cross-cap <n> cross-subject pairs sharing a keyword
// before they are sampled (default 150), --zero-shared <n> cross-subject
// pairs sharing no keyword (default 20).
//
// score: reads key.csv, manifest.json and every ratings_<name>.csv in the
// output folder (or the ratings files named), and writes results.md,
// results.json and grid.csv: precision, recall and F1 of every threshold
// setting for same-subject and cross-subject links, the recommended setting,
// and how far the raters agree. Options: --flat <x> (default 0.02),
// --min-linked <n> (default 10), --min-precision <x> (default 0.5), --reps <n>
// bootstrap draws (default 1000).
//
// score --recompute <notes folder>: the same, after a change to the keywords
// (or anything else the linking rule looks at). The notes the run was
// generated from are read again with the current code, each rated pair is
// found again by its topics' refs, and the ratings are scored on the features
// worked out now, beside the run's own. Writes into <output folder>/recomputed
// (or --out): the files score writes, comparison.md and key.recomputed.csv.
//
// --similarity embedding (generate): measure sentence-embedding similarity
// instead of TF-IDF - the cosine of two topics' MiniLM vectors
// (services/noteEmbedding.js; needs `npm run semantic:install`). Pairs are
// binned and sampled by it, and score searches thresholds on it, still
// comparing them with today's rule on TF-IDF similarity. The run remembers
// its similarity (manifest.json), so score needs no option.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbedder, semanticStatus } from "../src/services/embeddings.js";
import { decideEdge, LINK_RULE } from "../src/services/graphEngine.js";
import {
  bootstrapDraws, CHOICE, choosePairs, chooseSetting, excerpt, gridSearch, isLink, loadTopics,
  gridFor, pairLabels, raterAgreement, readRelated, rescorePairs, SAMPLING, scorePairs, stratumOf, stratumWeights, todaysFeatures,
} from "./lib/links.js";
import { parseCsv, seededRandom, shuffled, toCsv } from "./lib/stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHEET_COLUMNS = ["pair", "subject_a", "topic_a", "title_a", "excerpt_a", "subject_b", "topic_b", "title_b", "excerpt_b", "related", "comment"];
// `similarity` is the one the run measures (manifest.json, `similarity`);
// `tfidf_similarity` is what today's rule decides on, whatever the run measures
const KEY_COLUMNS = ["pair", "stratum", "same_subject", "topic_a", "topic_b", "ref_a", "ref_b", "subject_a", "subject_b", "similarity", "tfidf_similarity", "shared_keywords", "current"];
const PAIR_COLUMNS = ["topic_a", "topic_b", "ref_a", "ref_b", "subject_a", "subject_b", "same_subject", "similarity", "tfidf_similarity", "shared_keywords", "current", "stratum", "pair"];
const MEASURES = ["tfidf", "embedding"];

export const HOW_TO_RATE = `How to rate the pairs
=====================

Each row of rating_sheet.csv is two topics from the notes: their
subject, title and the opening of their text. topics.md has the full text of
every topic, under its T number, for when the opening is not enough.

In the "related" column write one of:

  yes     They should be linked: a student revising one would be helped by
          being pointed to the other. They are about the same concept or
          process, one builds directly on the other, or they explain the same
          idea from different sides.
  no      They should not be linked.
  unsure  You cannot decide, even after reading the full text.

Judge what the topics are about, not the words they use:

  - The same word with a different meaning is "no": "cell" in a biology note
    and in an electrochemical cell, "kernel" in an operating system and in
    image processing.
  - Being in the same subject is not enough on its own: two networking topics
    that have nothing to do with each other are "no".
  - Topics in different subjects can be "yes": diffusion in biology and in
    chemistry is the same idea.

"comment" is optional: what made a pair hard, or why you answered as you did
if it is not obvious.

Steps
-----

1. With the other raters, do practice_sheet.csv together and talk through
   every disagreement. It is not counted.
2. Then rate rating_sheet.csv on your own. Do not discuss the pairs with the
   other raters until everyone has finished.
3. Save it as ratings_<your name>.csv - CSV, not .xlsx - and send it back.
   Leave the other columns as they are.
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, inputs: [] };
  const numbers = { "--seed": "seed", "--per-bin": "perBin", "--cross-cap": "crossCap", "--zero-shared": "zeroShared", "--flat": "flat", "--min-linked": "minLinked", "--min-precision": "minPrecision", "--reps": "reps" };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") opts.out = rest[++i];
    else if (a === "--similarity") {
      opts.similarity = rest[++i];
      if (!MEASURES.includes(opts.similarity)) throw new Error(`--similarity is ${MEASURES.join(" or ")}`);
    } else if (a === "--recompute") {
      opts.recompute = rest[++i];
      if (!opts.recompute || opts.recompute.startsWith("--")) throw new Error("--recompute needs the notes folder");
    }
    else if (numbers[a]) {
      const v = Number(rest[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`${a} needs a number`);
      opts[numbers[a]] = v;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else opts.inputs.push(a);
  }
  return opts;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

const topicTitle = (t) => t.label || t.ref;
const sharedText = (p) => p.sharedKeywords.join(" ");

/**
 * Run generation. Exported so the tests can call it without a child process.
 * Returns { outDir, topics, pairs, strata, sample, practice, sheet, key, manifest }.
 */
export async function runLinkGeneration(options) {
  const opts = { seed: 1, ...SAMPLING, similarity: "tfidf", quiet: false, ...options };
  const log = (...a) => !opts.quiet && console.log(...a);
  if (opts.inputs?.length > 1) throw new Error("give one notes folder, with a subfolder per subject");
  const folder = opts.folder ?? opts.inputs?.[0];
  if (!folder) throw new Error("give the notes folder");
  const measure = opts.similarity;
  const embedder = measure === "embedding" ? await embedderFor(opts, log) : null;

  const { subjects, topics, problems } = await loadTopics(folder, { embedder });
  if (topics.length < 2) throw new Error("fewer than two topics - nothing to pair");
  const pairs = scorePairs(topics, { measure });
  const random = seededRandom(opts.seed);
  const { strata, sample, practice } = choosePairs(pairs, { ...opts, measure }, random);

  // the sheet's order, and which topic of each pair is shown first, are both
  // random, so neither says anything about the pair's score or stratum
  const width = Math.max(3, String(sample.length).length);
  const rows = shuffled(sample, random).map((p, i) => {
    const flip = random() < 0.5;
    return { ...p, id: `P${String(i + 1).padStart(width, "0")}`, first: topics[flip ? p.b : p.a], second: topics[flip ? p.a : p.b] };
  });
  const practiceRows = practice.map((p, i) => {
    const flip = random() < 0.5;
    return { id: `X${String(i + 1).padStart(2, "0")}`, first: topics[flip ? p.b : p.a], second: topics[flip ? p.a : p.b] };
  });

  const sheetRow = (r) => ({
    pair: r.id,
    subject_a: r.first.subjectId, topic_a: r.first.id, title_a: topicTitle(r.first), excerpt_a: excerpt(r.first.text),
    subject_b: r.second.subjectId, topic_b: r.second.id, title_b: topicTitle(r.second), excerpt_b: excerpt(r.second.text),
    related: "", comment: "",
  });
  const sheet = rows.map(sheetRow);
  const key = rows.map((r) => ({
    pair: r.id, stratum: r.stratum, same_subject: r.sameSubject ? "yes" : "no",
    topic_a: r.first.id, topic_b: r.second.id, ref_a: r.first.ref, ref_b: r.second.ref,
    subject_a: r.first.subjectId, subject_b: r.second.subjectId,
    // full precision, so scoring decides exactly as the graph would
    similarity: String(r.weight), tfidf_similarity: String(r.tfidfWeight), shared_keywords: sharedText(r), current: r.current || "none",
  }));
  const rated = new Map(rows.map((r) => [`${r.a}|${r.b}`, r.id]));
  const pairRows = pairs.map((p) => ({
    topic_a: topics[p.a].id, topic_b: topics[p.b].id, ref_a: topics[p.a].ref, ref_b: topics[p.b].ref,
    subject_a: topics[p.a].subjectId, subject_b: topics[p.b].subjectId, same_subject: p.sameSubject ? "yes" : "no",
    similarity: String(p.weight), tfidf_similarity: String(p.tfidfWeight), shared_keywords: sharedText(p), current: p.current || "none",
    stratum: stratumOf(p, measure), pair: rated.get(`${p.a}|${p.b}`) || "",
  }));

  const manifest = {
    created: new Date().toISOString(),
    commit: gitCommit(),
    seed: opts.seed,
    options: { perBin: opts.perBin, crossCap: opts.crossCap, zeroShared: opts.zeroShared, practice: opts.practice },
    similarity: measure,
    model: embedder?.model ?? null,
    rule: { ...LINK_RULE },
    subjects,
    topics: topics.length,
    pairs: { all: pairs.length, same: pairs.filter((p) => p.sameSubject).length, cross: pairs.filter((p) => !p.sameSubject).length },
    current_links: {
      same: pairs.filter((p) => p.current === "same-subject").length,
      cross: pairs.filter((p) => p.current === "cross-subject").length,
      rejected: pairs.filter((p) => p.current === "rejected").length,
    },
    strata,
    sample: sample.length,
    practice: practice.length,
    problems,
  };

  const outDir = opts.out || path.join("evaluation-output", `links-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  const raterDir = path.join(outDir, "for-raters");
  fs.mkdirSync(raterDir, { recursive: true });
  fs.writeFileSync(path.join(raterDir, "rating_sheet.csv"), toCsv(sheet, SHEET_COLUMNS));
  fs.writeFileSync(path.join(raterDir, "practice_sheet.csv"), toCsv(practiceRows.map(sheetRow), SHEET_COLUMNS));
  fs.writeFileSync(path.join(raterDir, "topics.md"), topicsMarkdown(topics));
  fs.writeFileSync(path.join(raterDir, "HOW_TO_RATE.txt"), HOW_TO_RATE);
  fs.writeFileSync(path.join(outDir, "key.csv"), toCsv(key, KEY_COLUMNS));
  fs.writeFileSync(path.join(outDir, "pairs.csv"), toCsv(pairRows, PAIR_COLUMNS));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  log(generationSummary(manifest, outDir));
  return { outDir, topics, pairs, strata, sample, practice, sheet, key, manifest };
}

function topicsMarkdown(topics) {
  const lines = ["# Topics", "", "The full text of every topic in the rating sheet, by T number.", ""];
  for (const t of topics) lines.push(`## ${t.id} · ${t.subjectId} · ${topicTitle(t)}`, "", t.text.trim(), "");
  return lines.join("\n");
}

// The embedding model for a run on embedding similarity: `opts.embedder` (the
// tests pass a stand-in), or the local MiniLM model, which must be installed.
async function embedderFor(opts, log) {
  if (opts.embedder) return opts.embedder;
  log("Loading the embedding model ...");
  const embedder = await getEmbedder({ waitMs: 180_000 });
  if (!embedder) throw new Error(`--similarity embedding needs the embedding model (npm run semantic:install): ${semanticStatus().reason}`);
  return embedder;
}

function generationSummary(m, outDir) {
  const lines = [
    "",
    ...(m.similarity === "embedding" ? [`Pairs binned by sentence-embedding similarity (${m.model}).`] : []),
    ...m.subjects.map((s) => `  ${s.subject}: ${s.topics} topic(s) from ${s.files.length} file(s)`),
    "",
    `${m.topics} topics, ${m.pairs.all} pairs (${m.pairs.same} same-subject, ${m.pairs.cross} cross-subject).`,
    `The current rule links ${m.current_links.same} same-subject and ${m.current_links.cross} cross-subject pairs, and turns down ${m.current_links.rejected}.`,
    "",
    "Stratum                          pairs  to rate",
    ...m.strata.filter((s) => s.size).map((s) => `  ${s.id.padEnd(31)}${String(s.size).padStart(6)}${String(s.take).padStart(9)}`),
    "",
    `${m.sample} pairs to rate, ${m.practice} practice pairs.`,
    ...(m.problems.length ? ["", "Files skipped:", ...m.problems.map((p) => `  ${p}`)] : []),
    "",
    `Give the raters the folder ${path.join(outDir, "for-raters")} and nothing else.`,
    `Their filled-in sheets go back into ${outDir} as ratings_<name>.csv; then run`,
    `  npm run eval:links -- score ${outDir}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Every rater's answers: { raters, answers: Map pairId -> [answer per rater], comments, problems }. */
function readRatings(dir, files, known) {
  const paths = files?.length ? files : fs.readdirSync(dir).filter((f) => /^ratings_.+\.csv$/i.test(f)).sort().map((f) => path.join(dir, f));
  if (!paths.length) throw new Error(`no ratings_<name>.csv files in ${dir}`);
  const raters = paths.map((p) => path.basename(p).replace(/^ratings_/i, "").replace(/\.csv$/i, ""));
  const answers = new Map([...known].map((id) => [id, raters.map(() => null)]));
  const comments = new Map();
  const problems = [];
  let practiceRows = 0;
  paths.forEach((p, r) => {
    const rows = parseCsv(fs.readFileSync(p, "utf8"));
    if (rows.length && !("pair" in rows[0] && "related" in rows[0])) {
      problems.push(`${path.basename(p)}: no "pair" and "related" columns - is it the rating sheet?`);
      return;
    }
    for (const row of rows) {
      if (/^X\d+$/i.test(row.pair)) {
        practiceRows += 1;
        continue;
      }
      if (!known.has(row.pair)) {
        problems.push(`${path.basename(p)}: pair "${row.pair}" is not in key.csv`);
        continue;
      }
      const answer = readRelated(row.related);
      if (answer === undefined) problems.push(`${raters[r]}, ${row.pair}: "${row.related}" is not yes, no or unsure - ignored`);
      else answers.get(row.pair)[r] = answer;
      if (row.comment) comments.set(row.pair, [...(comments.get(row.pair) || []), `${raters[r]}: ${row.comment}`]);
    }
  });
  return { raters, answers, comments, problems, practiceRows };
}

const featuresOf = (k) => ({
  // runs before Oct 2026 measured TF-IDF only, and have no column for it
  tfidfWeight: Number(k.tfidf_similarity || k.similarity),
  pair: k.pair,
  stratum: k.stratum,
  sameSubject: k.same_subject === "yes",
  weight: Number(k.similarity),
  sharedKeywords: k.shared_keywords.split(/\s+/).filter(Boolean),
  current: k.current === "none" ? null : k.current,
});

/** What scoring reads from the folder generation wrote. */
function readRun(dir) {
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
  const keyRows = parseCsv(read("key.csv"));
  const sheetPath = path.join(dir, "for-raters", "rating_sheet.csv");
  return {
    manifest: JSON.parse(read("manifest.json")),
    keyRows,
    key: keyRows.map(featuresOf),
    population: parseCsv(read("pairs.csv")).map(featuresOf),
    titles: new Map(fs.existsSync(sheetPath) ? parseCsv(fs.readFileSync(sheetPath, "utf8")).map((r) => [r.pair, `${r.title_a} / ${r.title_b}`]) : []),
  };
}

function writeResults(outDir, results, grid) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, "results.md"), resultsMarkdown(results));
  const gridRows = [...grid.same.map((r) => ({ group: "same", ...r })), ...grid.cross.map((r) => ({ group: "cross", ...r }))].map((r) => ({
    ...r,
    precision_ci: r.precision_ci?.join("-") ?? "",
    recall_ci: r.recall_ci?.join("-") ?? "",
    f1_ci: r.f1_ci?.join("-") ?? "",
  }));
  fs.writeFileSync(path.join(outDir, "grid.csv"), toCsv(gridRows, GRID_COLUMNS));
}

/**
 * Run scoring. Exported so the tests can call it without a child process.
 * Returns the results object that results.json holds.
 */
export function runLinkScoring(options) {
  const opts = { ...CHOICE, reps: 1000, write: true, quiet: false, ...options };
  const dir = opts.dir ?? opts.inputs?.[0];
  if (!dir) throw new Error("give the output folder that eval:links generate wrote");
  const { results, grid } = scoreRun({ ...readRun(dir), dir, files: opts.files ?? opts.inputs?.slice(1) }, opts);
  if (opts.write) writeResults(dir, results, grid);
  if (!opts.quiet) console.log(resultsMarkdown(results));
  return results;
}

/**
 * The scoring itself: the raters' answers in `dir` (or `files`) against the
 * rated pairs' features in `key` and every pair in `population`. Writes
 * nothing. Answers for a pair of the sheet that is not in `key` are ignored
 * without complaint when `sheetPairs` lists it (a re-scored pair whose topic
 * no longer matches). Returns { results, grid, items }.
 */
function scoreRun({ dir, files, manifest, key, population, titles, sheetPairs }, opts) {
  const { raters, answers, comments, problems, practiceRows } = readRatings(dir, files, new Set(sheetPairs ?? key.map((k) => k.pair)));
  const keyIds = new Set(key.map((k) => k.pair));
  for (const id of answers.keys()) if (!keyIds.has(id)) answers.delete(id);
  const labels = pairLabels(answers);
  const labelled = key.filter((k) => labels.get(k.pair).label !== null).map((k) => ({ ...k, label: labels.get(k.pair).label }));
  const { weightOf, unrepresented } = stratumWeights(labelled, manifest.strata);
  const items = labelled.map((it) => ({ ...it, sampleWeight: weightOf.get(it.stratum) }));

  const rule = { ...LINK_RULE };
  const draws = bootstrapDraws(items, seededRandom(opts.seed ?? manifest.seed ?? 1), opts.reps);
  const measure = manifest.similarity || "tfidf";
  const grid = gridSearch({ items, population, draws, current: rule, grid: gridFor(measure) });
  const same = chooseSetting(grid.same, grid.current.same, opts);
  const cross = chooseSetting(grid.cross, grid.current.cross, opts);
  const recommended = {
    similarity: same.row ? same.row.similarity : rule.similarity,
    crossSimilarity: cross.row ? cross.row.crossSimilarity : rule.crossSimilarity,
    crossMinShared: cross.row ? cross.row.crossMinShared : rule.crossMinShared,
  };

  // rated pairs the recommended rule decides differently: what a change
  // would actually do, pair by pair. A group whose setting is kept is decided
  // as today, on TF-IDF similarity; a changed one on the similarity the run
  // measures.
  const recommendedEdge = (it) => decideEdge((it.sameSubject ? same.keep : cross.keep) ? todaysFeatures(it) : it, recommended);
  const changed = items
    .filter((it) => isLink(decideEdge(todaysFeatures(it), rule)) !== isLink(recommendedEdge(it)))
    .map((it) => ({
      pair: it.pair,
      titles: titles.get(it.pair) || "",
      same_subject: it.sameSubject,
      similarity: Number(it.weight.toFixed(3)),
      shared: it.sharedKeywords.length,
      now: isLink(decideEdge(todaysFeatures(it), rule)) ? "linked" : "not linked",
      recommended: isLink(recommendedEdge(it)) ? "linked" : "not linked",
      raters_say: it.label ? "related" : "not related",
    }));

  const ratedIn = (id) => key.filter((k) => k.stratum === id);
  const strata = manifest.strata.filter((s) => s.size).map((s) => {
    const inStratum = items.filter((it) => it.stratum === s.id);
    return { id: s.id, pairs: s.size, rated: ratedIn(s.id).length, labelled: inStratum.length, related: inStratum.filter((it) => it.label).length };
  });
  const sameSubjectOf = new Map(key.map((k) => [k.pair, k.sameSubject]));
  const values = [...labels.values()];

  const results = {
    created: new Date().toISOString(),
    notes: { subjects: manifest.subjects, topics: manifest.topics, pairs: manifest.pairs, generated_at_commit: manifest.commit, seed: manifest.seed },
    similarity: measure,
    model: manifest.model ?? null,
    raters,
    pairs_in_sheet: key.length,
    labelled: labelled.length,
    ties: values.filter((v) => v.yes && v.yes === v.no).length,
    all_unsure: values.filter((v) => v.label === null && v.unsure).length,
    not_rated: values.filter((v) => !v.yes && !v.no && !v.unsure).length,
    practice_rows_ignored: practiceRows,
    rule: { current: rule, recommended },
    choice: {
      flat: opts.flat,
      min_linked: opts.minLinked,
      min_precision: opts.minPrecision,
      same: { keep: same.keep, best_f1: same.best, reason: same.reason, setting: same.row },
      cross: { keep: cross.keep, best_f1: cross.best, reason: cross.reason, setting: cross.row },
    },
    current: grid.current,
    grid: { same: grid.same, cross: grid.cross },
    changed,
    agreement: raterAgreement(raters, answers, (id) => sameSubjectOf.get(id)),
    unsure_by_rater: raters.map((r, i) => ({ rater: r, unsure: [...answers.values()].filter((a) => a[i] === "unsure").length, answered: [...answers.values()].filter((a) => a[i]).length })),
    strata,
    unrepresented,
    comments: Object.fromEntries(comments),
    problems,
  };
  return { results, grid, items };
}

// ---------------------------------------------------------------------------
// Scoring again after a change: the same ratings, features worked out now
// ---------------------------------------------------------------------------

const RECOMPUTED_COLUMNS = ["pair", "stratum", "same_subject", "ref_a", "ref_b", "similarity", "shared_before", "shared_after", "decision_before", "decision_after", "raters"];

/**
 * `score <run> --recompute <notes folder>`: the run's ratings scored again
 * with the current code, to measure a change to the keywords (or anything
 * else pairFeatures looks at) on ratings that already exist. The notes folder
 * is the one `generate` read; it is read again, and every rated pair is found
 * again by its topics' refs (lib/links.js, rescorePairs). The pairs keep
 * their strata, so the sampling weights are the run's; the population (links
 * made) is every pair of the notes as read now. "Before" is the run's own
 * features on the same pairs, both scored with today's rule.
 *
 * Writes into <run>/recomputed (or `out`), leaving the run's results alone:
 * results.md, results.json and grid.csv as `score` writes them, with the
 * recommendation; comparison.md, before against after; key.recomputed.csv,
 * every rated pair's shared keywords and decision before and after.
 * Exported for the tests, which may pass `topics` instead of a folder.
 * Returns { before, after, comparison }.
 */
export async function runLinkRescoring(options) {
  const opts = { ...CHOICE, reps: 1000, write: true, quiet: false, ...options };
  const dir = opts.dir ?? opts.inputs?.[0];
  if (!dir) throw new Error("give the output folder that eval:links generate wrote");
  const files = opts.files ?? opts.inputs?.slice(1);
  const run = readRun(dir);
  const measure = run.manifest.similarity || "tfidf";
  let topics = opts.topics;
  let skipped = [];
  if (!topics) {
    if (!opts.recompute) throw new Error("give the notes folder the run was generated from, after --recompute");
    const embedder = measure === "embedding" ? await embedderFor(opts, () => {}) : null;
    ({ topics, problems: skipped } = await loadTopics(opts.recompute, { embedder }));
  }

  const { key, unmatched, largestChange } = rescorePairs(run.keyRows, topics, { measure });
  const population = scorePairs(topics, { measure });
  const found = new Set(key.map((k) => k.pair));
  const sheetPairs = run.key.map((k) => k.pair);
  const before = scoreRun({ ...run, dir, files, sheetPairs, key: run.key.filter((k) => found.has(k.pair)) }, opts);
  const after = scoreRun({ ...run, dir, files, sheetPairs, key, population }, opts);

  const rule = { ...LINK_RULE };
  const pairCounts = { all: population.length, same: population.filter((p) => p.sameSubject).length, cross: population.filter((p) => !p.sameSubject).length };
  const warnings = [
    ...unmatched.map((u) => `${u.pair} left out: ${u.reason}`),
    ...(largestChange > 1e-9 ? [`similarities differ from key.csv by up to ${largestChange.toPrecision(3)}: the notes, or the vector, are not the ones that were rated - check the labels still apply`] : []),
    ...(["all", "same", "cross"].some((k) => pairCounts[k] !== run.manifest.pairs?.[k])
      ? [`the notes now give ${pairCounts.all} pairs (${pairCounts.same} same-subject, ${pairCounts.cross} cross-subject); the run had ${run.manifest.pairs?.all} (${run.manifest.pairs?.same}, ${run.manifest.pairs?.cross})`]
      : []),
    ...skipped.map((p) => `file skipped: ${p}`),
  ];

  // F1 after minus before in each resample: both runs score the same pairs,
  // in the same order and strata, from the same seed, so the draws match
  const f1Change = (group) => {
    const [b, a] = [before.grid.current[group].f1Draws, after.grid.current[group].f1Draws];
    const diffs = a.map((x, i) => (x === null || b[i] === null ? null : x - b[i])).filter((d) => d !== null).sort((x, y) => x - y);
    if (!diffs.length || after.results.current[group].f1 === null) return null;
    const at = (q) => diffs[Math.min(diffs.length - 1, Math.floor(q * diffs.length))];
    return { change: round4(after.results.current[group].f1 - before.results.current[group].f1), ci: [round4(at(0.025)), round4(at(0.975))] };
  };
  const sharing = (pairs) => [1, 2, 3].map((n) => pairs.filter((p) => !p.sameSubject && p.sharedKeywords.length >= n).length);
  // today's rule decides on TF-IDF similarity, whatever the run measures
  const todays = (p) => decideEdge(todaysFeatures(p), rule) || "none";
  const linksByType = (pairs) => {
    const types = pairs.map(todays);
    return { same: types.filter((t) => t === "same-subject").length, cross: types.filter((t) => t === "cross-subject").length, rejected: types.filter((t) => t === "rejected").length };
  };
  const labelOf = new Map(after.items.map((it) => [it.pair, it.label]));
  const beforeOf = new Map(run.key.map((k) => [k.pair, k]));
  const decisions = key.map((k) => ({ pair: k.pair, after: k, before: beforeOf.get(k.pair) }));
  const changed = decisions
    .filter((d) => todays(d.before) !== todays(d.after))
    .map((d) => ({
      pair: d.pair,
      titles: run.titles.get(d.pair) || "",
      same_subject: d.after.sameSubject,
      similarity: Number(d.after.weight.toFixed(3)),
      shared_before: d.before.sharedKeywords,
      shared_after: d.after.sharedKeywords,
      before: todays(d.before),
      after: todays(d.after),
      raters_say: labelOf.has(d.pair) ? (labelOf.get(d.pair) ? "related" : "not related") : "no label",
    }));

  const comparison = {
    created: new Date().toISOString(),
    commit: gitCommit(),
    run: { generated_at_commit: run.manifest.commit, seed: run.manifest.seed, pairs_rated: run.key.length },
    rule,
    pairs_found: key.length,
    labelled: after.results.labelled,
    largest_similarity_change: largestChange,
    warnings,
    current: {
      same: { before: before.results.current.same, after: after.results.current.same, f1_change: f1Change("same") },
      cross: { before: before.results.current.cross, after: after.results.current.cross, f1_change: f1Change("cross") },
    },
    sharing: {
      rated: { before: sharing(before.items), after: sharing(after.items) },
      rated_related: { before: sharing(before.items.filter((it) => it.label)), after: sharing(after.items.filter((it) => it.label)) },
      all: { before: sharing(run.population), after: sharing(population) },
    },
    links: { before: linksByType(run.population), after: linksByType(population) },
    changed,
    recommended: { rule: after.results.rule.recommended, same: after.results.choice.same.reason, cross: after.results.choice.cross.reason },
  };

  if (opts.write) {
    const outDir = opts.out || path.join(dir, "recomputed");
    writeResults(outDir, after.results, after.grid);
    fs.writeFileSync(path.join(outDir, "comparison.md"), comparisonMarkdown(comparison));
    fs.writeFileSync(path.join(outDir, "comparison.json"), JSON.stringify(comparison, null, 2));
    const afterOf = new Map(key.map((k) => [k.pair, k]));
    const rows = run.keyRows.map((row) => {
      const a = afterOf.get(row.pair);
      const b = beforeOf.get(row.pair);
      return {
        pair: row.pair, stratum: row.stratum, same_subject: row.same_subject, ref_a: row.ref_a, ref_b: row.ref_b,
        similarity: a ? String(a.weight) : "", shared_before: b.sharedKeywords.join(" "), shared_after: a ? a.sharedKeywords.join(" ") : "",
        decision_before: todays(b), decision_after: a ? todays(a) : "",
        raters: labelOf.has(row.pair) ? (labelOf.get(row.pair) ? "related" : "not related") : "",
      };
    });
    fs.writeFileSync(path.join(outDir, "key.recomputed.csv"), toCsv(rows, RECOMPUTED_COLUMNS));
  }
  if (!opts.quiet) console.log(comparisonMarkdown(comparison));
  return { before: before.results, after: after.results, comparison };
}

const round4 = (x) => Math.round(x * 10000) / 10000;
const signed = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;

/** Before against after on the same ratings, as tables for a PR. */
export function comparisonMarkdown(c) {
  const { rule } = c;
  const lines = [
    "# Link evaluation: the same ratings, scored again",
    "",
    `The run's ${c.run.pairs_rated} rated pairs (generated at commit ${c.run.generated_at_commit || "unknown"}, seed ${c.run.seed}), scored again with the code at commit ${c.commit || "unknown"}. ` +
      `${c.pairs_found} found again by their topics' refs, ${c.labelled} of them labelled. Largest change in similarity from key.csv: ${c.largest_similarity_change.toPrecision(2)}. ` +
      `"Before" is the run's own features, "after" the features worked out now; both are scored with today's rule (${rule.similarity}; across subjects ${rule.crossSimilarity} and ${rule.crossMinShared} shared keywords) and the run's sampling weights.`,
  ];
  if (c.warnings.length) lines.push("", "**Check first:**", "", ...c.warnings.map((w) => `- ${w}`));
  lines.push("", "## At today's rule", "", "| Links | Features | Rated pairs linked | Precision | Recall | F1 |", "| --- | --- | --- | --- | --- | --- |");
  for (const [group, name] of [["same", "Same subject"], ["cross", "Cross subject"]]) {
    for (const when of ["before", "after"]) {
      const r = c.current[group][when];
      lines.push(`| ${name} | ${when} | ${r.linked} | ${withCi(r.precision, r.precision_ci)} | ${withCi(r.recall, r.recall_ci)} | ${f1Cell(r)} |`);
    }
  }
  lines.push("", "Change in F1, after minus before, with its 95% interval over the same resamples (paired):", "");
  for (const [group, name] of [["same", "Same subject"], ["cross", "Cross subject"]]) {
    const d = c.current[group].f1_change;
    lines.push(`- ${name}: ${d ? `${signed(d.change)} [${signed(d.ci[0])} to ${signed(d.ci[1])}]` : "-"}`);
  }
  const triple = (xs) => xs.join(" / ");
  lines.push(
    "",
    "## Shared keywords across subjects",
    "",
    "| | Before | After |",
    "| --- | --- | --- |",
    `| Rated cross-subject pairs sharing 1+ / 2+ / 3+ keywords | ${triple(c.sharing.rated.before)} | ${triple(c.sharing.rated.after)} |`,
    `| ...of them, related | ${triple(c.sharing.rated_related.before)} | ${triple(c.sharing.rated_related.after)} |`,
    `| All cross-subject pairs sharing 1+ / 2+ / 3+ keywords | ${triple(c.sharing.all.before)} | ${triple(c.sharing.all.after)} |`,
    `| Links made across all the notes: same-subject / cross-subject / rejected | ${c.links.before.same} / ${c.links.before.cross} / ${c.links.before.rejected} | ${c.links.after.same} / ${c.links.after.cross} / ${c.links.after.rejected} |`,
  );
  if (c.changed.length) {
    lines.push("", "## Rated pairs decided differently", "", "| Pair | Topics | Similarity | Shared before | Shared after | Before | After | Raters |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const x of c.changed) lines.push(`| ${x.pair} | ${x.titles} | ${x.similarity} | ${x.shared_before.join(", ") || "-"} | ${x.shared_after.join(", ") || "-"} | ${x.before} | ${x.after} | ${x.raters_say} |`);
  } else lines.push("", "No rated pair is decided differently.");
  const rec = c.recommended.rule;
  const keep = rec.similarity === rule.similarity && rec.crossSimilarity === rule.crossSimilarity && rec.crossMinShared === rule.crossMinShared;
  lines.push(
    "",
    "## The thresholds, with the new features",
    "",
    keep ? "The choice rule keeps today's thresholds." : `The choice rule recommends ${rec.similarity}; across subjects ${rec.crossSimilarity} and ${rec.crossMinShared} shared keywords.`,
    "",
    `- Same subject: ${c.recommended.same}.`,
    `- Cross subject: ${c.recommended.cross}.`,
    "",
    "results.md in this folder has the full tables.",
    "",
  );
  return lines.join("\n");
}

const GRID_COLUMNS = ["group", "similarity", "crossSimilarity", "crossMinShared", "links", "linked", "linked_related", "related", "precision", "precision_ci", "recall", "recall_ci", "f1", "f1_ci"];

const pct = (x) => (x === null || x === undefined ? "-" : `${Math.round(x * 100)}%`);
const ci = (r) => (r ? `${Math.round(r[0] * 100)}-${Math.round(r[1] * 100)}%` : "-");
const f2 = (x) => (x === null || x === undefined ? "-" : x.toFixed(2));
const withCi = (x, r) => `${pct(x)} [${ci(r)}]`;
const f1Cell = (row) => `${f2(row.f1)} [${row.f1_ci ? row.f1_ci.map(f2).join("-") : "-"}]`;
const sameSetting = (a, b) => a && b && a.similarity === b.similarity && a.crossSimilarity === b.crossSimilarity && a.crossMinShared === b.crossMinShared;

/** The results as tables that can go straight into a report or a PR. */
export function resultsMarkdown(r) {
  const { current, recommended } = r.rule;
  const lines = [
    "# Link evaluation: human ratings",
    "",
    `${r.labelled} of ${r.pairs_in_sheet} pairs labelled by ${r.raters.length} rater${r.raters.length === 1 ? "" : "s"} (${r.raters.join(", ")}), from ${r.notes.topics} topics in ${r.notes.subjects.length} subjects (${r.notes.pairs.all} pairs in all). ` +
      `${r.ties} tie(s), counted as not related; ${r.all_unsure} pair(s) everyone was unsure about and ${r.not_rated} not rated, both left out.`,
    "",
    "## Recommendation",
    "",
    ...(r.similarity === "embedding"
      ? [`Similarity measured: sentence embeddings (${r.model || "unknown model"}), the cosine of two topics' vectors (services/noteEmbedding.js). "Now" is today's rule, on TF-IDF similarity. A recommended threshold that differs from it is on embedding similarity: using it means the graph linking on embeddings.`, ""]
      : []),
    "| Constant in graphEngine.js | Now | Recommended | Why |",
    "| --- | --- | --- | --- |",
    `| SIMILARITY_THRESHOLD | ${current.similarity} | ${recommended.similarity} | ${r.choice.same.keep ? "keep: " : ""}${r.choice.same.reason} |`,
    `| CROSS_SUBJECT_THRESHOLD | ${current.crossSimilarity} | ${recommended.crossSimilarity} | ${r.choice.cross.keep ? "keep: " : ""}${r.choice.cross.reason} |`,
    `| CROSS_SUBJECT_MIN_SHARED | ${current.crossMinShared} | ${recommended.crossMinShared} | (chosen with the cross-subject threshold) |`,
    "",
    `How it is chosen: settings linking fewer than ${r.choice.min_linked} rated pairs are not considered. A setting is as good as the best when its F1 is not clearly below the best one's: across the same resamples, the difference stays above -${r.choice.flat} at the 97.5th percentile. The current setting is kept if it is as good as the best; otherwise the most precise of those settings is recommended, because a wrong link costs more than a missing one, provided its precision is at least ${pct(r.choice.min_precision)} so that the links it adds are right more often than wrong.`,
    "",
    "| Link type | Setting | Rated pairs linked | Precision | Recall | F1 |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const detail = (label, setting, row) => `| ${label} | ${setting} | ${row.linked} | ${withCi(row.precision, row.precision_ci)} | ${withCi(row.recall, row.recall_ci)} | ${f1Cell(row)} |`;
  lines.push(detail("Same subject", `now (${current.similarity})`, r.current.same));
  if (r.choice.same.setting && !r.choice.same.keep) lines.push(detail("Same subject", `recommended (${recommended.similarity})`, r.choice.same.setting));
  lines.push(detail("Cross subject", `now (${current.crossSimilarity}, ${current.crossMinShared} shared)`, r.current.cross));
  if (r.choice.cross.setting && !r.choice.cross.keep) lines.push(detail("Cross subject", `recommended (${recommended.crossSimilarity}, ${recommended.crossMinShared} shared)`, r.choice.cross.setting));
  lines.push(
    "",
    "Precision and recall are estimates for all pairs, not just the rated ones: each rated pair counts for the pairs of its similarity band it stands for. Brackets are 95% intervals (Wilson on the effective number of pairs; for F1, 1000 resamples).",
  );

  if (r.changed.length) {
    lines.push("", "### Rated pairs the recommendation decides differently", "", "| Pair | Topics | Similarity | Shared keywords | Now | Recommended | Raters |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const c of r.changed) lines.push(`| ${c.pair} | ${c.titles} | ${c.similarity} | ${c.same_subject ? "-" : c.shared} | ${c.now} | ${c.recommended} | ${c.raters_say} |`);
  }

  lines.push("", "## Same subject, by threshold", "", "Links made: across all the notes. Rated pairs linked: of the rated pairs.", "", "| Threshold | Links made | Rated pairs linked | Precision | Recall | F1 |", "| --- | --- | --- | --- | --- | --- |");
  for (const row of r.grid.same) {
    const mark = [row.similarity === current.similarity && "now", sameSetting(row, r.choice.same.setting) && !r.choice.same.keep && "recommended"].filter(Boolean).join(", ");
    lines.push(`| ${row.similarity.toFixed(2)}${mark ? ` (${mark})` : ""} | ${row.links} | ${row.linked} | ${withCi(row.precision, row.precision_ci)} | ${withCi(row.recall, row.recall_ci)} | ${f1Cell(row)} |`);
  }

  const ks = [...new Set(r.grid.cross.map((row) => row.crossMinShared))];
  lines.push("", "## Cross subject, by threshold and shared keywords", "", "Each cell: F1 (precision / recall) and links made across all the notes. grid.csv has the intervals.", "", `| Threshold | ${ks.map((k) => `${k} shared`).join(" | ")} |`, `| --- | ${ks.map(() => "---").join(" | ")} |`);
  for (const t of new Set(r.grid.cross.map((row) => row.crossSimilarity))) {
    const cells = ks.map((k) => {
      const row = r.grid.cross.find((x) => x.crossSimilarity === t && x.crossMinShared === k);
      const isNow = t === current.crossSimilarity && k === current.crossMinShared;
      const mark = isNow ? " **now**" : sameSetting(row, r.choice.cross.setting) && !r.choice.cross.keep ? " **recommended**" : "";
      return `${f2(row.f1)} (${pct(row.precision)} / ${pct(row.recall)}), ${row.links}${mark}`;
    });
    lines.push(`| ${t.toFixed(2)} | ${cells.join(" | ")} |`);
  }

  lines.push("", "## Agreement between raters", "");
  if (r.raters.length < 2) lines.push("Only one rater, so agreement cannot be measured. A second rater is needed before these numbers can be reported.");
  else {
    lines.push("Over the pairs both raters answered yes or no. Kappa is agreement beyond chance: 0.41-0.60 is usually called moderate, 0.61-0.80 substantial.", "", "| Raters | Group | Pairs | Identical answers | Kappa |", "| --- | --- | --- | --- | --- |");
    const groupName = { all: "all", same: "same subject", cross: "cross subject" };
    for (const a of r.agreement) lines.push(`| ${a.raters.join(" / ")} | ${groupName[a.group]} | ${a.n} | ${pct(a.same)} | ${a.kappa === null ? "-" : a.kappa.toFixed(2)} |`);
  }
  lines.push("", ...r.unsure_by_rater.map((u) => `- ${u.rater}: ${u.answered} answered, ${u.unsure} unsure`));

  lines.push("", "## Where the related pairs are", "", "| Stratum | Pairs | Rated | Labelled | Related |", "| --- | --- | --- | --- | --- |");
  for (const s of r.strata) lines.push(`| ${s.id} | ${s.pairs} | ${s.rated} | ${s.labelled} | ${s.labelled ? `${s.related} (${pct(s.related / s.labelled)})` : "-"} |`);
  if (r.unrepresented.length) lines.push("", `Not represented (pairs, but none labelled, so the estimates leave them out): ${r.unrepresented.join("; ")}.`);
  if (r.problems.length) lines.push("", "## Cells that were ignored", "", ...r.problems.map((p) => `- ${p}`));
  lines.push("", `Notes generated at commit ${r.notes.generated_at_commit || "unknown"}, seed ${r.notes.seed}.`, "");
  return lines.join("\n");
}

// Windows paths differ only by case ("d:\\" and "D:\\" are the same folder)
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const USAGE = [
  "usage: npm run eval:links -- generate <notes folder> [--out dir] [--seed 1] [--similarity tfidf|embedding] [--per-bin 10] [--cross-cap 150] [--zero-shared 20]",
  "       npm run eval:links -- score <output folder> [ratings files...] [--flat 0.02] [--min-linked 10] [--min-precision 0.5] [--reps 1000]",
  "       npm run eval:links -- score <output folder> --recompute <notes folder> [--out dir] [same options]",
].join("\n");

// run directly: `node evaluation/links.mjs ...`
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!["generate", "score"].includes(opts.command) || !opts.inputs.length) {
      console.log(USAGE);
      process.exit(1);
    }
    if (opts.command === "generate") await runLinkGeneration(opts);
    else if (opts.recompute) {
      await runLinkRescoring(opts);
      const out = opts.out || path.join(opts.inputs[0], "recomputed");
      console.log(`Written to ${path.join(out, "comparison.md")}, results.md, results.json, grid.csv and key.recomputed.csv`);
    } else {
      runLinkScoring(opts);
      console.log(`Written to ${path.join(opts.inputs[0], "results.md")}, results.json and grid.csv`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`eval:links ${process.argv[2] || ""} failed: ${err.message}`);
    process.exit(1);
  }
}
