// A note's key terms: the things it is about, as whole terms.
//
// TF-IDF keywords (tfidf.js) are single words, because TF-IDF counts words.
// "distributed computing" can never be one of them - only "distributed" and
// "computing" separately - which is why a fill-in-the-blank question used to
// hide half a term ("distributed _____"). Here the unit is the phrase.
//
// How terms are found:
//   1. Candidates. Every run of content words in the note's study sentences
//      (studyText.js), and every 1-4 word stretch inside a run. A run ends at
//      punctuation, a function word or a common verb, so "the lock manager
//      decides whether" yields "lock manager", not "manager decides whether".
//   2. Evidence that a candidate is a term and not just adjacent words: it
//      recurs, or the author marked it - a heading, bold type, the term a list
//      entry opens with ("Atomicity: ..."), or a phrase spelled out before its
//      acronym ("Classless Inter-Domain Routing (CIDR)").
//   3. Whole terms beat their parts. An occurrence of "computing" inside
//      "distributed computing" counts for the longer term; "computing" only
//      survives on the strength of the times it stands alone.
//   4. Ranking. Without the embedding model: how often the term stands alone,
//      how long it is, how specific it is to this note among the notes in the
//      test, and how the author marked it. With the model (embeddings.js), the
//      KeyBERT method is blended in: a term scores higher the closer its
//      meaning is to the note's.
// All of it is deterministic for a given note, and none of it needs the model.

import { blocksOf, candidateSentences, keepRelevant } from "./studyText.js";
import { centroid, cosine } from "./embeddings.js";

export const MAX_TERM_WORDS = 4;
const MAX_TERMS = 16;

// Frequent-but-empty words. As an answer they make a question trivial or
// meaningless ("_____ device is attached" -> "every").
export const GENERIC = new Set([
  "every", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "many", "much", "more", "most", "less",
  "least", "other", "another", "some", "any", "all", "both", "either", "neither", "first", "second", "third", "last", "next", "new",
  "same", "different", "such", "used", "use", "uses", "using", "called", "based", "example", "examples", "following", "given",
  "general", "type", "types", "kind", "kinds", "way", "ways", "thing", "things", "part", "parts", "number", "numbers", "set",
  "case", "cases", "time", "times", "unit", "page", "chapter", "section", "notes", "lecture", "semester", "department",
  "introduction", "summary", "figure", "table", "several", "various", "certain", "main", "major", "common", "important",
  "possible", "available", "single", "multiple", "large", "small", "high", "low", "good", "simple", "basic", "overview",
  "advantages", "advantage", "disadvantages", "disadvantage", "features", "feature", "characteristics", "properties", "property",
  "steps", "step", "points", "point", "concept", "concepts", "definition", "term", "terms", "topic", "topics", "detail", "details",
]);

