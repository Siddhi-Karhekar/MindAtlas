export function wordCount(text) {
  return (String(text || "").trim().match(/\S+/g) || []).length;
}

export function readingMinutes(text) {
  return Math.max(1, Math.round(wordCount(text) / 200));
}

/** "just now", "14m ago", "3h ago", "Yesterday", "3 days ago", or a short date. */
export function timeAgo(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const days = Math.floor(s / 86400);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDate(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function compactNumber(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export const pct = (x) => Math.round(x * 100);
