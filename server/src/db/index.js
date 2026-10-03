import path from "path";
import { fileURLToPath } from "url";
import { createMemoryDb } from "./memoryStore.js";
import { createMongoDb } from "./mongoStore.js";

let dbInstance = null;

// Where the local database lives when no MONGODB_URI is set. Override with
// DB_FILE=/some/path.json, or DB_FILE=memory for a throwaway database that is
// wiped on every restart (handy for automated tests).
const DEFAULT_DB_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/mindatlas-db.json");

export async function connectDB() {
  const uri = process.env.MONGODB_URI?.trim();

  if (uri) {
    console.log("[db] connecting to configured MONGODB_URI");
    dbInstance = await createMongoDb(uri);
    console.log("[db] connected to MongoDB");
    return;
  }

  if (process.env.NODE_ENV === "production") {
    console.warn(
      "\n[db] WARNING: NODE_ENV=production but MONGODB_URI is not set. Accounts and notes are being\n" +
        "[db] stored on this server's own disk, which hosts like Render wipe on every deploy, restart\n" +
        "[db] and idle spin-down - users will find their account gone and have to sign up again.\n" +
        "[db] Set MONGODB_URI (MongoDB Atlas) in the host's environment settings.\n"
    );
  }

  const setting = process.env.DB_FILE?.trim();
  if (setting && setting.toLowerCase() === "memory") {
    console.log("[db] DB_FILE=memory - using an in-memory database (data resets on every restart)");
    dbInstance = createMemoryDb({ file: null });
    return;
  }

  const file = setting ? path.resolve(setting) : DEFAULT_DB_FILE;
  dbInstance = createMemoryDb({ file });
  const counts = ["users", "notes"].map((c) => `${dbInstance.collection(c).docs.size} ${c}`).join(", ");
  console.log(
    `[db] no MONGODB_URI set - using the local database file ${file} (${counts}). ` +
      "Data is kept between restarts; set MONGODB_URI in server/.env to use MongoDB Atlas instead."
  );
}

/**
 * Write any pending changes to the local database file now (no-op for
 * MongoDB). Called before each write request's response is sent, so once the
 * browser sees "saved", the data really is on disk - even if the server is
 * killed a moment later.
 */
export function flushDB() {
  if (dbInstance?.flush) dbInstance.flush();
}

/** Which database is in use, for /api/health: kind and whether data survives restarts. */
export function dbInfo() {
  if (!dbInstance) return { kind: "none", persistent: false };
  if (dbInstance.kind === "mongo") return { kind: "mongodb", persistent: true };
  if (dbInstance.kind === "file")
    return { kind: "local-file", persistent: process.env.NODE_ENV !== "production", file: dbInstance.file };
  return { kind: "memory", persistent: false };
}

export function getCollection(name) {
  if (!dbInstance) throw new Error("Database not connected yet - call connectDB() first");
  return dbInstance.collection(name);
}

export async function disconnectDB() {
  if (dbInstance) await dbInstance.close();
  dbInstance = null;
}