// Words a term never contains: function words, and verbs that are almost never
// nouns in notes. Words that are both ("lock", "process", "address", "cache")
// are deliberately not here - evidence decides for those.
const FUNCTION_WORDS = [
  "the", "a", "an", "and", "or", "but", "nor", "if", "then", "else", "so", "of", "to", "in", "on", "for", "with", "as", "at", "by",
  "from", "into", "onto", "upon", "about", "than", "that", "this", "these", "those", "it", "its", "is", "are", "was", "were", "be",
  "been", "being", "am", "which", "who", "whom", "whose", "what", "when", "where", "why", "how", "not", "no", "can", "cannot",
  "could", "will", "would", "should", "may", "might", "must", "shall", "do", "does", "did", "done", "has", "have", "had", "having",
  "i", "you", "he", "she", "we", "they", "them", "his", "her", "their", "our", "your", "my", "me", "us", "also", "each", "there",
  "here", "up", "out", "over", "under", "again", "further", "once", "very", "just", "only", "even", "still", "yet", "while",
  "whereas", "because", "since", "until", "unless", "although", "though", "between", "among", "through", "during", "before",
  "after", "above", "below", "within", "without", "across", "against", "along", "around", "per", "via", "both", "either",
  "whether", "however", "therefore", "thus", "hence", "instead", "rather", "often", "usually", "always", "never", "sometimes",
  "generally", "typically", "simply", "already", "now", "later", "together", "apart", "away", "back", "etc", "eg", "ie", "e.g", "i.e",
  "cont", "contd", "continued", "like", "unlike", "towards", "toward", "become", "becomes", "became",
];
const VERBS = [
  "ensure", "provide", "allow", "require", "contain", "include", "describe", "define", "determine", "represent", "occur",
  "consist", "make", "give", "take", "send", "receive", "hold", "keep", "need", "mean", "refer", "call", "know", "perform",
  "prevent", "reduce", "increase", "decrease", "improve", "enable", "specify", "indicate", "identify", "assume", "consider",
  "follow", "depend", "belong", "exist", "remain", "happen", "appear", "seem", "involve", "achieve", "obtain", "maintain",
  "establish", "create", "produce", "generate", "convert", "connect", "divide", "combine", "compare", "choose", "select",
  "decide", "begin", "start", "stop", "end", "continue", "repeat", "wait", "try", "get", "put", "set", "let", "see", "show",
  "tell", "say", "write", "read", "run", "move", "add", "remove", "apply", "carry", "bring", "come", "go", "work", "serve",
  "guarantee", "satisfy", "permit", "support", "offer", "introduce", "explain", "illustrate", "note", "learn", "understand",
  "leave", "become", "lead", "cause", "break", "span", "cover", "join", "split", "rely", "lie", "wound", "roll", "fail",
  "force", "arise", "differ", "vary", "act", "behave", "exceed", "suffer", "tend", "aim", "expect", "want", "help",
];
const inflect = (v) => {
  const forms = [v, `${v}s`, `${v}ing`, `${v}ed`];
  if (v.endsWith("e")) forms.push(`${v}d`, `${v.slice(0, -1)}ing`);
  if (v.endsWith("y")) forms.push(`${v.slice(0, -1)}ies`, `${v.slice(0, -1)}ied`);
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(v)) forms.push(`${v}${v.slice(-1)}ing`, `${v}${v.slice(-1)}ed`);
  return forms;
};
const IRREGULAR = "made gave given took taken sent held kept meant known began begun got put saw seen shown told said wrote written ran came went gone left led broke broken chose chosen brought".split(" ");
const BREAK = new Set([...FUNCTION_WORDS, ...VERBS.flatMap(inflect), ...IRREGULAR]);

// ---------------------------------------------------------------------------
// Text -> runs of content words
// ---------------------------------------------------------------------------

