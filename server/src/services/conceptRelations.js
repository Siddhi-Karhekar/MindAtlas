// How the key terms of a subject relate to each other, read from the notes'
// own wording. Two uses:
//
//   distractors   a good wrong option is the same KIND of thing as the
//                 answer: beside "exclusive lock", "shared lock" (a sibling
//                 in the same list), not "stable storage" (another topic).
//   ambiguity     a wrong option that CONTAINS the answer, or is contained by
//                 it, can be defended: if the notes say "the SHA-2 family
//                 includes SHA-256 and SHA-512", then "SHA-2" beside the answer
//                 "SHA-512" is arguably right too.
//
// Read from the notes, in a few forms an author uses:
//   category   "A lock is a mechanism to ...": lock -> mechanism
//              "Wait-die and wound-wait are deadlock prevention schemes"
//   hypernym   "W such as X, Y and Z", "W include(s) X and Y",
//              "X is a type / kind / form / example of W", "the W family"
//   siblings   the entries of one list ("Shared lock: ...", "Exclusive lock
//              (X): ..."), the items of one enumeration ("X, Y and Z")
// Nothing here is a model: it is pattern reading, so it finds the relations
// a note states, and misses the ones it only implies.

import { termKey, termPattern } from "./keyTerms.js";

const CATEGORY_NOUN = /^[a-z][a-z-]{2,}$/;
const singular = (w) => (w.length > 4 && /[^su]s$/.test(w) && !/(?:ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
const NOT_CATEGORY = new Set("way set part kind type form number piece lot one thing example process method".split(" "));

// "mutual exclusion, hold and wait, no preemption and circular wait": runs of
// short comma-separated items ending in "and"/"or" (an item may itself hold
// "and", so the last split is tried both ways by the caller's term check)
function enumerations(text) {
  const out = [];
  for (const clause of String(text).split(/[.;:()]/)) {
    const parts = clause.split(/,\s*/);
    if (parts.length < 2) continue;
    const last = parts.pop();
    const m = /^(.*?)\s+(?:and|or)\s+(.+)$/.exec(last);
    const items = [...parts, ...(m ? [m[1], m[2]] : [last])].map((x) => x.replace(/^(?:and|or)\s+/, "").replace(/^(?:the|a|an)\s+/i, "").trim());
    // the first item may carry the clause's opening words ("must hold: X") - keep its last four words
    items[0] = items[0].split(/\s+/).slice(-4).join(" ");
    if (items.every((x) => x && x.split(/\s+/).length <= 4)) out.push(items);
  }
  return out;
}


/** { categoryOf, parentsOf, siblingsOf } over the terms of these studies. */
export function buildRelations(notes, studies) {
  const terms = [];
  const seen = new Set();
  for (const n of notes) {
    for (const t of studies.get(n)?.terms || []) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      terms.push(t);
    }
  }
  // "TCP" stands for "transmission control protocol": compared by what it stands for
  const expansionOf = new Map(terms.filter((t) => t.abbr).map((t) => [t.abbr.toLowerCase(), t.key]));
  const categoryOf = new Map();
  const parentsOf = new Map();
  const siblingsOf = new Map();
  const add = (map, k, v) => {
    if (!k || !v || k === v) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(v);
  };
  const keyOfPhrase = (phrase) => {
    const k = termKey(String(phrase).toLowerCase().replace(/[^a-z0-9 /+-]/g, " ").replace(/\s+/g, " ").trim());
    return seen.has(k) ? k : null;
  };

  // Each term's patterns, built once. (Building them afresh for every term in
  // every sentence made a test from 28 notes spend seconds here alone.)
  const patterns = terms.map((t) => {
    const tp = termPattern(t.term, "i").source;
    return {
      ...t,
      // the term's first letters as written: every mention, singular or plural, contains them
      lead: String(t.term).trim().split(/\s+/)[0].toLowerCase().slice(0, 3),
      mention: new RegExp(tp, "i"),
      category: new RegExp(`(?:^|[.;]\\s+)(?:an?\\s+|the\\s+)?${tp}\\s+(?:\\([^)]*\\)\\s+)?(?:is|are)\\s+(?:an?|the|one of the)\\s+((?:[a-z][a-z-]*\\s+){0,3}?)([a-z][a-z-]+)(?=\\s+(?:that|which|who|where|used|in|of|for|to|with|by|whose|on)\\b|[,.;:]|$)`, "i"),
      kind: new RegExp(`${tp}\\s+(?:is|are)\\s+(?:an?|one)\\s+(?:type|kind|form|example|member|variant|special case|subclass|instance)s?\\s+of\\s+(?:the\\s+|an?\\s+)?([A-Za-z][\\w -]{2,40}?)(?=[,.;:]|\\s+(?:that|which|in|used|where)\\b|$)`, "i"),
    };
  });

  for (const n of notes) {
    const study = studies.get(n);
    if (!study) continue;
    // siblings: list entries that open with a term, under one section
    const bySection = new Map();
    // the study sentences, and every other sentence of the note: a relation is
    // often stated in a line too short or too full of names to be asked about
    // ("The SHA-2 family includes SHA-256 and SHA-512.")
    const known = new Set(study.sentences.map((x) => x.text));
    const extra = String(n.rawText || "")
      .split(/\n\s*\n|(?<=[.!?])\s+/)
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x.length > 12 && x.length < 400 && !known.has(x))
      .map((text) => ({ text, kind: "para" }));
    for (const s of [...study.sentences, ...extra]) {
      const text = s.text;
      if (s.kind === "item" && s.lead) {
        const k = keyOfPhrase(s.lead.replace(/\s*\([^)]*\)\s*$/, ""));
        if (k) {
          const sec = s.section || "";
          if (!bySection.has(sec)) bySection.set(sec, new Set());
          bySection.get(sec).add(k);
        }
      }
      const lower = text.toLowerCase();
      for (const t of patterns) {
        // most terms are not in a given sentence: skip them before any pattern runs
        if (!lower.includes(t.lead) || !t.mention.test(text)) continue;
        // category: "A lock is a mechanism ...", "X is an integer variable that ..."
        const m = t.category.exec(text);
        const noun = m ? singular(m[2].toLowerCase()) : null;
        if (m && CATEGORY_NOUN.test(noun) && !NOT_CATEGORY.has(noun) && !/(?:ly|ed|ing)$/.test(noun)) {
          if (!categoryOf.has(t.key)) categoryOf.set(t.key, noun);
          // "a symmetric key cipher": the whole phrase may itself be a term
          const whole = keyOfPhrase(`${m[1]}${m[2]}`);
          if (whole && whole !== t.key) add(parentsOf, t.key, whole);
        }
        // "X is a type / kind / form / example / member of W"
        const kind = t.kind.exec(text);
        if (kind) add(parentsOf, t.key, keyOfPhrase(kind[1]));
      }
      // "W such as X, Y and Z" / "W include(s) X, Y and Z" / "the W family includes X"
      const hyper = /([A-Za-z][\w -]{2,40}?)\s+(?:family\s+)?(?:such as|including|includes?|consists? of|comprises?|e\.g\.)\s+([^.;:]+)/i.exec(text);
      if (hyper) {
        // the hypernym is the phrase right before "such as": its last one to three words
        const before = hyper[1].trim().split(/\s+/);
        // (a family the notes name only once, "the SHA-2 family", is no key
        // term, and still the parent: its name is kept as written)
        const last = before[before.length - 1]?.toLowerCase().replace(/[^a-z0-9/+-]/g, "");
        const head = [3, 2, 1].map((n) => keyOfPhrase(before.slice(-n).join(" "))).find(Boolean) || (last && !/^(?:the|a|an|and|or|of)$/.test(last) ? termKey(singular(last)) : null);
        // the members: the items right after it, while each is a term
        const members = [];
        for (const item of hyper[2].split(/,\s*|\s+(?:and|or)\s+/)) {
          const w = item.replace(/^(?:the|a|an)\s+/i, "").trim().split(/\s+/);
          const k = keyOfPhrase(w.slice(0, 4).join(" ")) || [3, 2, 1].map((n) => keyOfPhrase(w.slice(0, n).join(" "))).find(Boolean);
          if (!k) break;
          members.push(k);
          if (w.length > 4) break; // the list ends inside this item ("DNS handle their own ...")
        }
        for (const k of members) {
          if (head) add(parentsOf, k, head);
          for (const j of members) if (j !== k) add(siblingsOf, k, j);
        }
      }
      // "X, Y and Z" in one sentence: items of one enumeration are siblings,
      // when every item is itself a term (not "the sender, the receiver and
      // a key that ...")
      for (const run of enumerations(text)) {
        const members = run.map(keyOfPhrase);
        if (members.length >= 3 && members.every(Boolean) && new Set(members).size === members.length) for (const k of members) for (const j of members) if (j !== k) add(siblingsOf, k, j);
      }
    }
    for (const group of bySection.values()) if (group.size >= 2) for (const k of group) for (const j of group) if (j !== k) add(siblingsOf, k, j);
  }
  // terms whose category is the same noun are of one kind: "shared lock" and
  // "exclusive lock" are both "locks"
  return { categoryOf, parentsOf, siblingsOf, expansionOf };
}

