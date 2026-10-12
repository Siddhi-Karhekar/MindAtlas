// Put a backup made by db-backup.mjs back into a MongoDB database.
//
//   npm run db:restore -- backups/mindatlas-<time>            (dry run: shows what would change)
//   npm run db:restore -- backups/mindatlas-<time> --yes      (does it)
//
// Target: RESTORE_URI if set, otherwise ATLAS_URI (server/.env or the
// environment). For every collection in the backup, the target collection is
// EMPTIED and refilled with the backed-up documents; collections that are not
// in the backup are left alone. Without --yes nothing is written.
//
// Restoring the live site overwrites everything students did since the
// backup. Take a fresh backup first (npm run db:backup), and tell the team.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { MongoClient, BSON } from "mongodb";

const DB_NAME = "mindatlas";
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const confirmed = args.includes("--yes");
const uri = (process.env.RESTORE_URI || process.env.ATLAS_URI || "").trim();

if (!dir || !fs.existsSync(path.join(dir, "manifest.json"))) {
  console.error("Usage: npm run db:restore -- <backup folder with manifest.json> [--yes]");
  process.exit(1);
}
if (!uri) {
  console.error("Set RESTORE_URI (or ATLAS_URI) to the database to restore into.");
  process.exit(1);
}
const host = uri.replace(/^mongodb(\+srv)?:\/\/[^@]*@/, "").split(/[/?]/)[0];
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
try {
  await client.connect();
  const db = client.db(DB_NAME);
  console.log(`Backup taken ${manifest.takenAt} from ${manifest.host}`);
  console.log(`Target: ${host} / ${DB_NAME}${confirmed ? "" : "   (DRY RUN - add --yes to write)"}\n`);
  console.log(`  ${"collection".padEnd(22)} ${"now".padStart(6)}  ->  ${"backup".padStart(6)}`);
  for (const [name, count] of Object.entries(manifest.counts)) {
    const now = await db.collection(name).countDocuments();
    console.log(`  ${name.padEnd(22)} ${String(now).padStart(6)}  ->  ${String(count).padStart(6)}`);
    if (!confirmed) continue;
    const docs = BSON.EJSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"), { relaxed: false });
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: true });
  }
  console.log(confirmed ? "\nRestore complete." : "\nNothing written. Re-run with --yes to restore.");
} catch (err) {
  console.error("Restore failed:", err.codeName || err.name, "-", String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/g, "[uri hidden]"));
  process.exitCode = 1;
} finally {
  await client.close();
}
