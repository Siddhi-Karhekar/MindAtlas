// Sending email: the link that confirms an address and the link that resets
// a password.
//
// Email is OFF until the server is given an account to send from. Nothing
// else in the app depends on it: with email off, accounts work as they did
// before (no confirmation asked, no "forgot password").
//
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   any mail provider's SMTP
//                    details. Free ones work: a Gmail account with an "app
//                    password" (smtp.gmail.com, port 465), or Brevo.
//   MAIL_FROM        the From line, e.g. "Mind Atlas <you@gmail.com>"
//   APP_URL          the web app's address, for the links (see config.js)
//   EMAIL_MODE=log   for development: "send" by printing the message to the
//                    server's console instead. Refused in production, where
//                    it would write reset links into the host's logs.
//
// nodemailer is loaded on first use, so it costs nothing until then.

import { hasKnownAppUrl, isProduction } from "../config.js";

let transport = null;

/** { enabled, mode } - mode is "smtp", "log" or "off". */
let warnedNoUrl = false;
export function mailStatus() {
  if (process.env.SMTP_HOST?.trim()) {
    // The links in the emails need the web app's address. In production that
    // has to be known for certain (config.js), or a reset link would point
    // at the developer's own machine: email stays off until it is.
    if (isProduction() && !hasKnownAppUrl()) {
      if (!warnedNoUrl) console.warn("[mail] SMTP is set up but the web app's address is not known - set APP_URL. Email stays off until then.");
      warnedNoUrl = true;
      return { enabled: false, mode: "off" };
    }
    return { enabled: true, mode: "smtp" };
  }
  if (String(process.env.EMAIL_MODE || "").trim().toLowerCase() === "log" && !isProduction()) return { enabled: true, mode: "log" };
  return { enabled: false, mode: "off" };
}

async function smtp() {
  if (transport) return transport;
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT) || 587;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST.trim(),
    port,
    secure: port === 465, // 465 is TLS from the first byte; other ports upgrade with STARTTLS
    // refuse to send a password over a connection that could not be encrypted,
    // unless told this is a local test server (SMTP_ALLOW_PLAIN=1)
    requireTLS: port !== 465 && process.env.SMTP_ALLOW_PLAIN !== "1",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transport;
}

/** Tests only: forget the cached connection after the environment changed. */
export function resetMailer() {
  transport = null;
}

/**
 * Send one message. Throws if it could not be handed to the mail server; the
 * caller decides what the student is told.
 */
export async function sendMail({ to, subject, text }) {
  const { mode } = mailStatus();
  if (mode === "off") throw new Error("email is not set up on this server");
  const from = process.env.MAIL_FROM?.trim() || process.env.SMTP_USER || "Mind Atlas <no-reply@localhost>";
  if (mode === "log") {
    console.log(`[mail] to ${to} | ${subject}\n${text}\n[mail] end`);
    return;
  }
  await (await smtp()).sendMail({ from, to, subject, text });
}