const headOf = (key) => String(key || "").split(" ").pop();

/**
 * How alike two terms are as kinds of thing: 1 siblings, one category or one
 * main noun; 0.75 the same qualifier; 0.5 nothing known; 0 one is the other's
 * category.
 */
export function kinship(rel, a, b) {
  if (!rel || !a || !b) return 0.5;
  if (rel.siblingsOf.get(a)?.has(b)) return 1;
  a = rel.expansionOf?.get(a) || a;
  b = rel.expansionOf?.get(b) || b;
  if (rel.siblingsOf.get(a)?.has(b)) return 1;
  const ca = rel.categoryOf.get(a);
  if (ca && ca === rel.categoryOf.get(b)) return 1;
  if (a.includes(" ") && b.includes(" ") && headOf(a) === headOf(b)) return 1;
  // "distributed system" / "distributed computing": the same qualifier, a neighbouring idea
  if (a.includes(" ") && b.includes(" ") && a.split(" ")[0] === b.split(" ")[0]) return 0.75;
  // one is the other's stated category ("mechanism" beside "lock"): not alike
  if (ca === b || rel.categoryOf.get(b) === a) return 0;
  return 0.5;
}

/** True when the notes say one term is a kind of the other (either way): both could be defended. */
export function isHypernymPair(rel, a, b) {
  if (!rel || !a || !b || a === b) return false;
  const up = (x, y, depth = 0) => depth < 3 && [...(rel.parentsOf.get(x) || [])].some((p) => p === y || up(p, y, depth + 1));
  return up(a, b) || up(b, a);
}
