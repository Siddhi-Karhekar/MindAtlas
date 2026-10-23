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
//   5. Signals from outside the text (keyTermSignals.js): terms the student
//      added (always kept) or removed (never kept), terms the AI suggested
//      when the note was saved, and the subject's syllabus. Each is a mark,
//      like a heading: the term is accepted even when said once, and ranks
//      higher.
// With the part-of-speech tagger (posTags.js), step 2 also uses how the note
// itself uses each word: a word it almost never uses as a noun is no term
// ("solve", "smaller"), one it clearly does is ("derivative", though it ends
// like an adjective), and a compound noun said once is a term ("global symbol
// table", "relocation register").
// All of it is deterministic for a given note, and none of it needs the model.

import { blocksOf, candidateSentences, keepRelevant } from "./studyText.js";
import { centroid, cosine } from "./embeddings.js";
import { posAvailable, posProfile } from "./posTags.js";
import { signalsFingerprint, signalsOf } from "./keyTermSignals.js";
import { enabledScorers, keyphraseSignal } from "./keyphraseScores.js";
import { tagText } from "./posTags.js";
import { createRequire } from "node:module";

// ---- the October 2026 key-term fixes (docs/KEYTERMS.md section 2b) ----------
// Each can be switched off for measurement: KEYTERMS_FIXES lists the ones on
// (default: all of DEFAULT_FIXES; "off" for none).
//   common   domain specificity: an everyday English word (the ~4,000 most
//            common, SCOWL size 10) is a key term only with evidence - the
//            note defines it or the author marks it
//   commonphrase  ...and a phrase said once needs a word that is not everyday
//            (off: it dropped real terms - "prime number", "safe state")
//   rare     ...the other side: a single uncommon noun said once ("starvation",
//            "conductance") is a term, ranked below better-evidenced ones
//   shapes   term shapes the word rules broke: named laws ("Kirchhoff's current
//            law"), ordinals ("second derivative"), -ing modifiers ("growing
//            phase"), -ing nouns ("marshalling"), nouns the tagger misread as
//            verbs ("relocation register"), items of a list after a colon
//            ("hold and wait, no preemption and circular wait")
//   chunks   noun phrases from the tagger across words the rules treat as
//            verbs: "procedure call", "call stack", "circular wait"
//   limit    more than 16 terms for a long note: one per 40 words, up to 40
//   formula  LaTeX commands, $...$ formulas and Greek letter names are never terms
//   cvalue   C-value (Frantzi et al., 2000) for nested terms: a phrase seen
//            mostly inside a longer term counts for less
export const KEYTERM_FIXES = ["common", "commonphrase", "rare", "shapes", "chunks", "limit", "formula", "cvalue"];
// On by default: the fixes that improved the labelled set (npm run eval:keyterms;
// docs/KEYTERMS.md section 2b). commonphrase, chunks, limit and cvalue made no
// difference or made it worse there, so they are off; re-test them on longer notes.
export const DEFAULT_FIXES = ["common", "rare", "shapes", "formula"];
export function keytermFixes() {
  const v = String(process.env.KEYTERMS_FIXES ?? "").trim().toLowerCase();
  if (!v) return new Set(DEFAULT_FIXES);
  if (/^(?:off|none|false|0|no)$/.test(v)) return new Set();
  return new Set(v.split(/[\s,]+/).filter((x) => KEYTERM_FIXES.includes(x)));
}
const fixesKey = () => [...keytermFixes()].sort().join("+");

let commonSet = null;
/** The ~4,000 most common English words (SCOWL size 10; wordlist-english, MIT/SCOWL licence). */
function commonWords() {
  if (commonSet) return commonSet;
  try {
    const require = createRequire(import.meta.url);
    commonSet = new Set(require("wordlist-english/english-words-10.json").map((w) => String(w).toLowerCase()));
  } catch (err) {
    console.warn("[keyterms] common-word list unavailable:", err?.message || err);
    commonSet = new Set();
  }
  return commonSet;
}
const ORDINALS = new Set(["first", "second", "third", "fourth", "fifth", "last", "zeroth", "nth"]);
const NAMED_HEADS = /^(?:law|laws|rule|rules|theorem|theorems|algorithm|algorithms|principle|principles|clock|clocks|equation|equations|method|lemma|test|criterion|criteria|constant|effect|paradox|problem|protocol|code|cipher|attack|model|formula|series|distribution)$/;
// "$x^2$", "\frac{a}{b}": replaced by spaces of the same length, so positions still line up
const maskFormulas = (text) => String(text).replace(/\$[^$\n]{1,200}\$/g, (m) => " ".repeat(m.length)).replace(/\\[a-zA-Z]+/g, (m) => " ".repeat(m.length));

export const MAX_TERM_WORDS = 4;
const scorerWeight = () => {
  const v = Number(process.env.KEYTERMS_SCORER_WEIGHT);
  return Number.isFinite(v) && v >= 0 && v <= 2 ? v : 0.5;
};
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
  "start", "end", "top", "bottom", "middle", "side", "beginning",
]);

// The generic words that are nouns, so can end a longer term ("sequence
// number", "routing table", "page table"); "younger one" or "two phases first" cannot.
const NOUN_GENERIC = new Set(["start", "end", "number", "table", "set", "type", "unit", "point", "time", "step", "case", "part", "page", "property", "detail", "section", "feature", "concept"]);

// Generic adjectives that also open real terms when the phrase recurs:
// "main memory", "high availability", "low latency", "common bus"
const TERM_ADJECTIVES = new Set(["main", "single", "large", "small", "high", "low", "simple", "basic", "common", "general", "new", "multiple"]);

