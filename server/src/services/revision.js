// Coming back: a streak of days with a finished test, and the topics worth
// revising next. Both are worked out from what is already stored (attempts
// and mastery); nothing extra is tracked about the student.

import { MIN_OBSERVATIONS_FOR_VERDICT } from "./masteryEngine.js";

// A topic is due for revision when the student has shown it is shaky (below
// this mastery, on enough answers to say so), or when it was last practised
// this many days ago - knowledge fades without retrieval practice.
export const SHAKY_BELOW = 0.6;
export const STALE_AFTER_DAYS = 7;
const DAY = 86_400_000;

/** The calendar day of `date` in `timeZone` (an IANA name such as Asia/Kolkata), as YYYY-MM-DD. */
export function dayIn(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return new Date(date).toISOString().slice(0, 10); // unknown zone name
  }
}

/**
 * Consecutive days, up to today, on which the student finished a test. A
 * streak still counts if today has none yet but yesterday did: the day is not
 * over. Returns { days, today } - `today` says whether today already counts.
 */
export function streakOf(submittedDates, { now = new Date(), timeZone = "UTC" } = {}) {
  const days = new Set(submittedDates.map((d) => dayIn(new Date(d), timeZone)));
  const today = dayIn(now, timeZone);
  // step back one calendar date at a time (on the date itself, not by 24
  // hours, which skips or repeats a day when the clocks change)
  const before = (ymd) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  };
  let cursor = days.has(today) ? today : before(today);
  let count = 0;
  for (let i = 0; i < 3660 && days.has(cursor); i++) {
    count += 1;
    cursor = before(cursor);
  }
  return { days: count, today: days.has(today) };
}

/**
 * Topics to revise, most urgent first: shaky ones (lowest mastery first),
 * then ones not practised for a week (longest ago first). Only topics with
 * enough answers to judge are called shaky; any tested topic can go stale.
 */
export function dueTopics(masteryRows, { now = new Date(), limit = 5 } = {}) {
  const due = [];
  for (const m of masteryRows) {
    const daysSince = Math.floor((now.getTime() - new Date(m.updatedAt || 0).getTime()) / DAY);
    const enough = (m.observations || 0) >= MIN_OBSERVATIONS_FOR_VERDICT;
    if (enough && m.pKnown < SHAKY_BELOW) due.push({ ...m, daysSince, reason: "shaky" });
    else if ((m.observations || 0) > 0 && daysSince >= STALE_AFTER_DAYS) due.push({ ...m, daysSince, reason: "stale" });
  }
  due.sort((a, b) => (a.reason === b.reason ? (a.reason === "shaky" ? a.pKnown - b.pKnown : b.daysSince - a.daysSince) : a.reason === "shaky" ? -1 : 1));
  return due.slice(0, limit);
}