const TOKEN = /[A-Za-z0-9]+(?:[-'’/.+][A-Za-z0-9]+)*\+*/g;

/** Runs of adjacent content words: [[{ raw, lower }]] */
export function contentRuns(text) {
  const runs = [];
  let run = [];
  let lastEnd = 0;
  const close = () => {
    if (run.length) runs.push(run);
    run = [];
  };
  const str = String(text || "");
  for (const m of str.matchAll(TOKEN)) {
    const gap = str.slice(lastEnd, m.index);
    lastEnd = m.index + m[0].length;
    if (run.length && /[^\s]/.test(gap)) close(); // punctuation between words ends a term
    const lower = m[0].toLowerCase();
    if (BREAK.has(lower) || /^\d+([.,]\d+)*$/.test(lower) || /ly$/.test(lower)) {
      close();
      continue;
    }
    // the first word of a sentence is capitalised whatever it is
    const before = str.slice(0, m.index).trimEnd();
    run.push({ raw: m[0], lower, start: before === "" || /[.!?:]$/.test(before) });
  }
  close();
  return runs;
}

// one key for "block cipher" and "block ciphers"
function singular(w) {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(sh|ch|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}
export const termKey = (words) => {
  const list = (Array.isArray(words) ? words : String(words).split(/\s+/)).map((w) => String(w).toLowerCase());
  return [...list.slice(0, -1), singular(list[list.length - 1])].join(" ");
};

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Matches the term as whole words, in singular or plural, across any spacing. */
export function termPattern(term, flags = "gi") {
  const words = String(term).trim().split(/\s+/);
  const last = singular(words[words.length - 1].toLowerCase());
  const body = [...words.slice(0, -1).map(escapeRe), `${escapeRe(last)}(?:s|es)?`];
  if (/y$/.test(last)) body[body.length - 1] = `(?:${escapeRe(last)}s?|${escapeRe(last.slice(0, -1))}ies)`;
  return new RegExp(`(?<![A-Za-z0-9])${body.join("[\\s-]+")}(?![A-Za-z0-9])`, flags);
}

const NOUN_LEAD = "(?:the|a|an|of|its|their|by|between|in|and|these|those|each|when|whereas|with|from|into|through|among)";
const nounEvidence = (word, text) => new RegExp(`\\b${NOUN_LEAD}\\s+${escapeRe(word)}\\b`, "i").test(text);
// "encrypts a block", "shifts each letter": the word is used as a verb
const verbEvidence = (word, text) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRe(word)}\\s+(?:the|a|an|each|every|its|their|this|these|those|all|it|them)\\b`, "i").test(text);

const initialsOf = (words) => words.flatMap((w) => w.split("-").filter(Boolean)).map((w) => w[0]).join("").toUpperCase();

// "Classless Inter-Domain Routing (CIDR)" -> { words: [...], abbr: "CIDR" }
function acronymDefinitions(text) {
  const out = [];
  for (const m of String(text).matchAll(/\(([A-Z][A-Za-z]{1,6})s?\)/g)) {
    const abbr = m[1].toUpperCase();
    const before = String(text).slice(Math.max(0, m.index - 120), m.index).trim().split(/\s+/);
    for (let n = 2; n <= Math.min(6, before.length); n++) {
      const words = before.slice(-n).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""));
      if (words.every(Boolean) && initialsOf(words) === abbr) {
        out.push({ words, abbr });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidates -> terms
// ---------------------------------------------------------------------------

/**
 * Key terms of `note`, best first, from the given study sentences.
 * `corpus`: the other notes in play, to judge how specific a term is to this one.
 * Each term: { term, key, words, count, standalone, marks, abbr, score, sentences }
 * where `sentences` are indexes into `sentences` and `marks` says how the
 * author flagged it ("title" | "heading" | "bold" | "lead" | "acronym").
 */
export function extractTerms(note, sentences, corpus = []) {
  const body = sentences.map((s) => s.text).join("\n");
  const cands = new Map(); // key -> candidate
  const occurrences = []; // every candidate occurrence: { key, sentence, run, from, to }

  sentences.forEach((s, si) => {
    contentRuns(s.text).forEach((run, ri) => {
      for (let from = 0; from < run.length; from++) {
        for (let to = from; to < Math.min(run.length, from + MAX_TERM_WORDS); to++) {
          const words = run.slice(from, to + 1);
          const key = termKey(words.map((w) => w.lower));
          let c = cands.get(key);
          if (!c) cands.set(key, (c = { key, n: words.length, count: 0, forms: new Map(), sentences: new Set(), marks: new Set(), abbr: null }));
          c.count += 1;
          c.sentences.add(si);
          // how the term is written mid-sentence is how it should be shown
          const surface = words.map((w) => w.raw).join(" ");
          if (!words[0].start) c.mid = (c.mid || 0) + 1;
          // the main noun of an English term comes last: a word that never ends
          // a run ("logical" in "logical unit") is a modifier, not a term
          if (to === run.length - 1) c.heads = (c.heads || 0) + 1;
          c.forms.set(surface, (c.forms.get(surface) || 0) + (words[0].start ? 1 : 3));
          occurrences.push({ key, n: words.length, si, ri, from, to });
        }
      }
    });
  });

  // what the author marked
  const mark = (text, label) => {
    for (const run of contentRuns(text)) {
      if (run.length > MAX_TERM_WORDS) continue;
      const c = cands.get(termKey(run.map((w) => w.lower)));
      if (c) c.marks.add(label);
    }
  };
  [note?.title, ...(Array.isArray(note?.path) ? note.path : [])].filter(Boolean).forEach((t) => mark(String(t).replace(/^\s*\d+(\.\d+)*\.?\s+/, ""), "title"));
  for (const b of blocksOf(note)) {
    if (b.type === "heading" || b.type === "label") mark(String(b.text).replace(/^\s*\d+(\.\d+)*\.?\s+/, ""), "heading");
    for (const t of b.strong || []) mark(t, "bold");
  }
  sentences.forEach((s) => s.lead && mark(s.lead, "lead"));
  for (const { words, abbr } of acronymDefinitions(body)) {
    const key = termKey(words.map((w) => w.toLowerCase()));
    let c = cands.get(key);
    if (!c && words.length <= 6) {
      // a long name the run rules split ("Carrier Sense Multiple Access with Collision Detection")
      const re = termPattern(words.join(" "));
      const hits = sentences.map((s, i) => ((s.text.match(re) || []).length ? i : -1)).filter((i) => i >= 0);
      if (hits.length) {
        c = { key, n: words.length, count: hits.length, forms: new Map([[words.join(" "), 3]]), sentences: new Set(hits), marks: new Set(), abbr, whole: true };
        cands.set(key, c);
      }
    }
    if (c) {
      c.marks.add("acronym");
      c.abbr = abbr;
    }
  }

  // which candidates are terms
  const accepted = new Map();
  for (const c of cands.values()) {
    const words = c.key.split(" ");
    const first = words[0];
    const last = words[words.length - 1];
    if (GENERIC.has(first) || GENERIC.has(last) || words.every((w) => GENERIC.has(w))) continue;
    const surface = [...c.forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const acronymLike = /^[A-Z0-9][A-Z0-9/+.-]*[A-Z0-9+]$/.test(surface);
    if (c.n === 1) {
      if (last.length < 3 && !acronymLike) continue;
      if (!acronymLike && !c.marks.size) {
        if (!c.heads) continue;
        if (!nounEvidence(surface, body) && !nounEvidence(last, body)) continue;
        if (verbEvidence(surface, body) || /(?:ed|ous|ive|able|ible|ful|less|ish)$/.test(last)) continue;
      }
    } else {
      if (c.count < 2 && !c.marks.size) continue; // adjacent once: could be coincidence
      // "block cipher encrypts": the last word is the term's verb, not part of it
      const lastSurface = surface.split(/\s+/).pop();
      if (!c.marks.size && verbEvidence(lastSurface, body)) continue;
    }
    accepted.set(c.key, { ...c, surface, acronymLike });
  }

  // an occurrence inside a longer accepted term belongs to the longer term
  const standalone = new Map();
  const bySpan = new Map(); // "si:ri" -> accepted occurrences in that run
  for (const o of occurrences) {
    if (!accepted.has(o.key)) continue;
    const id = `${o.si}:${o.ri}`;
    if (!bySpan.has(id)) bySpan.set(id, []);
    bySpan.get(id).push(o);
  }
  for (const list of bySpan.values()) {
    for (const o of list) {
      const nested = list.some((p) => p !== o && p.n > o.n && p.from <= o.from && p.to >= o.to);
      if (!nested) standalone.set(o.key, (standalone.get(o.key) || 0) + 1);
    }
  }

  const others = (corpus || []).filter((n) => n !== note && String(n?._id) !== String(note?._id)).map((n) => String(n.rawText || "").toLowerCase());
  const BONUS = { title: 0.6, heading: 0.5, bold: 0.5, lead: 0.4, acronym: 0.4 };
  const terms = [];
  for (const c of accepted.values()) {
    const alone = c.whole ? c.count : standalone.get(c.key) || 0;
    if (alone === 0 && !c.marks.size) continue; // only ever part of a longer term
    const term = displayForm(c);
    const re = termPattern(term, "i");
    const df = others.filter((t) => re.test(t)).length;
    const idf = 1 + Math.log((others.length + 1) / (df + 1));
    const bonus = 1 + [...c.marks].reduce((sum, m) => sum + (BONUS[m] || 0), 0);
    const strength = Math.log2(Math.min(c.n, MAX_TERM_WORDS) + 1) * (alone + 0.25 * (c.count - alone));
    terms.push({
      term,
      key: c.key,
      words: c.n,
      count: c.count,
      standalone: alone,
      marks: [...c.marks],
      abbr: c.abbr,
      sentences: [...c.sentences],
      score: Number((strength * idf * bonus).toFixed(4)),
    });
  }
  return terms.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
}

// "Distributed computing" at the start of a sentence is "distributed
// computing"; "TCP", "Ethernet" and "Caesar cipher" keep their capitals, since
// the note writes them that way in the middle of a sentence too.
function displayForm(c) {
  // the singular, when the note uses it at all: "exclusive lock", not "exclusive locks"
  const lastOfKey = c.key.split(" ").pop();
  const singularForm = [...c.forms.entries()]
    .filter(([f]) => f.split(/\s+/).pop().toLowerCase() === lastOfKey)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (singularForm && singularForm.toLowerCase() !== c.surface.toLowerCase()) {
    const [first, ...rest] = singularForm.split(/\s+/);
    // capitalised only because it opened a sentence or a list entry
    const midCased = [...c.forms.keys()].find((f) => f.toLowerCase().startsWith(first.toLowerCase()) && /^[a-z]/.test(f));
    return midCased && /^[A-Z][a-z]+$/.test(first) ? [first.toLowerCase(), ...rest].join(" ") : singularForm;
  }
  const [first, ...rest] = c.surface.split(/\s+/);
  if (!c.mid && !c.whole && /^[A-Z][a-z]+$/.test(first)) return [first.toLowerCase(), ...rest].join(" ");
  return c.surface;
}

// ---------------------------------------------------------------------------
// The whole study view of a note
// ---------------------------------------------------------------------------

const studyCache = new Map();
const STUDY_CACHE_LIMIT = 400;

/**
 * Everything question writing needs from one note:
 *   { sentences: [{ text, kind, section, lead, relevance?, terms: [key] }],
 *     terms: [...extractTerms, with `semantic` when the model ranked them],
 *     semantic: true when the embedding model was used }
 */
export async function studyFor(note, { corpus = [], embedder = null } = {}) {
  const cacheKey = `${note?._id}:${String(note?.rawText || "").length}:${embedder ? embedder.model : "rules"}:${corpus.length}`;
  if (note?._id && studyCache.has(cacheKey)) return studyCache.get(cacheKey);

  let sentences = await keepRelevant(note, candidateSentences(note), embedder);
  let terms = extractTerms(note, sentences, corpus);

  if (embedder && terms.length) {
    // KeyBERT: a term is as good as its meaning is close to the note's
    const centre = centroid(sentences.map((s) => s.vector));
    const vectors = await embedder.embed(terms.map((t) => t.term));
    const top = Math.max(...terms.map((t) => t.score)) || 1;
    terms = terms
      .map((t, i) => {
        const semantic = Math.max(0, cosine(vectors[i], centre));
        // both have to agree: evidence that it is a term, and that it is on topic
        return { ...t, semantic: Number(semantic.toFixed(4)), vector: vectors[i], score: Number((Math.sqrt(t.score / top) * 0.5 + semantic * 0.5).toFixed(4)) };
      })
      .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  }
  terms = terms.slice(0, MAX_TERMS);

  const patterns = terms.map((t) => [t.key, termPattern(t.term, "i")]);
  sentences = sentences.map((s) => ({ ...s, terms: patterns.filter(([, re]) => re.test(s.text)).map(([k]) => k) }));
  if (!embedder) {
    // No model to judge meaning: a sentence is on topic if it uses a key term.
    // Kept only when that still leaves most of the note, so a note with few
    // detectable terms is not emptied.
    const onTopic = sentences.filter((s) => s.terms.length > 0);
    if (onTopic.length >= Math.ceil(sentences.length * 0.5)) sentences = onTopic;
  }

  const study = { sentences, terms, semantic: Boolean(embedder) };
  if (note?._id) {
    if (studyCache.size >= STUDY_CACHE_LIMIT) studyCache.delete(studyCache.keys().next().value);
    studyCache.set(cacheKey, study);
  }
  return study;
}

/** Tests only. */
export function clearStudyCache() {
  studyCache.clear();
}