// Adjectives that judge or compare rather than classify: never the first word
// of a compound noun said once ("fast cache", "free frame", "final result")
// endings only nouns have: the tagger's "verb" for "register" or "buffer" is
// not believed (it reads "the relocation register holds" as two verbs)
const NOUN_ENDING = /(?:tion|sion|ment|ness|ity|ance|ence|ism|ure|age|er|or|ist|ship|hood|ery|ogy|ics|ware)s?$/;
const GREEK = new Set("alpha beta gamma delta epsilon theta lambda mu nu pi rho sigma tau phi psi omega".split(" "));
const EVALUATIVE = new Set(
  "excellent poor high-speed low-cost fast slow quick free recent final entire whole extra given ordinary separate fixed normal special typical real actual necessary specific own best better worse worst easy hard difficult correct wrong proper full empty short long huge tiny little big great good bad poor older younger earlier later initial current previous next certain".split(" ")
);

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
  "cont", "contd", "continued", "like", "unlike", "towards", "toward", "become", "becomes", "became", "modulo",
  // quantifiers: "a bus topology every device is attached to" holds the term
  // "bus topology", not "topology every device"
  "every", "all", "some", "any", "many", "much", "few", "several", "another", "other", "such", "most", "more", "less",
];
const VERBS = [
  "ensure", "provide", "allow", "require", "contain", "include", "describe", "define", "determine", "represent", "occur",
  "consist", "make", "give", "take", "send", "receive", "hold", "keep", "need", "mean", "refer", "call", "know", "perform",
  "prevent", "reduce", "increase", "decrease", "improve", "enable", "specify", "indicate", "identify", "assume", "consider",
  "follow", "depend", "belong", "exist", "remain", "happen", "appear", "seem", "involve", "achieve", "obtain", "maintain",
  "establish", "create", "produce", "generate", "convert", "connect", "divide", "combine", "compare", "choose", "select",
  "decide", "begin", "continue", "repeat", "wait", "try", "get", "put", "set", "let", "see", "show",
  "tell", "say", "write", "read", "run", "move", "add", "remove", "apply", "carry", "bring", "come", "go", "work", "serve",
  "guarantee", "satisfy", "permit", "support", "offer", "introduce", "explain", "illustrate", "note", "learn", "understand",
  "leave", "become", "lead", "cause", "break", "span", "cover", "join", "split", "rely", "lie", "wound", "roll", "fail",
  "force", "arise", "differ", "vary", "act", "behave", "exceed", "suffer", "tend", "aim", "expect", "want", "help",
];
// finite forms only: "computes", "agrees" - their -ing forms are nouns as often ("computing", "finding")
const FINITE_ONLY = "agree compute recompute encrypt decrypt verify discard publish recover demonstrate find raise".split(" ");
const inflect = (v) => {
  const forms = [v, `${v}s`, `${v}ing`, `${v}ed`];
  if (v.endsWith("e")) forms.push(`${v}d`, `${v.slice(0, -1)}ing`);
  if (v.endsWith("y")) forms.push(`${v.slice(0, -1)}ies`, `${v.slice(0, -1)}ied`);
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(v)) forms.push(`${v}${v.slice(-1)}ing`, `${v}${v.slice(-1)}ed`);
  return forms;
};
const IRREGULAR = "made gave given took taken sent held kept meant known began begun got put saw seen shown told said wrote written ran came went gone left led broke broken chose chosen brought".split(" ");
const VERB_FORMS = new Set([
  ...VERBS.flatMap(inflect),
  ...FINITE_ONLY.flatMap((v) => inflect(v).filter((f) => !f.endsWith("ing"))),
  ...IRREGULAR,
  ..."is are was were has have had can cannot could will would may might must should does do".split(" "),
]);
const BREAK = new Set([...FUNCTION_WORDS, ...VERB_FORMS]);
/** A word that can be part of a term (not a function word or a common verb). */
export const isContentWord = (w) => /^[A-Za-z][A-Za-z0-9-]*$/.test(w) && !BREAK.has(w.toLowerCase());
/** A word the lists know as a verb form ("takes", "is", "combined") - for telling a statement from a fragment. */
export const isVerbForm = (w) => VERB_FORMS.has(String(w).toLowerCase());

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
    if (BREAK.has(lower) || /^\d+([.,]\d+)*$/.test(lower) || lower.endsWith('ly')) {
      close();
      continue;
    }
    // the first word of a sentence is capitalised whatever it is
    const before = str.slice(0, m.index).trimEnd();
    run.push({ raw: m[0], lower, at: m.index, start: before === "" || /[.!?:]$/.test(before) });
  }
  close();
  return runs;
}

// one key for "block cipher" and "block ciphers"
function singular(w) {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
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
  if (last.endsWith('y')) body[body.length - 1] = `(?:${escapeRe(last)}s?|${escapeRe(last.slice(0, -1))}ies)`;
  return new RegExp(`(?<![A-Za-z0-9])${body.join("[\\s-]+")}(?![A-Za-z0-9])`, flags);
}

