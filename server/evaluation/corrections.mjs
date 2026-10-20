// Refit the linking rule from students' corrections: do the links students
// remove as wrong say a threshold in services/graphEngine.js should be
// stricter? CONTRIBUTING.md (Member 2, item 6) and docs/LINK_EVALUATION.md
// ("Students' corrections") have the reasoning.
//
//   npm run eval:corrections -- [backup folder] [--run <link evaluation run>]... [--exclude-owner <id>]...
//
// The backup folder is one `npm run db:backup` wrote (server/backups/
// mindatlas-<time>); left out, the newest there. It reads only its
// graph_edges.json and subjects.json, never notes.json, prints numbers only
// and writes nothing.
//
// For each threshold of the linking rule (same-subject links, cross-subject
// links by meaning, cross-subject links by TF-IDF):
//   1. Enough corrections? At least 50 removed links from at least 5
//      students (lib/corrections.js, REFIT); each student's removals count
//      for at most 10. If not, the threshold is kept and nothing is fitted.
//   2. A logistic regression of "removed" on a link's similarity and shared
//      words, and the threshold it suggests: the lowest similarity from which
//      links are kept more often than removed. Only ever stricter.
//   3. A stricter threshold is checked on the link evaluation's ratings
//      (--run: a run on TF-IDF similarity for same-subject and TF-IDF cross-
//      subject links, a run on embedding similarity for links by meaning). It
//      is suggested only if the ratings agree: as good as the best setting,
//      with precision of at least 50%.
// Nothing is changed: a suggestion goes into graphEngine.js by hand, in a
// PR with the output, followed by a relink.
//
// --exclude-owner leaves out one account (the team's test accounts); repeat
// it for several. --reps: bootstrap draws when scoring a run (default 1000).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_RULE } from "../src/services/graphEngine.js";
import { runLinkScoring } from "./links.mjs";
import { checkOnRatings, fitLogistic, GROUPS, newestBackup, readBackup, REFIT, refitGate, refitRows, suggestThreshold } from "./lib/corrections.js";
import { round } from "./lib/stats.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS = path.resolve(HERE, "../backups");

