import { generateId } from "./ids.js";

// Zero-setup dev database: a plain in-memory Map per collection, exposing
// just the handful of MongoDB-shaped operations the app actually uses
// (insertOne / findOne / find / findOneAndUpdate). This exists because the
// usual "spin up a throwaway MongoDB for tests" package
// (mongodb-memory-server) needs to download a real mongod binary from
// mongodb.org on first run, which this sandbox's network allowlist blocks.
// Swap to a real MongoDB Atlas cluster any time by setting MONGODB_URI -
// see mongoStore.js, which implements this exact same interface.

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
  constructor() {
    this.docs = new Map();
  }

  async insertOne(doc) {
    const _id = doc._id || generateId();
    const record = { ...doc, _id };
    this.docs.set(_id, record);
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
    return { ...existing };
  }
}

export function createMemoryDb() {
  const collections = new Map();
  return {
    kind: "memory",
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection());
      return collections.get(name);
    },
    async close() {},
  };
}