const NOUN_LEAD = "(?:the|a|an|of|its|their|by|between|in|and|these|those|each|when|whereas|with|from|into|through|among)";
const nounEvidence = (word, text) => new RegExp(`\\b${NOUN_LEAD}\\s+${escapeRe(word)}\\b`, "i").test(text);
// "encrypts a block", "shifts each letter": the word is used as a verb
const verbEvidence = (word, text) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRe(word)}\\s+(?:the|a|an|each|every|its|their|this|these|those|all|it|them)\\b`, "i").test(text);
// "the sender retransmits that frame", "the receiver buffers out-of-order
// frames": a word ending in -s straight after a noun, never used as a noun
// itself, is the sentence's verb
// ("and" does not make a noun here: "affects both equally and cancels out")
// the note says what the word is: "A frame is ...", "... is called a frame", "known as frames"
const definesWord = (word, text) =>
  new RegExp(`(?:^|[.!?]\\s+|\\n)(?:an?\\s+|the\\s+)?(?:[A-Za-z-]+\\s+){0,2}${escapeRe(word)}s?\\s+(?:is|are)\\s+(?:an?|the|one|defined|called|known)\\b|\\b(?:called|known as|termed|referred to as)\\s+(?:an?|the)?\\s*${escapeRe(word)}`, "i").test(text);
const articleNoun = (word, text) => new RegExp(`\\b(?:the|a|an|of|its|their|these|those|each|by)\\s+${escapeRe(word)}\\b`, "i").test(text);
const looksLikeVerbS = (word, text) =>
  /[a-z]s$/i.test(word) &&
  !/(ss|us|is)$/i.test(word) &&
  !articleNoun(word, text) &&
  !articleNoun(singular(word.toLowerCase()), text) &&
  new RegExp(`(?<![A-Za-z0-9])${escapeRe(word)}\\s+(?:that|only|every|both|one|some|any|no|out|up|down|back|on|over|in|to|it|them|the|a|an|its|their|each|all|around|through|across|into|from|with|at|as|by|for)\\b`, "i").test(text);

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
export function extractTerms(note, sentences, corpus = [], { explain = null } = {}) {
  // explain (a Map, for diagnosis): why each rejected candidate was rejected
  const reject = (c, why) => explain?.set(c.key, why);
  const fix = keytermFixes();
  const common = fix.has("common") || fix.has("commonphrase") || fix.has("rare") ? commonWords() : new Set();
  const isCommon = (w) => common.has(w) || common.has(singular(w));
  const body = sentences.map((s) => s.text).join("\n");
  const cands = new Map(); // key -> candidate
  const occurrences = []; // every candidate occurrence: { key, sentence, run, from, to }
  const runsOf = sentences.map((s) => contentRuns(fix.has("formula") ? maskFormulas(s.text) : s.text));

  sentences.forEach((s, si) => {
    runsOf[si].forEach((run, ri) => {
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
          occurrences.push({ key, n: words.length, si, ri, from, to, spans: words.map((w) => [w.at, w.at + w.raw.length]), lastRaw: words[words.length - 1].raw });
          // the whole subject a sentence opens with: "Optical fibre carries
          // data as pulses of light", "Coaxial cable has a central conductor"
          // - and only when a known verb follows, so "Subnetting borrows bits"
          // (a verb the word lists do not know) is not taken for a term
          // ("A page fault occurs when ...": an article may come first)
          const opening = s.text.trimStart().replace(/^(?:A|An|The)\s+/, "");
          if (ri === 0 && from === 0 && to === run.length - 1 && words.length >= 2 && words.length <= 3 && opening.startsWith(words[0].raw) && (/^[A-Z]/.test(words[0].raw) || opening !== s.text.trimStart()) && !words.some((w) => /['’]/.test(w.raw))) {
            const lastWord = words[words.length - 1];
            const next = s.text.slice(lastWord.at + lastWord.raw.length).match(/^\s+([A-Za-z]+)/)?.[1]?.toLowerCase();
            if (next && VERB_FORMS.has(next)) c.subject = true;
          }
          if (words[0].start) c.opens = true;
        }
      }
    });
  });

  // a phrase looked up as written ("hold and wait"), made a candidate if the
  // run rules never produced it
  const foundAsWritten = (phrase) => {
    const words = String(phrase).replace(/[^A-Za-z0-9'’+\s-]+/g, " ").trim().split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 6) return null;
    const key = termKey(words.map((w) => w.toLowerCase()));
    if (cands.has(key)) return cands.get(key);
    const re = termPattern(words.join(" "));
    const hits = sentences.map((s, i) => (re.test(s.text) ? i : -1)).filter((i) => i >= 0);
    if (!hits.length) return null;
    let count = 0;
    let surface = null;
    for (const s of sentences) for (const m of s.text.matchAll(new RegExp(re.source, "gi"))) {
      count++;
      surface = surface || m[0];
    }
    const c = { key, n: words.length, count, forms: new Map([[surface || words.join(" "), 3]]), sentences: new Set(hits), marks: new Set(), abbr: null, whole: true, mid: 1 };
    cands.set(key, c);
    return c;
  };
  // what the author marked
  const mark = (text, label) => {
    const runs = contentRuns(text);
    // a lead-in or bold phrase the run rules split ("Hold and wait:", "**call
    // stack**"): taken whole, as written, when it is short and in the sentences
    if (fix.has("shapes") && (label === "lead" || label === "bold") && runs.length > 1) {
      const whole = String(text).trim().replace(/[:.]+$/, "");
      if (whole.split(/\s+/).length <= 4 && !/[,;()]/.test(whole)) {
        const c = foundAsWritten(whole);
        if (c) c.marks.add(label);
        return;
      }
    }
    // a lead-in is a term only when it is one: "Atomicity:", not "DNS stores several record types:"
    if (label === "lead" && runs.length !== 1) return;
    for (const run of runs) {
      if (run.length > MAX_TERM_WORDS) continue;
      const c = cands.get(termKey(run.map((w) => w.lower)));
      if (c) c.marks.add(label);
    }
  };
  // "Symmetric and Asymmetric Key Cryptography" names two terms: "asymmetric
  // key cryptography" and "symmetric key cryptography"
  const markHeading = (text, label) => {
    const t = String(text).replace(/^\s*\d+(\.\d+)*\.?\s+/, "");
    mark(t, label);
    const shared = t.match(/^([A-Za-z-]+)\s+(?:and|or|&|vs\.?|versus)\s+[A-Za-z-]+((?:\s+[A-Za-z-]+){1,3})$/i);
    if (shared) mark(`${shared[1]}${shared[2]}`, label);
  };
  [note?.title, ...(Array.isArray(note?.path) ? note.path : [])].filter(Boolean).forEach((t) => markHeading(t, "title"));
  for (const b of blocksOf(note)) {
    if (b.type === "heading" || b.type === "label") markHeading(b.text, "heading");
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

  // Families: two-word phrases said once each that share their main noun, when
  // that noun recurs in the note - "bus / star / ring / mesh topology". Each
  // alone could be coincidence; several kinds of one thing are terms.
  const family = new Set();
  const byHead = new Map();
  for (const c of cands.values()) {
    if (c.n < 2 || c.n > 3) continue;
    const parts = c.key.split(" ");
    const [mod, head] = [parts[0], parts[parts.length - 1]];
    if (GENERIC.has(mod) || GENERIC.has(head) || mod.length < 3 || /ed$/.test(mod) || /['’]/.test(c.key)) continue;
    if (!byHead.has(head)) byHead.set(head, []);
    byHead.get(head).push(c);
  }
  // introduced like a noun: "a bus topology", "the ring topology"
  const introduced = (c) => {
    if (c.opens) return true;
    const surface = [...c.forms.keys()][0];
    return new RegExp(`(?<![A-Za-z0-9])(?:a|an|the)\\s+${termPattern(surface, "i").source.replace("(?<![A-Za-z0-9])", "")}`, "i").test(body);
  };
  for (const [head, list] of byHead) {
    // the shared word has to be a noun the note keeps ending phrases with
    if ((cands.get(head)?.heads || 0) < 3) continue;
    const members = list.filter(introduced);
    if (members.length < 3) continue;
    for (const c of members) family.add(c.key);
  }

  if (fix.has("shapes")) {
    // named laws and methods: "Kirchhoff's current law", "Lamport's logical clock"
    for (const s of sentences) {
      for (const m of s.text.matchAll(/\b([A-Z][a-z]+(?:[-–][A-Z][a-z]+)?['’]s)\s+((?:[A-Za-z-]+\s+){0,2}[A-Za-z-]+)/g)) {
        const tail = m[2].split(/\s+/);
        // the name's object ends at its head noun: "Ohm's law states" -> "Ohm's law"
        const at = tail.findIndex((w) => NAMED_HEADS.test(w.toLowerCase()));
        if (at < 0) continue;
        const c = foundAsWritten(`${m[1]} ${tail.slice(0, at + 1).join(" ")}`);
        if (c) c.marks.add("named");
      }
    }
    // the items of a list after a colon: "Four conditions must hold for a
    // deadlock: mutual exclusion, hold and wait, no preemption and circular wait."
    for (const s of sentences) {
      const m = s.text.match(/:\s+([^:]+?)[.;]?$/);
      if (!m) continue;
      let items = m[1].split(/\s*,\s*/);
      if (items.length < 3) continue;
      const last = items[items.length - 1].replace(/^(?:and|or)\s+/i, "");
      const split = last.split(/\s+(?:and|or)\s+/i);
      items = [...items.slice(0, -1), ...(split.length === 2 && split.every((x) => x.split(/\s+/).length <= 3) ? split : [last])];
      if (!items.every((x) => x.split(/\s+/).length <= 4)) continue; // a list of clauses, not of terms
      for (const item of items) {
        const t = item.replace(/^(?:and|or|the|a|an)\s+/i, "").trim();
        if (!t || /\d/.test(t)) continue;
        const c = foundAsWritten(t);
        if (c && c.n >= 2) c.marks.add("listed");
      }
    }
  }
  if (fix.has("chunks")) {
    // noun phrases the tagger sees across words the run rules treat as verbs
    // or breaks: "procedure call", "call stack", "recursive call", "circular wait"
    for (const s of sentences) {
      const tagged = tagText(fix.has("formula") ? maskFormulas(s.text) : s.text);
      if (!tagged) break;
      const words = tagged.filter((w) => w.pos !== "SPACE");
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < Math.min(words.length, i + MAX_TERM_WORDS); j++) {
          const span = words.slice(i, j + 1);
          const ok = span.every((w, k) => (k < span.length - 1 ? ["NOUN", "PROPN", "ADJ"].includes(w.pos) : ["NOUN", "PROPN"].includes(w.pos)) && /^[A-Za-z][A-Za-z-]*$/.test(w.value));
          if (!ok) break;
          // adjacent in the text, not across punctuation
          if (span.some((w, k) => k && s.text.slice(span[k - 1].end, w.start).trim())) break;
          const key = termKey(span.map((w) => w.lower));
          if (cands.has(key)) continue;
          if (span.some((w) => GENERIC.has(w.lower) && !NOUN_GENERIC.has(w.lower))) continue;
          const c = foundAsWritten(span.map((w) => w.value).join(" "));
          if (c) c.chunk = true;
        }
      }
    }
  }

  // marks from outside the text: the student, the AI, the syllabus
  const signals = signalsOf(note);
  const phraseKey = (phrase) => termKey(String(phrase).replace(/[^A-Za-z0-9'’+\s-]+/g, " ").trim().split(/\s+/).filter(Boolean));
  const markPhrase = (phrase, label) => {
    const clean = String(phrase || "").trim();
    if (!clean || clean.length > 80) return null;
    const key = phraseKey(clean);
    if (!key) return null;
    let c = cands.get(key);
    if (!c) {
      // a term the run rules never produced ("hold and wait"): found as written
      const re = termPattern(clean);
      const hits = [];
      let surface = null;
      sentences.forEach((s, i) => {
        const m = s.text.match(re);
        if (m) {
          hits.push(i);
          surface = surface || m[0];
        }
      });
      if (!hits.length) return null;
      c = { key, n: key.split(" ").length, count: hits.length, forms: new Map([[surface, 3]]), sentences: new Set(hits), marks: new Set(), abbr: null, whole: true, mid: 1 };
      cands.set(key, c);
    }
    c.marks.add(label);
    return c;
  };
  for (const t of signals.added) markPhrase(t, "student");
  for (const { term, importance } of signals.ai) {
    const c = markPhrase(term, "ai");
    if (c) c.aiImportance = Math.max(c.aiImportance || 0, importance);
  }
  const syllabusKeys = [];
  for (const p of signals.syllabus) {
    markPhrase(p, "syllabus");
    const key = phraseKey(p);
    if (key) syllabusKeys.push(key);
  }
  const removed = new Set(signals.removed.map(phraseKey));

  // how the note uses each word, when the tagger is there
  const pos = posProfile(sentences.map((s) => s.text));
  const occurrencesOf = new Map();
  for (const o of occurrences) {
    if (!occurrencesOf.has(o.key)) occurrencesOf.set(o.key, []);
    occurrencesOf.get(o.key).push(o);
  }
  // a compound noun: nouns only, or a classifying adjective before them
  // ("relocation register", "global symbol table", "mutual exclusion") - not
  // "small fast cache" or "recent page table entries"
  const compound = (c) => {
    if (!pos || c.n < 2 || c.n > MAX_TERM_WORDS) return false;
    const words = c.key.split(" ");
    const shapes = fix.has("shapes");
    // an ordinal or a generic noun can open a term: "second derivative", "time quantum"
    const genericOpener = GENERIC.has(words[0]) && !(shapes && (ORDINALS.has(words[0]) || NOUN_GENERIC.has(words[0])));
    if (genericOpener || EVALUATIVE.has(words[0]) || /(?:er|est)$/.test(words[0]) && pos.share(words[0]) !== null && pos.share(words[0]) < 0.5) return false;
    if (GENERIC.has(words[words.length - 1]) && !NOUN_GENERIC.has(words[words.length - 1])) return false;
    // a variable, a number or a size is no part of a term said once: "user B",
    // "logical address L", "primitive root alpha", "128-bit message digest"
    if (words.some((w) => w.length === 1 || /\d/.test(w) || GREEK.has(w))) return false;
    return (occurrencesOf.get(c.key) || []).some((o) => {
      const tags = o.spans.map(([a, b]) => pos.tagAt(o.si, a, b));
      // "binding maps logical address", "a function measures how fast": a last
      // word in -s with an object after it is the sentence's verb
      if (/s$/.test(o.lastRaw || "") && ["DET", "ADJ", "NOUN", "PROPN", "NUM", "PRON", "ADV", "SCONJ"].includes(pos.tagAfter(o.si, o.spans[o.spans.length - 1][1]))) return false;
      const lastWord = words[words.length - 1];
      // a noun the tagger read as a verb here ("the relocation register holds"):
      // believed a noun when the note mostly uses it as one, or it ends like one
      const misreadNoun = shapes && tags[tags.length - 1] === "VERB" && ((pos.share(lastWord) ?? 0) >= 0.5 || NOUN_ENDING.test(lastWord));
      const lastOk = tags[tags.length - 1] === "NOUN" || tags[tags.length - 1] === "PROPN" || misreadNoun || (tags[tags.length - 1] === "VERB" && /ing$/.test(lastWord) && ["NOUN", "PROPN"].includes(tags[tags.length - 2]));
      // "growing phase", "first derivative": an -ing word or an ordinal opening the term
      const restOk = tags.slice(0, -1).every((t, i) => t === "NOUN" || t === "PROPN" || (i === 0 && (t === "ADJ" || (shapes && ((t === "VERB" && /ing$/.test(words[0])) || ORDINALS.has(words[0]) || NOUN_GENERIC.has(words[0]))))));
      return lastOk && restOk;
    });
  };

  // which candidates are terms
  const accepted = new Map();
  for (const c of cands.values()) {
    const words = c.key.split(" ");
    const first = words[0];
    const last = words[words.length - 1];
    if (removed.has(c.key)) { reject(c, "removed-by-student"); continue; }
    // a formula's variables are no terms: "R1", "1/R"
    if (!c.marks.size && words.some((w) => /^(?:[a-z]\d+|\d+[a-z]?|[a-z0-9]*\d[a-z0-9]*\/[a-z0-9]+|[a-z0-9]+\/[a-z0-9]*\d[a-z0-9]*)$/i.test(w))) { reject(c, "formula-variable"); continue; }
    const nounish = c.n >= 2 && (c.count >= 2 || c.marks.size > 0 || c.subject);
    if (words.every((w) => GENERIC.has(w)) && !(nounish && words.every((w) => NOUN_GENERIC.has(w)))) { reject(c, "all-generic"); continue; }
    // a generic noun can open a longer term that recurs or is marked ("page table", "time slice")
    if (GENERIC.has(first) && !(nounish && (NOUN_GENERIC.has(first) || TERM_ADJECTIVES.has(first))) && !(fix.has("shapes") && c.n >= 2 && (ORDINALS.has(first) || NOUN_GENERIC.has(first)) && (nounish || compound(c)))) { reject(c, "generic-first-word"); continue; }
    // a generic word can end a longer term ("sequence number", "routing
    // table") when the phrase recurs or is marked, never a single word
    if (GENERIC.has(last) && !(c.n >= 2 && NOUN_GENERIC.has(last) && (c.count >= 2 || c.marks.size || compound(c)))) { reject(c, "generic-last-word"); continue; }
    const surface = [...c.forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const acronymLike = /^[A-Z0-9][A-Z0-9/+.-]*[A-Z0-9+]$/.test(surface);
    if (c.n === 1) {
      if (last.length < 3 && !acronymLike) { reject(c, "too-short"); continue; }
      if (fix.has("formula") && !c.marks.size && GREEK.has(last)) { reject(c, "greek-letter"); continue; }
      // an everyday word ("state", "system", "memory") is a key term only when
      // the note says what it is, or the author marked it
      // (keeping everyday words said three or five times or more was measured too: worse)
      if (fix.has("common") && !acronymLike && !c.marks.size && isCommon(last) && !definesWord(surface, body)) { reject(c, "single-word-everyday"); continue; }
      // "Marshalling packs ...", "aging prevents ...": an -ing noun that is not an everyday word
      const ingNoun = fix.has("shapes") && /ing$/.test(last) && !isCommon(last) && (c.opens || articleNoun(surface, body));
      // an uncommon noun said once ("starvation", "conductance"): a term, ranked lower
      const rareNoun = fix.has("rare") && c.count === 1 && !isCommon(last) && c.heads && pos && (pos.share(surface) ?? 0) >= 0.5;
      if (rareNoun) c.weak = true;
      if (!acronymLike && !c.marks.size && !ingNoun && !rareNoun) {
        // an adjective's ending ("-ive", "-able") does not make a word an
        // adjective when the note puts an article before it: "the derivative of"
        const adjectiveEnding = /(?:ed|ous|ive|able|ible|ful|less|ish)$/.test(last) && !articleNoun(surface, body);
        const byRules = c.heads && (nounEvidence(surface, body) || nounEvidence(last, body)) && !(verbEvidence(surface, body) || looksLikeVerbS(surface, body) || adjectiveEnding);
        const share = pos ? pos.share(surface) : null;
        if (share === null) {
          if (!byRules) { reject(c, "single-word-no-noun-evidence"); continue; }
        } else if (share < 0.34 && !NOUN_ENDING.test(last)) {
          reject(c, "single-word-tagged-not-noun");
          continue; // the note uses it as a verb, an adjective or a function word
        } else if (!byRules && !(share >= 0.75 && c.count >= 2 && c.heads)) {
          reject(c, c.count < 2 ? "single-word-said-once" : !c.heads ? "single-word-only-a-modifier" : "single-word-weak-evidence");
          continue;
        }
      }
    } else {
      // adjacent once: could be coincidence - unless it is one of a family
      // ("bus topology", "star topology", "ring topology" each said once),
      // or a compound noun ("translation lookaside buffer")
      if (c.count < 2 && !c.marks.size && !family.has(c.key) && !c.subject) {
        if (!compound(c) && !c.chunk) { reject(c, "phrase-said-once-not-compound"); continue; }
        // a phrase said once made only of everyday words ("consistent state", "fixed size block")
        if (fix.has("commonphrase") && words.every((w) => isCommon(w))) { reject(c, "phrase-everyday-words"); continue; }
        c.onlyCompound = true; // said once, a term by its form alone: ranked below terms with more evidence
      }
      // the last word of a term is a noun: "routing table", not "page divides"
      if (pos && !c.marks.size) {
        const share = pos.share(surface.split(/\s+/).pop());
        if (share !== null && share < 0.34 && !/ing$/.test(last) && !NOUN_ENDING.test(last) && !(fix.has("shapes") && c.chunk)) { reject(c, "phrase-last-word-not-noun"); continue; }
      }
      // a variable, a size or a Greek letter is no part of an unmarked term: "user B", "128-bit digest", "root alpha"
      if (!c.marks.size && words.some((w) => w.length === 1 || /^\d/.test(w) || GREEK.has(w))) { reject(c, "phrase-has-variable"); continue; }
      // "block cipher encrypts": the last word is the term's verb, not part of it
      const lastSurface = surface.split(/\s+/).pop();
      // a word ending in -s before the last word is a verb or a plural
      // subject, not a modifier: "computes key", "users agree"
      if (!c.marks.size && surface.split(/\s+/).slice(0, -1).some((w) => /^[a-z]+s$/i.test(w) && !/(ss|us|is|ics|ies|ws|as|os|ous)$/i.test(w) && !/^[A-Z0-9]+s$/.test(w))) { reject(c, "phrase-inner-s-word"); continue; }
      // a garbled subscript ("PU e" from PU_e, "K s" from K_s): a lone small letter is no word
      if (surface.split(/\s+/).some((w) => /^[a-z]$/.test(w)) || surface.split(/\s+/).every((w) => w.length <= 2)) { reject(c, "phrase-garbled"); continue; }
      // ("a topology every device uses" is not one: a word the note also uses as a noun is a noun)
      const nounByTags = fix.has("shapes") && pos && (pos.share(last) ?? 0) >= 0.5;
      if (!c.marks.size && !nounByTags && ((verbEvidence(lastSurface, body) && !nounEvidence(lastSurface, body) && !family.has(c.key)) || looksLikeVerbS(lastSurface, body))) { reject(c, "phrase-ends-in-verb"); continue; }
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
  const BONUS = { title: 0.6, heading: 0.5, bold: 0.5, lead: 0.4, acronym: 0.4, student: 1, syllabus: 0.6, named: 0.5, listed: 0.3 };
  const AI_BONUS = { 1: 0.25, 2: 0.4, 3: 0.6 };
  // a term inside a syllabus topic ("deadlock" in "deadlock handling") ranks a little higher
  const inSyllabus = (key) => syllabusKeys.some((k) => k !== key && ` ${k} `.includes(` ${key} `));
  // YAKE / TextRank / RAKE (keyphraseScores.js): re-orders the accepted terms,
  // within +-25% at the default weight (KEYTERMS_SCORER_WEIGHT, 0..2)
  const signal = keyphraseSignal(runsOf, [...accepted.keys()], (w) => termKey([w]));
  const weight = scorerWeight();
  const terms = [];
  for (const c of accepted.values()) {
    const alone = c.whole ? c.count : standalone.get(c.key) || 0;
    if (alone === 0 && !c.marks.size) { reject(c, "only-inside-longer-term"); continue; } // only ever part of a longer term
    const term = displayForm(c);
    const re = termPattern(term, "i");
    const df = others.filter((t) => re.test(t)).length;
    const idf = 1 + Math.log((others.length + 1) / (df + 1));
    const bonus = 1 + [...c.marks].reduce((sum, m) => sum + (m === "ai" ? AI_BONUS[c.aiImportance] || 0.4 : BONUS[m] || 0), 0) + (!c.marks.has("syllabus") && inSyllabus(c.key) ? 0.25 : 0);
    // C-value (Frantzi et al.): a term's frequency less the average frequency
    // of the accepted longer terms it sits inside
    let freq = alone + 0.25 * (c.count - alone);
    if (fix.has("cvalue")) {
      const longer = [...accepted.values()].filter((o) => o.n > c.n && ` ${o.key} `.includes(` ${c.key} `));
      freq = longer.length ? Math.max(0.25, c.count - longer.reduce((t, o) => t + o.count, 0) / longer.length) : c.count;
    }
    const strength = Math.log2(Math.min(c.n, MAX_TERM_WORDS) + 1) * freq * (c.onlyCompound ? 0.6 : 1) * (c.weak ? 0.6 : 1);
    terms.push({
      term,
      key: c.key,
      words: c.n,
      count: c.count,
      standalone: alone,
      marks: [...c.marks],
      abbr: c.abbr,
      sentences: [...c.sentences],
      score: Number((strength * idf * bonus * (signal.has(c.key) ? 1 + weight * (signal.get(c.key) - 0.5) : 1)).toFixed(4)),
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
  // "Carrier Sense Multiple Access" is a name: its other words are capitalised too
  const name = rest.length > 0 && rest.every((w) => /^[A-Z]/.test(w));
  if (!c.mid && !c.whole && !name && /^[A-Z][a-z]+$/.test(first)) return [first.toLowerCase(), ...rest].join(" ");
  return c.surface;
}

// ---------------------------------------------------------------------------
// The whole study view of a note
// ---------------------------------------------------------------------------

const studyCache = new Map();
// cheap and stable: an edited note must never be served its old study view
function textFingerprint(text) {
  const s = String(text || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${s.length}.${h.toString(36)}`;
}
const STUDY_CACHE_LIMIT = 400;

