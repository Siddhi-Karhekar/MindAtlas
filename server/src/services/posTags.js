// Part-of-speech tags for key-term finding: which words a note uses as nouns.
//
// The key-term rules (keyTerms.js) used to guess a word's part of speech from
// its neighbours ("a word after 'the' is a noun") and its ending ("-ive" is an
// adjective), which let verbs and adjectives through as key terms ("solve",
// "smaller") and kept real nouns out ("derivative"). A statistical tagger,
// wink-nlp with its small English model (MIT licence, about 60 MB of memory,
// loaded on first use), tags each word of each sentence instead.
//
// The tagger is EVIDENCE, not the final word: it misreads some technical
// sentences ("a small fast cache" -> "cache" as a verb), and it tags a noun
// used before another noun as an adjective ("public key" -> ADJ ADJ, "the
// current through" -> ADJ). So an ADJ tag counts as "not sure": share() is the
// share of NOUN/PROPN among a word's other tags, and keyTerms.js only lets it
// veto a word the note uses as a verb or function word, rescue a word it
// clearly uses as a noun, and admit a compound noun said once ("global
// symbol table").
//
//   KEYTERMS_POS=off   switches the tagger off (the rules work as before)
// If the library is missing or fails to load, the same happens, once logged.

import { createRequire } from "node:module";

let nlp = null;
let failed = false;
const enabled = () => !/^(?:off|false|0|no)$/i.test(String(process.env.KEYTERMS_POS || "").trim());

function tagger() {
  if (!enabled() || failed) return null;
  if (nlp) return nlp;
  try {
    const require = createRequire(import.meta.url);
    const winkNLP = require("wink-nlp");
    const model = require("wink-eng-lite-web-model");
    nlp = winkNLP(model);
  } catch (err) {
    failed = true;
    console.warn("[keyterms] part-of-speech tagger unavailable, rules only:", err?.message || err);
  }
  return nlp;
}

/** Whether tags are available right now (for reports and tests). */
export const posAvailable = () => Boolean(tagger());

const NOUNISH = new Set(["NOUN", "PROPN"]);
const SKIP = new Set(["PUNCT", "PART", "SYM", "SPACE", "X"]);
const MAX_CHARS = 200_000; // tagging is linear; a very long note is tagged in part

/**
 * The words of `text` with their tags and where they sit:
 * [{ value, lower, pos, start, end }]. Null without a tagger.
 */
export function tagText(text) {
  const t = tagger();
  if (!t) return null;
  const str = String(text || "").slice(0, MAX_CHARS);
  const doc = t.readDoc(str);
  const values = doc.tokens().out(t.its.value);
  const tags = doc.tokens().out(t.its.pos);
  const out = [];
  let at = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const start = str.indexOf(v, at);
    if (start < 0) continue; // the tokenizer normalised it: skip, keep the cursor
    at = start + v.length;
    out.push({ value: v, lower: v.toLowerCase(), pos: tags[i], start, end: at });
  }
  return out;
}

/**
 * Tags for the sentences of a note, and how each word is used across them:
 *   share(word)          share of its uses tagged NOUN/PROPN (null when never tagged)
 *   tagAt(i, from, to)   the tag of the word at characters [from, to) of sentence i
 * Null without a tagger.
 */
export function posProfile(texts) {
  if (!tagger()) return null;
  const counts = new Map(); // lower -> { noun, all } (ADJ not counted: see above)
  const tagged = texts.map((text) => {
    const words = tagText(text) || [];
    for (const w of words) {
      if (SKIP.has(w.pos) || w.pos === "ADJ" || !/[a-z]/i.test(w.value)) continue;
      const c = counts.get(w.lower) || { noun: 0, all: 0 };
      c.all += 1;
      if (NOUNISH.has(w.pos)) c.noun += 1;
      counts.set(w.lower, c);
    }
    return words;
  });
  const keyOf = (w) => String(w).toLowerCase().replace(/['’]s$/, "");
  return {
    share(word) {
      // "fixed-size" is tagged in pieces: its last piece says what it is
      const parts = keyOf(word).split("-").filter(Boolean);
      const c = counts.get(keyOf(word)) || counts.get(parts[parts.length - 1]);
      return c && c.all ? c.noun / c.all : null;
    },
    /** The tag of the first word starting at or after character `from` of sentence i (the word after a term). */
    tagAfter(i, from) {
      const next = (tagged[i] || []).find((w) => w.start >= from && w.pos !== "SPACE");
      return next ? next.pos : null;
    },
    tagAt(i, from, to) {
      // the last word inside [from, to) that carries meaning ("Kirchhoff's" -> Kirchhoff)
      const inside = (tagged[i] || []).filter((w) => w.start < to && w.end > from && !SKIP.has(w.pos));
      return inside.length ? inside[inside.length - 1].pos : null;
    },
  };
}

/**
 * A filter for single-word TF-IDF keywords: false for a word the text uses
 * mostly as something other than a noun ("any", "called", "solve"). True for
 * every word when no tagger is available, or for a word it never tagged.
 */
export function nounFilter(text) {
  const profile = posProfile([String(text || "")]);
  if (!profile) return () => true;
  return (word) => {
    const s = profile.share(word);
    return s === null || s >= 0.5;
  };
}
