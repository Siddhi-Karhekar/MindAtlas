// The one shape a database filter may have.
//
// Every filter in this app is "field equals value" or "field is one of these
// values". Both stores build their query from the filter's values, so a value
// that is an object would be read by MongoDB as an OPERATOR: a login looking
// up { email: { $ne: null } } matches the first account there is. Requests
// are checked before they get this far (middleware/validate.js); this is the
// second lock, at the last point before the database, and it holds whatever
// route forgot to validate: a filter value may be a plain value, a list of
// plain values, or { $in: [plain values] } - nothing else.

// `undefined` is not among them: MongoDB would match it as "missing or null"
// and the in-memory store as the text "undefined", and either way it means a
// caller looked something up by a value it never had.
const isPlain = (v) => v === null || ["string", "number", "boolean"].includes(typeof v) || v instanceof Date;

/** The values `field` may equal as a list, or null for a single-value match. Throws on anything else. */
export function candidatesOf(field, value) {
  if (isPlain(value)) return null;
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Object.keys(value).length === 1 && Array.isArray(value.$in)
      ? value.$in
      : undefined;
  if (!list || !list.every(isPlain)) throw new Error(`unsafe database filter on "${field}": only plain values and lists of plain values are allowed`);
  return list;
}

/** Checks a whole filter; returns it for chaining. */
export function assertSafeFilter(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("a database filter must be an object");
  for (const [field, value] of Object.entries(filter)) {
    if (field.startsWith("$")) throw new Error(`unsafe database filter: operator "${field}" is not allowed`);
    candidatesOf(field, value);
  }
  return filter;
}