/**
 * Everything question writing needs from one note:
 *   { sentences: [{ text, kind, section, lead, relevance?, terms: [key] }],
 *     terms: [...extractTerms, with `semantic` when the model ranked them],
 *     semantic: true when the embedding model was used }
 */
export async function studyFor(note, { corpus = [], embedder = null } = {}) {
  const cacheKey = `${note?._id}:${textFingerprint(note?.rawText)}:${signalsFingerprint(note)}:${posAvailable() ? "pos" : "nopos"}:${enabledScorers().join("+")}:${fixesKey()}:${embedder ? embedder.model : "rules"}:${corpus.length}`;
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
  // a long note gets more: one term per 40 words, up to 40 (the "limit" fix)
  const words = String(note?.rawText || "").split(/\s+/).filter(Boolean).length;
  terms = terms.slice(0, keytermFixes().has("limit") ? Math.max(MAX_TERMS, Math.min(40, Math.ceil(words / 40))) : MAX_TERMS);

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
  shownCache.clear();
}

// ---------------------------------------------------------------------------
// The terms a reader sees: highlighted in the note, listed under its title
// ---------------------------------------------------------------------------

const SHOWN_TERMS = 10;
// most single unmarked words among the terms shown (see keyTermsFor)
const MAX_PLAIN_WORDS = 3;

