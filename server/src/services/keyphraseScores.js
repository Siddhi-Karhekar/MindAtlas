// Three classic keyphrase-ranking methods, as extra evidence for the key-term
// ranking in keyTerms.extractTerms. None of them decides WHETHER a phrase is a
// term (the rules, the tagger and the marks do that); they only re-order the
// accepted terms, which decides which of them make the top 16 a test draws on.
//
//   yake      YAKE (Campos et al., 2020): statistics of the note alone - where
//             a word first appears, how it is capitalised, how often, in how
//             many sentences, and how varied its neighbours are (a word used
//             with many different neighbours is a function-like word, not a
//             term). Needs no other notes, so it helps the first note of a
//             subject, where TF-IDF has nothing to compare against.
//   textrank  TextRank (Mihalcea & Tarau, 2004): PageRank over a graph of the
//             note's content words, linked when they occur within two words
//             of each other; a phrase scores the sum of its words.
//   rake      RAKE (Rose et al., 2010): each word scores its degree (how many
//             words it shares phrases with) over its frequency; a phrase
//             scores the sum of its words.
//
// Each returns Map(phrase key -> 0..1, higher = more key-like) for the keys
// asked about, by rank among them (a percentile), so the three are comparable
// and none can dominate by scale. Which are used is KEYTERMS_SCORERS (a comma
// list; "off" for none); the default is chosen by `npm run eval:keyterms`
// (docs/KEYTERMS.md).
//
// Input: `runs` - for each sentence, its runs of adjacent content words as
// keyTerms.contentRuns makes them ([{ raw, lower, start }]); `wordKey` - a
// word's key (lower case, singular), so "frames" and "frame" are one word.

export const SCORERS = ["yake", "textrank", "rake"];
// Off by default: on the labelled set (npm run eval:keyterms, docs/KEYTERMS.md
// section 2) none of the three moved precision or recall by more than one or
// two terms of 190 - most notes have 16 accepted terms or fewer, so re-ordering
// them rarely changes which are used. Switch on with KEYTERMS_SCORERS=yake,...
// and measure again on your own labelled notes.
export const DEFAULT_SCORERS = [];

export function enabledScorers() {
  const v = String(process.env.KEYTERMS_SCORERS ?? "").trim().toLowerCase();
  if (!v) return DEFAULT_SCORERS;
  if (/^(?:off|none|false|0|no)$/.test(v)) return [];
  return v.split(/[\s,]+/).filter((s) => SCORERS.includes(s));
}

const percentile = (raw, keys, higherIsBetter = true) => {
  const scored = keys.filter((k) => Number.isFinite(raw.get(k)));
  const sorted = [...scored].sort((a, b) => (higherIsBetter ? raw.get(b) - raw.get(a) : raw.get(a) - raw.get(b)));
  const out = new Map();
  const n = sorted.length;
  sorted.forEach((k, i) => out.set(k, n <= 1 ? 1 : 1 - i / (n - 1)));
  return out;
};

const words = (runs, wordKey) => runs.map((sentence) => sentence.map((run) => run.map((w) => ({ ...w, key: wordKey(w.lower) }))));

/** YAKE's word score, lower = more important; phrase score from its words. */
export function yake(runs, keys, wordKey) {
  const sents = words(runs, wordKey);
  const stats = new Map(); // word -> { tf, upper, acronym, sentences: Set, positions: [], left: Map, right: Map }
  const get = (k) => {
    let s = stats.get(k);
    if (!s) stats.set(k, (s = { tf: 0, upper: 0, acronym: 0, sentences: new Set(), positions: [], left: new Map(), right: new Map() }));
    return s;
  };
  sents.forEach((sentence, si) => {
    // neighbours within two content words, inside the sentence
    const flat = sentence.flat();
    flat.forEach((w, i) => {
      const s = get(w.key);
      s.tf += 1;
      s.sentences.add(si);
      s.positions.push(si);
      if (/^[A-Z0-9]{2,}$/.test(w.raw) && /[A-Z]/.test(w.raw)) s.acronym += 1;
      else if (/^[A-Z]/.test(w.raw) && !w.start) s.upper += 1;
      for (let d = 1; d <= 2; d++) {
        if (flat[i - d]) s.left.set(flat[i - d].key, (s.left.get(flat[i - d].key) || 0) + 1);
        if (flat[i + d]) s.right.set(flat[i + d].key, (s.right.get(flat[i + d].key) || 0) + 1);
      }
    });
  });
  if (!stats.size) return new Map();
  const tfs = [...stats.values()].map((s) => s.tf);
  const mean = tfs.reduce((a, b) => a + b, 0) / tfs.length;
  const std = Math.sqrt(tfs.reduce((a, b) => a + (b - mean) ** 2, 0) / tfs.length);
  const maxTf = Math.max(...tfs);
  const total = Math.max(1, sents.length);
  const wordScore = new Map();
  for (const [k, s] of stats) {
    const median = [...s.positions].sort((a, b) => a - b)[Math.floor(s.positions.length / 2)];
    const tCase = Math.max(s.upper, s.acronym) / (1 + Math.log(s.tf));
    const tPos = Math.log(Math.log(3 + median));
    const tFreq = s.tf / (mean + std || 1);
    const spread = (m) => {
      const n = [...m.values()].reduce((a, b) => a + b, 0);
      return n ? m.size / n : 0;
    };
    const tRel = 1 + (spread(s.left) + spread(s.right)) * (s.tf / maxTf);
    const tDiff = s.sentences.size / total;
    wordScore.set(k, (tRel * tPos) / (tCase + tFreq / tRel + tDiff / tRel));
  }
  // phrase occurrences, for the phrase's own frequency
  const phraseTf = new Map();
  for (const sentence of sents) {
    for (const run of sentence) {
      for (let a = 0; a < run.length; a++) {
        for (let b = a; b < Math.min(run.length, a + 4); b++) {
          const key = phraseKeyOf(run.slice(a, b + 1), wordKey);
          phraseTf.set(key, (phraseTf.get(key) || 0) + 1);
        }
      }
    }
  }
  const raw = new Map();
  for (const key of keys) {
    const parts = key.split(" ").map((w, i, all) => (i === all.length - 1 ? w : wordKey(w)));
    const ws = parts.map((w) => wordScore.get(w)).filter((x) => Number.isFinite(x));
    if (!ws.length) continue;
    const prod = ws.reduce((a, b) => a * b, 1);
    const sum = ws.reduce((a, b) => a + b, 0);
    raw.set(key, prod / ((phraseTf.get(key) || 1) * (1 + sum)));
  }
  return percentile(raw, keys, false);
}

