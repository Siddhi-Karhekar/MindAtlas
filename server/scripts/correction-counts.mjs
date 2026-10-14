// How many links students have marked as wrong, from a database backup:
// the evidence for deciding whether students' corrections can feed back into
// the linking rule (CONTRIBUTING.md, Member 2, next-phase item 6).
//
//   node scripts/correction-counts.mjs [backup folder] [--exclude-owner <id>]...
//
// The backup folder is one `npm run db:backup` wrote (server/backups/
// mindatlas-<time>); left out, the newest there. --exclude-owner leaves out
// one account's links (the team's own test accounts, say); repeat it for
// several. The ids are the users' _id values.
//
// It reads only graph_edges.json and subjects.json (to know whose link an
// edge is), never notes.json, and prints numbers only: no ids, names,
// titles or words. Nothing is written anywhere.
//
// What it cannot show: a restored link looks exactly like one that was never
// removed (restoring clears `correction` and `correctedAt`), and students
// have no way to add a link the graph missed, so only wrong links are ever
// reported, never missing ones.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BSON } from "mongodb";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS = path.resolve(HERE, "../backups");

function parseArgs(argv) {
  const opts = { dir: null, exclude: new Set() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exclude-owner") {
      const id = argv[++i];
      if (!id) throw new Error("--exclude-owner needs a user id");
      opts.exclude.add(id);
    } else if (argv[i].startsWith("--")) throw new Error(`unknown option ${argv[i]}`);
    else opts.dir = argv[i];
  }
  if (!opts.dir) {
    const all = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((d) => d.startsWith("mindatlas-")).sort() : [];
    if (!all.length) throw new Error(`no backup folder given and none in ${BACKUPS} - run npm run db:backup first`);
    opts.dir = path.join(BACKUPS, all.at(-1));
  }
  return opts;
}

// a backup's collection, or [] when the backup has none
const readCollection = (dir, name) => {
  const file = path.join(dir, `${name}.json`);
  return fs.existsSync(file) ? BSON.EJSON.parse(fs.readFileSync(file, "utf8")) : [];
};

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "-");
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");

// Bands of the linking rule's own numbers (services/graphEngine.js):
// same-subject links start at similarity 0.11 (0.12 before 14 Oct 2026), and
// cross-subject ones at 0.25 on TF-IDF or 0.68 by meaning.
const SAME_BANDS = [0.11, 0.13, 0.15, 0.2, 0.3];
const CROSS_TFIDF_BANDS = [0.25, 0.3, 0.4];
const MEANING_BANDS = [0.68, 0.72, 0.76];
const bandOf = (x, edges) => {
  if (x === null || x === undefined || Number.isNaN(x)) return "no score";
  if (x < edges[0]) return `<${edges[0]}`;
  for (let i = 1; i < edges.length; i++) if (x < edges[i]) return `${edges[i - 1]}-${edges[i]}`;
  return `>=${edges.at(-1)}`;
};
const bandNames = (edges) => [`<${edges[0]}`, ...edges.slice(1).map((e, i) => `${edges[i]}-${e}`), `>=${edges.at(-1)}`, "no score"];

function table(title, rows) {
  console.log(`\n${title}`);
  if (!rows.some((r) => r[1])) return console.log("  none");
  const width = Math.max(...rows.map((r) => r[0].length), 4);
  console.log(`  ${"".padEnd(width)}  ${"links".padStart(6)}  ${"removed".padStart(7)}  ${"rate".padStart(6)}`);
  for (const [name, links, removed] of rows) {
    if (!links) continue;
    console.log(`  ${name.padEnd(width)}  ${String(links).padStart(6)}  ${String(removed).padStart(7)}  ${pct(removed, links).padStart(6)}`);
  }
}

function byBand(edges, value, bands) {
  return bandNames(bands).map((name) => {
    const inBand = edges.filter((e) => bandOf(value(e), bands) === name);
    return [name, inBand.length, inBand.filter(isRemoved).length];
  });
}

const isRemoved = (e) => e.correction === "removed";
const typeOf = (e) => e.edgeType || "same-subject"; // rows from before cross-subject linking have no type
const num = (x) => (x === null || x === undefined ? null : Number(x));