const acronymTerm = (t) => /^[A-Z0-9][A-Z0-9/+.-]*[A-Z0-9+]$/.test(t.term) && /[A-Z]/.test(t.term);
/**
 * A term that is a term by its form or by what the author did, not only
 * because a word recurs: several words, an acronym, marked by the author, or
 * a word the note keeps using on its own. These are what is highlighted, and
 * (without the meaning model) what a blank or a wrong option may be.
 */
export const isStrongTerm = (t) => t.words > 1 || acronymTerm(t) || t.marks.length > 0 || t.standalone >= 3;
const shownCache = new Map();

// Nouns every note in a subject uses: "data", "system", "message". Said often,
// they still say nothing about what a note is about, and highlighting them
// buries the real terms. Shown only when the note defines or marks them.
export const BROAD = new Set(
  "data information system item value user computer device node message network program result method problem input output level form object structure operation entity record file service application process state".split(" ")
);
// "A frame is the unit ...", "... is called a frame": the note says what the word is
const definedIn = (term, text) =>
  new RegExp(`(?:^|[.!?]\\s+|\\n)(?:an?\\s+|the\\s+)?${termPattern(term).source}\\s+(?:is|are)\\s+(?:an?|the|one|any|defined|called|known)\\b`, "i").test(text) ||
  new RegExp(`\\b(?:called|termed|known as|referred to as)\\s+(?:an?\\s+|the\\s+)?${termPattern(term).source}`, "i").test(text);

