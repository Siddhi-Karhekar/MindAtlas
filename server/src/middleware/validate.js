// Checking what a request sent before anything uses it.
//
// Nothing from a request is trusted to be the type, the size or the shape the
// client code would send: a field can be missing, an object where text is
// expected, or megabytes long. Each route reads its fields through these
// helpers, which either return a clean value or throw an InputError - a 400
// with a message that says what was wrong (caught by safeRouter and answered
// by the error handler in index.js).

/** A problem with the request itself: answered with its message, never logged as a server fault. */
export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

/** Every record id is 24 hexadecimal characters (db/ids.js). */
export const isId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

// Limits, in characters. Generous for real use, small enough that no field
// can be used to fill the database or stall a request.
export const LIMITS = {
  email: 254, // the longest address the mail standards allow
  password: 72, // bcrypt reads no further than 72 bytes
  title: 200,
  subjectName: 100,
  noteText: 400_000, // about 60,000 words
  answer: 6_000,
  idsPerRequest: 200,
};

/**
 * A text field. Returns the (trimmed) string, or `fallback` when the field is
 * absent and not `required`.
 */
export function text(value, name, { min = 1, max = LIMITS.title, required = true, trim = true, fallback = "" } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new InputError(`${name} is required`);
    return fallback;
  }
  if (typeof value !== "string") throw new InputError(`${name} must be text`);
  const out = trim ? value.trim() : value;
  if (out.length < min) throw new InputError(min <= 1 ? `${name} is required` : `${name} must be at least ${min} characters`);
  if (out.length > max) throw new InputError(`${name} is too long - the limit is ${max.toLocaleString("en-GB")} characters`);
  return out;
}

/** A whole number within [min, max]; `fallback` when absent. Numeric text ("5") is accepted, as forms send it. */
export function integer(value, name, { min, max, fallback } = {}) {
  if (value === undefined || value === null || value === "") {
    if (fallback === undefined) throw new InputError(`${name} is required`);
    return fallback;
  }
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n)) throw new InputError(`${name} must be a whole number`);
  if (n < min || n > max) throw new InputError(`${name} must be between ${min} and ${max}`);
  return n;
}

/** A record id. */
export function id(value, name) {
  if (!isId(value)) throw new InputError(`${name} is not a valid id`);
  return value;
}

/** A non-empty list of distinct record ids. */
export function idList(value, name, { max = LIMITS.idsPerRequest } = {}) {
  if (!Array.isArray(value) || value.length === 0) throw new InputError(`${name} must be a non-empty list of ids`);
  if (value.length > max) throw new InputError(`${name} can hold at most ${max} ids`);
  if (!value.every(isId)) throw new InputError(`${name} must contain only ids`);
  return [...new Set(value)];
}

/** One of a fixed set of words. */
export function oneOf(value, name, options) {
  if (typeof value !== "string" || !options.includes(value)) throw new InputError(`${name} must be ${options.map((o) => `"${o}"`).join(" or ")}`);
  return value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** An email address, trimmed and lower-cased (how accounts are looked up). */
export function email(value, name = "email") {
  const out = text(value, name, { max: LIMITS.email }).toLowerCase();
  if (!EMAIL.test(out)) throw new InputError("enter a valid email address");
  return out;
}

// ---------------------------------------------------------------------------
// The shape of the whole request
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Walks a parsed body. A key starting with "$" or containing "." is how a
// database operator is smuggled into a query ({"email": {"$ne": null}}); the
// three names above are how an object's prototype is tampered with. No
// request to this API has a reason to send either.
function findBadKey(value, depth = 0) {
  if (value === null || typeof value !== "object") return null;
  if (depth > 8) return "(too deeply nested)";
  if (Array.isArray(value)) {
    for (const v of value) {
      const bad = findBadKey(v, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("$") || k.includes(".") || FORBIDDEN_KEYS.has(k)) return k;
    const bad = findBadKey(v, depth + 1);
    if (bad) return bad;
  }
  return null;
}

/**
 * Middleware for every /api request: the body must be a plain JSON object (or
 * absent), free of operator keys; query parameters must be plain text.
 */
export function checkRequestShape(req, res, next) {
  const body = req.body;
  if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) {
    return res.status(400).json({ error: "the request body must be a JSON object" });
  }
  const bad = findBadKey(body);
  if (bad) return res.status(400).json({ error: `"${String(bad).slice(0, 40)}" is not an allowed field name` });
  for (const [k, v] of Object.entries(req.query || {})) {
    if (typeof v !== "string") return res.status(400).json({ error: `the "${String(k).slice(0, 40)}" parameter must be given once, as plain text` });
  }
  next();
}

/** The fields of a multipart form (alongside an uploaded file) must be short plain text. */
export function checkFormFields(body) {
  for (const [k, v] of Object.entries(body || {})) {
    if (typeof v !== "string") throw new InputError(`the "${String(k).slice(0, 40)}" field must be plain text`);
    if (k.startsWith("$") || k.includes(".") || FORBIDDEN_KEYS.has(k)) throw new InputError(`"${String(k).slice(0, 40)}" is not an allowed field name`);
  }
}