try {
  const opts = parseArgs(process.argv.slice(2));
  const manifestFile = path.join(opts.dir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};
  const ownerOf = new Map(readCollection(opts.dir, "subjects").map((s) => [String(s._id), String(s.ownerId)]));
  const all = readCollection(opts.dir, "graph_edges").map((e) => ({ ...e, owner: ownerOf.get(String(e.sourceSubjectId ?? e.subjectId)) ?? null }));
  const edges = all.filter((e) => !opts.exclude.has(e.owner));
  const removed = edges.filter(isRemoved);

  console.log(`Backup: ${path.basename(opts.dir)}${manifest.takenAt ? ` (taken ${manifest.takenAt})` : ""}`);
  if (opts.exclude.size) console.log(`Left out: ${all.length - edges.length} edges of ${opts.exclude.size} excluded account(s)`);
  const unknown = edges.filter((e) => e.owner === null).length;
  if (unknown) console.log(`Edges whose subject is not in the backup (owner unknown): ${unknown}`);

  const owners = new Set(edges.filter((e) => e.owner).map((e) => e.owner));
  const perOwner = new Map();
  for (const e of removed) perOwner.set(e.owner, (perOwner.get(e.owner) || 0) + 1);
  const counts = [...perOwner.values()].sort((a, b) => b - a);
  console.log(`\nStudents with links: ${owners.size}`);
  console.log(`Students who removed at least one link: ${perOwner.size}`);
  console.log(`Removals per student, largest first: ${counts.join(", ") || "-"}`);
  console.log(`  median ${median(counts) ?? "-"}, max ${counts[0] ?? "-"}, largest student's share ${pct(counts[0] || 0, removed.length)}`);
  const linksPerOwner = [...owners].map((o) => edges.filter((e) => e.owner === o && typeOf(e) !== "rejected").length);
  console.log(`Links per student (not counting rejected pairs): median ${median(linksPerOwner) ?? "-"}, max ${Math.max(0, ...linksPerOwner)}`);

  const same = edges.filter((e) => typeOf(e) === "same-subject");
  const cross = edges.filter((e) => typeOf(e) === "cross-subject");
  const row = (name, xs) => [name, xs.length, xs.filter(isRemoved).length];
  table("By link type", [
    row("same-subject", same),
    row("cross-subject, by meaning", cross.filter((e) => num(e.meaning) !== null)),
    row("cross-subject, TF-IDF", cross.filter((e) => num(e.meaning) === null)),
    row("rejected (never linked)", edges.filter((e) => typeOf(e) === "rejected")),
  ]);
  table("Same-subject links by TF-IDF similarity (below 0.11: made under an older rule)", byBand(same, (e) => num(e.weight), SAME_BANDS));
  table("Cross-subject links by meaning (embedding similarity)", byBand(cross.filter((e) => num(e.meaning) !== null), (e) => num(e.meaning), MEANING_BANDS));
  table("Cross-subject links without meaning, by TF-IDF similarity", byBand(cross.filter((e) => num(e.meaning) === null), (e) => num(e.weight), CROSS_TFIDF_BANDS));
  const sharedBand = (e) => {
    const n = (e.sharedKeywords || []).length;
    return n >= 3 ? "3+" : String(n);
  };
  for (const [name, group] of [["Same-subject", same], ["Cross-subject", cross]]) {
    table(`${name} links by shared top words`, ["0", "1", "2", "3+"].map((b) => row(`${b} shared`, group.filter((e) => sharedBand(e) === b))));
  }

  const dates = removed.map((e) => e.correctedAt).filter(Boolean).map((d) => new Date(d).getTime()).sort((a, b) => a - b);
  console.log(`\nRemovals dated: ${dates.length} of ${removed.length}, from ${day(dates[0])} to ${day(dates.at(-1))}`);
  const byMonth = new Map();
  for (const t of dates) {
    const m = new Date(t).toISOString().slice(0, 7);
    byMonth.set(m, (byMonth.get(m) || 0) + 1);
  }
  for (const [m, n] of byMonth) console.log(`  ${m}: ${n}`);
  console.log("\nRestored links are not recorded: a restore clears the correction, so they count as never removed.");
} catch (err) {
  console.error(`correction-counts failed: ${err.message}`);
  process.exitCode = 1;
}