// the phrase key extractTerms uses: words as written, the last one singular
function phraseKeyOf(ws, wordKey) {
  const lower = ws.map((w) => w.lower);
  return [...lower.slice(0, -1), wordKey(lower[lower.length - 1])].join(" ");
}

/** TextRank: PageRank over content words that occur within two words of each other. */
export function textrank(runs, keys, wordKey, { damping = 0.85, iterations = 30 } = {}) {
  const sents = words(runs, wordKey);
  const edges = new Map(); // word -> Map(word -> weight)
  const link = (a, b) => {
    if (a === b) return;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      if (!edges.has(x)) edges.set(x, new Map());
      edges.get(x).set(y, (edges.get(x).get(y) || 0) + 1);
    }
  };
  for (const sentence of sents) {
    const flat = sentence.flat();
    flat.forEach((w, i) => {
      if (!edges.has(w.key)) edges.set(w.key, new Map());
      for (let d = 1; d <= 2 && i + d < flat.length; d++) link(w.key, flat[i + d].key);
    });
  }
  const nodes = [...edges.keys()];
  if (!nodes.length) return new Map();
  const outSum = new Map(nodes.map((n) => [n, [...edges.get(n).values()].reduce((a, b) => a + b, 0)]));
  let rank = new Map(nodes.map((n) => [n, 1 / nodes.length]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map();
    for (const n of nodes) {
      let s = 0;
      for (const [m, w] of edges.get(n)) s += outSum.get(m) ? (rank.get(m) * w) / outSum.get(m) : 0;
      next.set(n, (1 - damping) / nodes.length + damping * s);
    }
    rank = next;
  }
  const raw = new Map();
  for (const key of keys) {
    const parts = key.split(" ").map((w) => wordKey(w));
    const ws = parts.map((w) => rank.get(w)).filter((x) => Number.isFinite(x));
    if (ws.length) raw.set(key, ws.reduce((a, b) => a + b, 0));
  }
  return percentile(raw, keys, true);
}

/** RAKE: word score = degree / frequency within the note's content-word runs; phrase = sum. */
export function rake(runs, keys, wordKey) {
  const freq = new Map();
  const degree = new Map();
  for (const sentence of words(runs, wordKey)) {
    for (const run of sentence) {
      for (const w of run) {
        freq.set(w.key, (freq.get(w.key) || 0) + 1);
        degree.set(w.key, (degree.get(w.key) || 0) + run.length);
      }
    }
  }
  const raw = new Map();
  for (const key of keys) {
    const parts = key.split(" ").map((w) => wordKey(w));
    const ws = parts.filter((w) => freq.has(w)).map((w) => degree.get(w) / freq.get(w));
    if (ws.length) raw.set(key, ws.reduce((a, b) => a + b, 0));
  }
  return percentile(raw, keys, true);
}

const BY_NAME = { yake, textrank, rake };

/**
 * The enabled scorers' mean, per key: Map(key -> 0..1), empty when none is
 * enabled. `names` overrides KEYTERMS_SCORERS (for the evaluation).
 */
export function keyphraseSignal(runs, keys, wordKey, names = enabledScorers()) {
  const out = new Map();
  if (!names.length || !keys.length) return out;
  const maps = names.map((n) => BY_NAME[n](runs, keys, wordKey));
  for (const key of keys) {
    const vals = maps.map((m) => m.get(key)).filter((x) => Number.isFinite(x));
    if (vals.length) out.set(key, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return out;
}
