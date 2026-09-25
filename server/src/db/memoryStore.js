import fs from "fs";
import path from "path";
import { generateId } from "./ids.js";

// Zero-setup dev database: a plain in-memory Map per collection, exposing
// just the handful of MongoDB-shaped operations the app actually uses
// (insertOne / findOne / find / findOneAndUpdate). This exists because the
// usual "spin up a throwaway MongoDB for tests" package
// (mongodb-memory-server) needs to download a real mongod binary from
// mongodb.org on first run, which this sandbox's network allowlist blocks.
// Swap to a real MongoDB Atlas cluster any time by setting MONGODB_URI -
// see mongoStore.js, which implements this exact same interface.
//
// PERSISTENCE: by default the whole database is also saved to a JSON file
// (server/data/mindatlas-db.json) and loaded again on start, so accounts,
// notes, tests and progress survive closing the server. Before this, every
// restart wiped everything - users could not log back in and their notes
// were gone. Writes are batched (a short debounce) and written atomically
// (temp file + rename), and flushed synchronously when the process exits.
// Pass `file: null` for a throwaway in-memory database.

// A filter value that's an array (or an explicit {$in: [...]}) matches if
// the doc's field equals any element - the same shorthand real MongoDB
// filters use, kept minimal since this store only ever needs equality/$in.
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    const candidates = Array.isArray(v) ? v : v && typeof v === "object" && "$in" in v ? v.$in : null;
    if (candidates) return candidates.some((c) => String(doc[k]) === String(c));
    return String(doc[k]) === String(v);
  });
}

class MemoryCollection {
  constructor(onChange = () => {}) {
    this.docs = new Map();
    this.onChange = onChange;
  }

  async insertOne(doc) {
    const _id = doc._id || generateId();
    const record = { ...doc, _id };
    this.docs.set(_id, record);
    this.onChange();
    return { ...record };
  }

  async findOne(filter) {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) return { ...doc };
    }
    return null;
  }

  async find(filter = {}, { sort } = {}) {
    let results = [...this.docs.values()]
      .filter((d) => matches(d, filter))
      .map((d) => ({ ...d }));

    if (sort) {
      const [field, dir] = Object.entries(sort)[0];
      results.sort((a, b) => {
        if (a[field] === b[field]) return 0;
        return (a[field] > b[field] ? 1 : -1) * dir;
      });
    }
    return results;
  }

  async findOneAndUpdate(filter, update, { upsert = false } = {}) {
    let existing = null;
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) {
        existing = doc;
        break;
      }
    }
    if (!existing) {
      if (!upsert) return null;
      existing = { _id: generateId(), ...filter };
      this.docs.set(existing._id, existing);
    }
    if (update.$set) Object.assign(existing, update.$set);
    this.onChange();
    return { ...existing };
  }
}

// JSON has no Date type: dates are saved as ISO strings and turned back into
// Date objects on load, so createdAt/updatedAt behave exactly as before.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const reviveDates = (key, value) => (typeof value === "string" && ISO_DATE.test(value) ? new Date(value) : value);

function loadFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"), reviveDates) || {};
  } catch (err) {
    // Never silently start empty over a file we couldn't read - that would
    // overwrite the student's data on the next save. Keep a copy aside.
    const backup = `${file}.corrupt-${Date.now()}`;
    fs.copyFileSync(file, backup);
    console.error(`[db] could not read ${file} (${err.message}); saved a copy as ${backup} and started empty`);
    return {};
  }
}

/**
 * Create the dev database. With `file` set (the default from db/index.js) it
 * is loaded from and saved to that JSON file; with `file: null` it lives in
 * memory only.
 */
export function createMemoryDb({ file = null, saveDelayMs = 150 } = {}) {
  const collections = new Map();
  let timer = null;
  let dirty = false;

  function snapshot() {
    const out = {};
    for (const [name, col] of collections) out[name] = [...col.docs.values()];
    return out;
  }

  function saveNow() {
    if (!file || !dirty) return;
    clearTimeout(timer);
    timer = null;
    dirty = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(snapshot());
    fs.writeFileSync(tmp, json);
    try {
      fs.renameSync(tmp, file); // atomic replace: a crash mid-write can't corrupt the real file
    } catch {
      // Windows can briefly lock the target (antivirus, search indexer);
      // fall back to writing it directly rather than losing the save.
      fs.writeFileSync(file, json);
      fs.rmSync(tmp, { force: true });
    }
  }

  function scheduleSave() {
    if (!file) return;
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => {
        try {
          saveNow();
        } catch (err) {
          console.error("[db] failed to save:", err.message);
        }
      }, saveDelayMs);
    }
  }

  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new MemoryCollection(scheduleSave));
    return collections.get(name);
  };

  // load
  const saved = loadFile(file);
  for (const [name, docs] of Object.entries(saved)) {
    const col = getCollection(name);
    for (const d of docs || []) if (d && d._id) col.docs.set(String(d._id), d);
  }

  // Flush pending writes when the server stops: Ctrl+C, closing the terminal
  // window (SIGHUP on Windows), a normal exit, or a kill.
  if (file) {
    const flush = () => {
      try {
        saveNow();
      } catch (err) {
        console.error("[db] failed to save on exit:", err.message);
      }
    };
    process.on("exit", flush);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
      process.once(sig, () => {
        flush();
        process.exit(0);
      });
    }
  }

  return {
    kind: file ? "file" : "memory",
    file,
    collection: getCollection,
    flush: saveNow,
    async close() {
      saveNow();
    },
  };
}