/**
 * Whether a strong term is worth highlighting for a reader. A phrase or an
 * acronym is. A single word is when the author marked it (bold, a heading of
 * its own, a lead-in, a spelled-out acronym - the note's title alone does not
 * count: "network" in a note titled "Computer Networks" is everywhere), or the
 * note defines it, or it is used on its own often and is not one of the broad
 * nouns every note uses.
 */
function worthShowing(t, text) {
  if (t.words > 1 || acronymTerm(t)) return true;
  const marked = t.marks.some((m) => m !== "title");
  if (marked || definedIn(t.term, text)) return true;
  return t.standalone >= 3 && !BROAD.has(t.key);
}

/**
 * A note's key terms for display, best first, as whole terms ("bus topology",
 * "Classless Inter-Domain Routing"). Stricter than what question writing may
 * use: a single word is shown only when it is an acronym, the author marked it,
 * or the note keeps using it on its own - "air", "bottom" or "process" said in
 * passing are not key terms - and a word is not shown beside the longer term
 * it belongs to ("mesh" next to "mesh topology") unless it is used alone often.
 * Rules only (no model), so it is quick and the same on every server.
 * `corpus`: the other notes of the subject, so words every note uses rank lower.
 */
export function keyTermsFor(note, corpus = [], max = SHOWN_TERMS) {
  return keyTermDetailsFor(note, corpus, max).map((t) => t.term);
}

