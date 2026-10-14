// Relink the knowledge graph: recompute notes' keywords and links with the
// current rules. What changes and what is kept: services/relink.js.
//
//   npm run relink -- --email student@example.com   dry run for one student: shows what would change
//   npm run relink -- --all                         dry run for every student
//   add --yes to write the changes
//
// Which database:
//   - by default, the one the server itself would use: MONGODB_URI, or the
//     local file database (server/data/mindatlas-db.json). Stop the local
//     server first - it holds that file in memory, and its next save would
//     put the old links back.
//   - with --live, the live database at ATLAS_URI (see db-backup.mjs). Before
//     --live --yes writes anything, it needs a backup of that database from
//     the last 24 hours in server/backups/: run `npm run db:backup` first.
//
// Run it after a change to the keyword or linking rules (tfidf.js,
// graphEngine.js) is deployed, so notes saved before it follow it too.
//
// Cross-subject links by meaning need each topic's sentence embedding, made
// by the optional model (`npm run semantic:install`). Where the model is
// installed, the relink makes the missing ones and stores them, and the
// server then uses the stored vectors even if it has no model itself. Where
// it is not, those pairs are linked by TF-IDF, as before.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connectDB, disconnectDB } from "../src/db/index.js";
import { findUserByEmail, findUsersSince } from "../src/models/User.js";
import { getEmbedder, semanticStatus } from "../src/services/embeddings.js";
import { relinkOwner } from "../src/services/relink.js";

const BACKUP_MAX_AGE_HOURS = 24;
const BACKUPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../backups");
const USAGE = "usage: npm run relink -- (--email <address> | --all) [--live] [--yes]";

const args = process.argv.slice(2);
const emailAt = args.indexOf("--email");
const email = emailAt >= 0 ? (args[emailAt + 1] || "").trim().toLowerCase() : "";
const all = args.includes("--all");
const live = args.includes("--live");
const write = args.includes("--yes");
const unknown = args.filter((a, i) => !["--email", "--all", "--live", "--yes"].includes(a) && (emailAt < 0 || i !== emailAt + 1));

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (unknown.length) stop(`unknown option ${unknown.join(" ")}\n${USAGE}`);
if (Boolean(email) === all) stop(`give either --email <address> or --all\n${USAGE}`);

// The newest backup in server/backups/ of `host`, if it is recent enough.
function recentBackup(host) {
  const cutoff = Date.now() - BACKUP_MAX_AGE_HOURS * 3600_000;
  const folders = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).sort().reverse() : [];
  for (const folder of folders) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(BACKUPS, folder, "manifest.json"), "utf8"));
      if (manifest.host === host && Date.parse(manifest.takenAt) >= cutoff) return folder;
    } catch {
      // not a backup folder
    }
  }
  return null;
}

if (live) {
  const uri = (process.env.ATLAS_URI || "").trim();
  if (!uri) stop("--live needs ATLAS_URI in server/.env (see DEPLOY.md, 'Backups').");
  const host = uri.replace(/^mongodb(\+srv)?:\/\/[^@]*@/, "").split(/[/?]/)[0];
  if (write) {
    const backup = recentBackup(host);
    if (!backup) stop(`No backup of ${host} from the last ${BACKUP_MAX_AGE_HOURS} hours in server/backups/. Run \`npm run db:backup\` first.`);
    console.log(`Backup found: backups/${backup}`);
  }
  process.env.MONGODB_URI = uri; // what connectDB() reads
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const types = (counts) => `${counts["same-subject"]} same-subject, ${counts["cross-subject"]} cross-subject, ${counts.rejected} rejected`;

try {
  await connectDB();
  const owners = email ? [await findUserByEmail(email)] : await findUsersSince(new Date(0)); // every account
  if (!owners[0] && email) stop(`No account with the email ${email}.`);

  console.log(write ? "\nRelinking - changes are written.\n" : "\nDry run - nothing is written. Add --yes to apply these changes.\n");
  // a batch job can wait for the model to load
  const embedder = await getEmbedder({ waitMs: 180_000 });
  console.log(
    embedder
      ? `Embedding model: ${embedder.model} - cross-subject pairs are linked by meaning.\n`
      : `No embedding model (${semanticStatus().reason}) - cross-subject pairs are linked by TF-IDF, except where both notes already have a stored embedding.\n`
  );
  const total = { students: 0, notes: 0, keywordsChanged: 0, kept: 0, updated: 0, added: 0, dropped: 0, removedKept: 0, dangling: 0, embeddingsMade: 0, embeddingsDropped: 0 };
  for (const owner of owners) {
    const r = await relinkOwner(owner._id, { dryRun: !write, embedder });
    if (r.notes === 0) continue;
    for (const k of Object.keys(total)) total[k] += k === "students" ? 1 : r[k];
    console.log(`${owner.email}: ${plural(r.notes, "note")} (${plural(r.topics, "topic")}), keywords change on ${r.keywordsChanged}`);
    console.log(`  links before: ${types(r.before)}`);
    console.log(`  links after:  ${types(r.after)}`);
    console.log(
      `  kept ${r.kept}, updated ${r.updated}, added ${r.added}, dropped ${r.dropped};` +
        ` removed by the student, left removed: ${r.removedKept}; links to deleted notes: ${r.dangling}`
    );
    console.log(
      `  embeddings: ${r.embedded} of ${plural(r.topics, "topic")}, ${r.embeddingsMade} ${write ? "made" : "to make"};` +
        ` of deleted notes: ${r.embeddingsDropped}`
    );
  }
  console.log(
    `\n${plural(total.students, "student")}, ${plural(total.notes, "note")}: keywords change on ${total.keywordsChanged};` +
      ` links kept ${total.kept}, updated ${total.updated}, added ${total.added}, dropped ${total.dropped},` +
      ` removed by students ${total.removedKept}, to deleted notes ${total.dangling};` +
      ` embeddings ${write ? "made" : "to make"} ${total.embeddingsMade}, of deleted notes ${total.embeddingsDropped}.`
  );
} catch (err) {
  console.error("Relink failed:", String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/g, "[uri hidden]"));
  process.exitCode = 1;
} finally {
  await disconnectDB();
}
