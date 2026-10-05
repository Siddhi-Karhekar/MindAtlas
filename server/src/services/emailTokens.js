// One-time links sent by email: confirm an address, reset a password.
//
// The link carries a long random token, after a "#": that part of an address
// stays in the browser and is never sent to the server that hosts the page,
// so the token does not end up in a web host's access logs. Only its SHA-256 hash is stored, so
// reading the database does not give anyone a working link. A token works
// once, for one purpose, for a limited time, and asking for a new one cancels
// the old one.

import crypto from "node:crypto";
import { getCollection } from "../db/index.js";
import { appUrl } from "../config.js";
import { sendMail } from "./mailer.js";

const tokens = () => getCollection("email_tokens");
const LIFETIME_MS = { verify: 24 * 60 * 60_000, reset: 30 * 60_000 };
const hashOf = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** A new token for this user and purpose ("verify" | "reset"); earlier ones stop working. */
export async function issueToken(userId, purpose) {
  await tokens().deleteMany({ userId: String(userId), purpose });
  const token = crypto.randomBytes(32).toString("base64url");
  await tokens().insertOne({ userId: String(userId), purpose, tokenHash: hashOf(token), expiresAt: new Date(Date.now() + LIFETIME_MS[purpose]), createdAt: new Date() });
  return token;
}

/** The stored record of a link that would still work for this purpose, or null. Does not use it up. */
export async function findToken(token, purpose) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const row = await tokens().findOne({ tokenHash: hashOf(token), purpose });
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) return null;
  return row;
}

/** Use a link up: it never works again. True for the one caller that used it; false if it was already gone. */
export const consumeToken = async (row) => (await tokens().deleteMany({ tokenHash: row.tokenHash })) === 1;

/** Cancel every outstanding link of an account (its password changed). */
export const cancelTokens = (userId, purpose) => tokens().deleteMany({ userId: String(userId), purpose });

/** When the last token of this purpose was issued to the user, or null. Used to space out emails. */
export async function lastIssuedAt(userId, purpose) {
  const row = await tokens().findOne({ userId: String(userId), purpose });
  return row ? new Date(row.createdAt).getTime() : null;
}

export async function sendVerificationEmail(user) {
  const link = `${appUrl()}/verify-email#token=${await issueToken(user._id, "verify")}`;
  await sendMail({
    to: user.email,
    subject: "Confirm your email for Mind Atlas",
    text: `Welcome to Mind Atlas.\n\nConfirm that this is your email address by opening this link:\n\n${link}\n\nThe link works once and for 24 hours. If you did not create a Mind Atlas account, ignore this email - nothing will happen.`,
  });
}

export async function sendResetEmail(user) {
  const link = `${appUrl()}/reset-password#token=${await issueToken(user._id, "reset")}`;
  await sendMail({
    to: user.email,
    subject: "Reset your Mind Atlas password",
    text: `Someone asked to reset the password of the Mind Atlas account for this address.\n\nTo choose a new password, open this link:\n\n${link}\n\nThe link works once and for 30 minutes. If it was not you, ignore this email - your password stays as it is.`,
  });
}