// what each mark means to a reader
const SOURCE_OF = { student: "you", ai: "ai", syllabus: "syllabus" };

/**
 * The same terms as keyTermsFor, each with where it came from:
 * [{ term, sources: ["you" | "ai" | "syllabus" | "notes"] }]. "notes" means
 * the note's own text and layout found it. Terms the student added come first.
 */
export function keyTermDetailsFor(note, corpus = [], max = SHOWN_TERMS) {
  if (!note?.rawText) return [];
  const others = (corpus || []).filter((n) => n !== note && String(n?._id) !== String(note?._id));
  const cacheKey = `${note._id}:${textFingerprint(note.rawText)}:${signalsFingerprint(note)}:${posAvailable() ? "pos" : "nopos"}:${enabledScorers().join("+")}:${fixesKey()}:${others.length}:${textFingerprint(others.map((n) => n._id).join(","))}`;
  if (shownCache.has(cacheKey)) return shownCache.get(cacheKey).slice(0, max);

  const terms = extractTerms(note, candidateSentences(note), others);
  const acronym = acronymTerm;
  const text = String(note.rawText);
  // a possessive is a use of a term, not a term: "sender's private key"
  // ...but a named law or rule is a term: "Ohm's law", "Lamport's logical clock"
  const usePossessive = (t) => /['’]s\b/i.test(t.term) && !/['’]s\s+(?:\w+\s+)?(?:laws?|rules?|theorems?|algorithms?|principles?|clocks?|equations?|methods?|lemmas?|tests?|criteri(?:on|a))$/i.test(t.term);
  const strong = terms.filter((t) => (isStrongTerm(t) || t.marks.includes("student")) && !usePossessive(t) && worthShowing(t, text));
  const phrases = strong.filter((t) => t.words > 1);
  const partOfPhrase = (t) => t.words === 1 && phrases.some((p) => ` ${p.key} `.includes(` ${t.key} `));
  // "Remote Procedure" beside "Remote Procedure Call": a piece of a longer
  // term that the note never uses on its own is not a term to show
  const onlyInside = (t) =>
    t.words > 1 &&
    phrases.some((p) => p.words > t.words && ` ${p.key} `.includes(` ${t.key} `) && (text.match(termPattern(t.term)) || []).length <= (text.match(termPattern(p.term)) || []).length);
  const candidates = strong.filter((t) => (!partOfPhrase(t) || t.standalone >= 4 || acronym(t)) && !onlyInside(t));
  // Whole terms first: a single everyday word ("layer", "bit", "link") is at
  // best a weak key term, so at most a few of them are shown - those the
  // author set in bold or as a lead-in are not counted - and only behind the
  // phrases and acronyms when there are enough of those to fill the list.
  const plainWord = (t) => t.words === 1 && !acronym(t) && !t.marks.some((m) => m === "bold" || m === "lead" || m === "acronym" || m === "student");
  let words = 0;
  const kept = candidates.filter((t) => !plainWord(t) || ++words <= MAX_PLAIN_WORDS);
  // what the student added is always shown, first
  const byStudent = terms.filter((t) => t.marks.includes("student"));
  const shown = [...byStudent, ...kept.filter((t) => !t.marks.includes("student"))].map((t) => {
    const sources = [...new Set(t.marks.map((m) => SOURCE_OF[m]).filter(Boolean))];
    return { term: t.term, sources: t.marks.some((m) => !SOURCE_OF[m]) || !sources.length ? [...sources, "notes"] : sources };
  });

  if (shownCache.size >= STUDY_CACHE_LIMIT) shownCache.delete(shownCache.keys().next().value);
  shownCache.set(cacheKey, shown);
  return shown.slice(0, max);
}

