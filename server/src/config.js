// Settings read from the environment, in one place, for the parts of the
// server that have to agree with each other (CORS, the origin check, cookies,
// links in emails).

export const isProduction = () => process.env.NODE_ENV === "production";

/** The browser origins allowed to call this API from another address. */
export function allowedOrigins() {
  const configured = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (configured.length) return configured;
  // Unset: the local Vite dev server outside production, nobody in production.
  return isProduction() ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"];
}

/**
 * The address of the web app, for links in emails. Never taken from the
 * request: a forged Host header would otherwise put an attacker's address
 * into a password-reset email. APP_URL wins; otherwise the first allowed
 * origin (a separately hosted client), then the address Render gives the
 * service, then the local dev server.
 */
export function appUrl() {
  const url = process.env.APP_URL?.trim() || allowedOrigins()[0] || process.env.RENDER_EXTERNAL_URL?.trim() || "http://localhost:5173";
  return url.replace(/\/+$/, "");
}

/** True when the web app's address comes from a setting, not from the local-development default. */
export const hasKnownAppUrl = () => Boolean(process.env.APP_URL?.trim() || allowedOrigins()[0] || process.env.RENDER_EXTERNAL_URL?.trim());

/**
 * The accounts that may open the admin page: ADMIN_USER_IDS, a comma-separated
 * list of account ids (shown on each student's Settings page). Ids, not email
 * addresses: an address can be signed up by anyone before its owner, an id
 * only exists once the account does.
 */
export const adminIds = () =>
  (process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{24}$/.test(s));

/** Where students can write for help or with a complaint (SUPPORT_EMAIL), if set. */
export const supportEmail = () => {
  const e = (process.env.SUPPORT_EMAIL || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

/** A positive number from the environment, or the default. */
export const envNumber = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