function parseArgs(argv) {
  const opts = { backup: null, runs: [], exclude: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--run") opts.runs.push(value());
    else if (a === "--exclude-owner") opts.exclude.add(value());
    else if (a === "--reps") {
      opts.reps = Number(value());
      if (!Number.isInteger(opts.reps) || opts.reps < 1) throw new Error("--reps needs a whole number");
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else opts.backup = a;
  }
  return opts;
}

/**
 * The refit, for every group of links. `backup` is a backup folder (or,
 * for the tests, `edges` as readBackup returns them); `runs` are link
 * evaluation run folders. Returns { backup, takenAt, excluded, groups:
 * [{ id, name, constant, current, links, removals, students, counted,
 * enough, model, shared, suggestion, ratings, keep, verdict }] }.
 */
export function runCorrectionRefit(options = {}) {
  const opts = { runs: [], exclude: new Set(), reps: 1000, quiet: false, ...options };
  let edges = opts.edges;
  let source = { backup: null, takenAt: null, excluded: 0 };
  if (!edges) {
    const dir = opts.backup ?? newestBackup(BACKUPS);
    if (!dir) throw new Error(`no backup folder given and none in ${BACKUPS} - run npm run db:backup first`);
    const read = readBackup(dir, { exclude: opts.exclude });
    edges = read.edges;
    source = { backup: path.basename(dir), takenAt: read.takenAt, excluded: read.excluded };
  }

  // each run's similarity, from its manifest; scored only if a group needs it
  const runOf = new Map();
  for (const dir of opts.runs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const measure = manifest.similarity || "tfidf";
    if (!runOf.has(measure)) runOf.set(measure, { dir, results: null });
  }
  const scored = (measure) => {
    const run = runOf.get(measure);
    if (!run) return null;
    run.results ??= runLinkScoring({ dir: run.dir, write: false, quiet: true, reps: opts.reps });
    return run;
  };

  const groups = GROUPS.map((group) => {
    const current = LINK_RULE[group.ruleKey];
    const rows = refitRows(edges, group);
    const out = { id: group.id, name: group.name, constant: group.constant, current, ...refitGate(rows), model: null, shared: null, suggestion: null, ratings: null, keep: true };
    if (!out.links) return { ...out, verdict: "no links" };
    if (!out.enough) {
      return { ...out, verdict: `not enough to refit (${out.removals} of ${REFIT.minRemovals} removals, ${out.students} of ${REFIT.minStudents} students) - keep ${current}` };
    }
    const model = fitLogistic(rows.map((r) => ({ features: [r.x, r.shared], y: r.y, w: r.w })));
    // the model at the shared-word count typical of the group's links
    const shared = rows.map((r) => r.shared).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    const suggestion = suggestThreshold(model, { current, max: group.max, shared });
    Object.assign(out, { model: { intercept: round(model.intercept), similarity: round(model.coefficients[0]), shared: round(model.coefficients[1]), converged: model.converged }, shared, suggestion });
    if (!suggestion.stricter) return { ...out, verdict: `keep ${current}: ${suggestion.reason}` };
    const run = scored(group.measure);
    if (!run) return { ...out, verdict: `${suggestion.threshold} suggested, but not checked on the ratings - give --run with a run on ${group.measure} similarity; keep ${current} until then` };
    const check = checkOnRatings(run.results, group, suggestion.threshold);
    out.ratings = { run: path.basename(path.resolve(run.dir)), agrees: check.agrees, reason: check.reason, f1: check.row?.f1 ?? null, precision: check.row?.precision ?? null };
    if (!check.agrees) return { ...out, verdict: `keep ${current}: ${suggestion.threshold} was suggested, but the ratings do not agree - ${check.reason}` };
    return { ...out, keep: false, verdict: `set ${group.constant} to ${suggestion.threshold} (now ${current}): ${suggestion.reason}, and the ratings agree - ${check.reason}` };
  });

  const results = { ...source, refit: REFIT, groups };
  if (!opts.quiet) console.log(refitReport(results));
  return results;
}

/** The refit as text: numbers only. */
export function refitReport(r) {
  const lines = [];
  if (r.backup) lines.push(`Backup: ${r.backup}${r.takenAt ? ` (taken ${r.takenAt})` : ""}`);
  if (r.excluded) lines.push(`Left out: ${r.excluded} edges of excluded accounts`);
  lines.push(
    "",
    `A refit needs at least ${r.refit.minRemovals} removed links from at least ${r.refit.minStudents} students in a group; each student's removals count for at most ${r.refit.capPerStudent}.`,
  );
  for (const g of r.groups) {
    lines.push("", `${g.name} (${g.constant}, now ${g.current})`);
    if (g.links) lines.push(`  ${g.links} links, ${g.removals} removed by ${g.students} student${g.students === 1 ? "" : "s"}${g.enough ? ` (counted as ${g.counted} after the cap)` : ""}`);
    if (g.model) {
      lines.push(
        `  Logistic regression: logit P(removed) = ${g.model.intercept} ${g.model.similarity < 0 ? "-" : "+"} ${Math.abs(g.model.similarity)} x similarity ${g.model.shared < 0 ? "-" : "+"} ${Math.abs(g.model.shared)} x shared words${g.model.converged ? "" : " (did not converge)"}`,
        `  At ${g.current}, P(removed) = ${g.suggestion.atCurrent} for ${g.shared} shared word${g.shared === 1 ? "" : "s"} (the median)`,
      );
    }
    if (g.ratings) lines.push(`  Ratings (${g.ratings.run}): ${g.ratings.agrees ? "agree" : "do not agree"} - ${g.ratings.reason}`);
    lines.push(`  -> ${g.verdict}`);
  }
  lines.push("", "Nothing was changed. A suggested threshold goes into graphEngine.js by hand, in a PR with this output, then a relink.");
  return lines.join("\n");
}

// Windows paths differ only by case ("d:\\" and "D:\\" are the same folder)
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

// run directly: `node evaluation/corrections.mjs ...`
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  try {
    runCorrectionRefit(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`eval:corrections failed: ${err.message}`);
    process.exitCode = 1;
  }
}
