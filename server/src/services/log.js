// What goes into the server's logs. Logs are read by whoever runs the
// hosting, kept for weeks and sometimes pasted into chats when debugging, so
// they must not carry what students wrote (notes, answers) or who they are
// (email addresses). Errors are logged as their kind and a short, cleaned
// message; anything that looks like an email address is masked.

const EMAIL = /[^\s@"'<>(){}[\],;:]+@[^\s@"'<>(){}[\],;:]+\.[^\s@"'<>(){}[\],;:]+/g;

/** Text made safe for a log line: email addresses masked, length capped. */
export function redact(text, max = 300) {
  const s = String(text ?? "").replace(EMAIL, "[email]");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Log an error without its data: name, code and cleaned message, plus where
 * in the code it happened (stack frames are file paths, not user data).
 */
export function logError(label, err) {
  const name = err?.name || "Error";
  const code = err?.code !== undefined ? ` [${err.code}]` : "";
  const where = String(err?.stack || "")
    .split("\n")
    .slice(1, 4)
    .map((l) => l.trim())
    .join(" | ");
  console.error(`${label} ${name}${code}: ${redact(err?.message)}${where ? `  (${redact(where, 400)})` : ""}`);
}
