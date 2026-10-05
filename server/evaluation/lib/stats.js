// Small, dependency-free statistics and CSV helpers for the evaluation.

/** Deterministic random numbers from a seed (mulberry32), so a run can be repeated exactly. */
export function seededRandom(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
export const round = (x, places = 3) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x.toFixed(places)));
export const rate = (hits, total) => (total ? round(hits / total) : null);

/**
 * 95% Wilson interval for a proportion: honest for the small samples a
 * student evaluation has (it never runs past 0 or 1, unlike p +/- 1.96 se).
 */
export function wilson(hits, total, z = 1.96) {
  if (!total) return null;
  const p = hits / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

/**
 * Cohen's kappa for two raters over the same items (any categories).
 * Agreement beyond what chance alone would give: 1 = perfect, 0 = chance.
 * Returns null when there is nothing to compare or no variation at all.
 */
export function cohenKappa(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return null;
  const cats = [...new Set([...a, ...b])];
  let agree = 0;
  const countA = new Map();
  const countB = new Map();
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree += 1;
    countA.set(a[i], (countA.get(a[i]) || 0) + 1);
    countB.set(b[i], (countB.get(b[i]) || 0) + 1);
  }
  const po = agree / n;
  const pe = cats.reduce((s, c) => s + ((countA.get(c) || 0) / n) * ((countB.get(c) || 0) / n), 0);
  if (pe === 1) return null; // both raters used a single category throughout
  return round((po - pe) / (1 - pe));
}

/**
 * Quadratic-weighted kappa for two raters on an ordered scale (1..max):
 * a 4 against a 5 counts as near agreement, a 1 against a 5 as far from it.
 */
export function weightedKappa(a, b, max = 5, min = 1) {
  const n = Math.min(a.length, b.length);
  if (!n) return null;
  const k = max - min + 1;
  const observed = Array.from({ length: k }, () => new Array(k).fill(0));
  const rowTotals = new Array(k).fill(0);
  const colTotals = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const r = a[i] - min;
    const c = b[i] - min;
    if (r < 0 || c < 0 || r >= k || c >= k) continue;
    observed[r][c] += 1;
    rowTotals[r] += 1;
    colTotals[c] += 1;
  }
  const total = rowTotals.reduce((x, y) => x + y, 0);
  if (!total) return null;
  let num = 0;
  let den = 0;
  for (let r = 0; r < k; r++) {
    for (let c = 0; c < k; c++) {
      const w = ((r - c) ** 2) / ((k - 1) ** 2);
      num += w * observed[r][c];
      den += w * ((rowTotals[r] * colTotals[c]) / total);
    }
  }
  return den === 0 ? null : round(1 - num / den);
}

// ---------------------------------------------------------------------------
// Comparing two strategies
// ---------------------------------------------------------------------------

// standard normal: P(Z > z), Abramowitz & Stegun 26.2.17 (error < 7.5e-8)
function upperTail(z) {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = (Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? p : 1 - p;
}

/**
 * Mann-Whitney U test (two-sided) for two independent groups of scores on an
 * ordered scale - the right test for 1..5 ratings, which are not normally
 * distributed. Normal approximation with tie and continuity corrections, the
 * same as scipy's mannwhitneyu(method="asymptotic"); fine from about 8 items
 * a group. Also returns Cliff's delta, the effect size: the chance a score
 * from `a` beats one from `b`, minus the reverse (-1..1; 0.33 is usually
 * read as medium, 0.47 as large).
 */
export function mannWhitney(a, b) {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return null;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  let rankSumA = 0;
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j].v === all[i].v) j += 1;
    const rank = (i + j + 1) / 2; // mean of ranks i+1 .. j
    const t = j - i;
    tieTerm += t * t * t - t;
    for (let k = i; k < j; k++) if (all[k].g === 0) rankSumA += rank;
    i = j;
  }
  const n = n1 + n2;
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  const delta = round((2 * u1) / (n1 * n2) - 1);
  if (variance <= 0) return { u: u1, z: 0, p: 1, delta, n1, n2 }; // every score identical
  const z = (Math.abs(u1 - mu) - 0.5) / Math.sqrt(variance);
  return { u: u1, z: round(Math.max(0, z)), p: round(Math.min(1, 2 * upperTail(Math.max(0, z))), 4), delta, n1, n2 };
}

/**
 * Fisher's exact test (two-sided) for a 2x2 table: `hitsA` of `totalA`
 * against `hitsB` of `totalB`. Exact, so it is valid for small counts where
 * a chi-squared test is not. Two-sided by the usual rule: the sum of the
 * probabilities of all tables no more likely than the observed one.
 */
export function fisherExact(hitsA, totalA, hitsB, totalB) {
  if (!totalA || !totalB) return null;
  const hits = hitsA + hitsB;
  const n = totalA + totalB;
  const logFact = [0];
  for (let i = 1; i <= n; i++) logFact.push(logFact[i - 1] + Math.log(i));
  const logChoose = (m, k) => logFact[m] - logFact[k] - logFact[m - k];
  // P(x hits in group A), with every margin fixed
  const prob = (x) => Math.exp(logChoose(totalA, x) + logChoose(totalB, hits - x) - logChoose(n, hits));
  const observed = prob(hitsA);
  let p = 0;
  for (let x = Math.max(0, hits - totalB); x <= Math.min(totalA, hits); x++) {
    const px = prob(x);
    if (px <= observed * (1 + 1e-9)) p += px;
  }
  return round(Math.min(1, p), 4);
}

/**
 * Holm's correction for running several tests at once: the adjusted p-values,
 * in the order given. Use these, not the raw ones, to call a result
 * significant. Nulls are passed through and not counted.
 */
export function holm(pValues) {
  const order = pValues.map((p, i) => ({ p, i })).filter((x) => x.p !== null && x.p !== undefined).sort((x, y) => x.p - y.p);
  const out = pValues.map(() => null);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, p * (order.length - rank)));
    out[i] = round(running, 4);
  });
  return out;
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180): quoted fields, doubled quotes, commas and newlines inside
// fields. Written with a byte-order mark so Excel reads it as UTF-8.
// ---------------------------------------------------------------------------

const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows, columns) {
  const lines = [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  if (!rows.length) return [];
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