/**
 * Noun phrases of `text` that could be key points of an answer, longest
 * first: whole runs of 2-3 content words ("total internal reflection") that
 * do not end in a verb, then single words of 5+ letters that are not part of
 * one of those phrases. `noteText` is where verb use is checked.
 */
export function phrasesIn(text, noteText = text) {
  const phrases = [];
  const singles = [];
  // a long run is split at its generic words: "two insulated copper wires" -> "insulated copper wires"
  const segments = contentRuns(text).flatMap((run) => {
    if (run.length <= 3) return [run];
    const parts = [[]];
    for (const w of run) {
      if (GENERIC.has(w.lower)) parts.push([]);
      else parts[parts.length - 1].push(w);
    }
    return parts.filter((p) => p.length);
  });
  for (const run of segments) {
    let words = run;
    while (words.length && GENERIC.has(words[0].lower)) words = words.slice(1);
    while (words.length && GENERIC.has(words[words.length - 1].lower)) words = words.slice(0, -1);
    if (words.length >= 2 && words.length <= 3) {
      const last = words[words.length - 1].raw;
      // "data travels around the ring": the last word is the verb
      if (!/(ed|ing)$/i.test(last) && !looksLikeVerbS(last, noteText) && !verbEvidence(last, text)) phrases.push(words.map((w) => w.raw).join(" "));
      continue;
    }
    // a single word only when the note does not use it as a verb ("cancels out")
    if (words.length === 1 && words[0].lower.length >= 5 && !/(ed|ing)$/.test(words[0].lower) && !looksLikeVerbS(words[0].raw, noteText) && !verbEvidence(words[0].raw, noteText))
      singles.push(words[0].raw);
  }
  const inPhrase = (w) => phrases.some((p) => p.toLowerCase().split(" ").includes(w.toLowerCase()));
  return [...new Set([...phrases, ...singles.filter((w) => !inPhrase(w))])];
}
