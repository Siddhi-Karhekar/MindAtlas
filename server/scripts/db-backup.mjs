// Back up the live MongoDB Atlas database to local JSON files.
//
//   npm run db:backup
//
// Reads the connection string from ATLAS_URI (in server/.env or the
// environment). ATLAS_URI is deliberately NOT the variable the server reads
// (MONGODB_URI), so keeping it in your local .env never points local dev at
// the live database. Writes server/backups/mindatlas-<UTC time>/ with one
// <collection>.json per collection (Extended JSON, so dates survive) and a
// manifest.json with the counts. server/backups/ is git-ignored: it holds
// every student's data, never commit it.
//
// Atlas M0 (free) has no automatic backups - run this before anything that
// rewrites data on the live site (e.g. the relink tool), and see
// db-restore.mjs to put a backup back.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient, BSON } from "mongodb";

const DB_NAME = "mindatlas"; // the app always uses this database (src/db/mongoStore.js)
const uri = (process.env.ATLAS_URI || "").trim();
if (!uri) {
  console.error("ATLAS_URI is not set. Add ATLAS_URI=mongodb+srv://... to server/.env (see DEPLOY.md, 'Backups').");
  process.exit(1);
}
const host = uri.replace(/^mongodb(\+srv)?:\/\/[^@]*@/, "").split(/[/?]/)[0];

const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..+/, "Z");
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../backups", `${DB_NAME}-${stamp}`);

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
try {
  await client.connect();
  const db = client.db(DB_NAME);
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  fs.mkdirSync(outDir, { recursive: true });

  const counts = {};
  for (const name of collections) {
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(outDir, `${name}.json`), BSON.EJSON.stringify(docs, { relaxed: false }));
    counts[name] = docs.length;
    console.log(`  ${name.padEnd(22)} ${docs.length}`);
  }
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ database: DB_NAME, host, takenAt: new Date().toISOString(), counts }, null, 2)
  );
  console.log(`\nBacked up ${collections.length} collections from ${host} to\n  ${outDir}`);
} catch (err) {
  console.error("Backup failed:", err.codeName || err.name, "-", String(err.message).replace(/mongodb(\+srv)?:\/\/\S+/g, "[uri hidden]"));
  process.exitCode = 1;
} finally {
  await client.close();
}
