// How a note's text is dressed for reading. The rule everywhere is the same:
// a topic has one colour, and only its headings and key terms wear it - body
// text stays plain. This file decides which words are key terms; the colours
// themselves are CSS variables (--c-topic-1..6 in index.css).

export const TOPIC_COLORS = 6;

/** CSS class that sets --topic to the nth topic colour (wraps around). */
export function topicClass(index) {
  if (index === null || index === undefined) return "note-topic-none";
  return `note-topic-${(((index % TOPIC_COLORS) + TOPIC_COLORS) % TOPIC_COLORS) + 1}`;
}

/** The same colour every time for the same note id. */
export function stableColorIndex(id) {
  let h = 0;
  for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % TOPIC_COLORS;
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Openers shaped like a lead-in that name no term: "Note:", "For example:",
// "Step 2:", "In this case -", "Advantages:", "Q1:".
const NOT_A_LEAD =
  /^(?:notes?|nb|examples?|e\.?g|i\.?e|for (?:example|instance)|such as|steps?|stages?|phases?|case|answer|ans|solution|question|q\d*|hint|tip|remember|important|warning|caution|definition|meaning|explanation|reasons?|results?|output|input|advantages?|disadvantages?|merits?|demerits?|features?|types?|kinds?|uses?|applications?|characteristics?|properties|summary|conclusion|introduction|overview|in (?:this|that|other|short|general|practice|summary|brief)|on the other hand|that is|thus|hence|therefore|however|also|here|there|this|these|those|it|they|the following|following|see|refer)\b/i;
// a clause, not a term: "The sender waits -", "We assume:"
const CLAUSE = /\b(?:is|are|was|were|has|have|had|can|could|will|would|shall|should|may|might|must|does|do|did|we|you|our|your|i)\b/i;

// "Atomicity: all or nothing" / "Wait-die - the older one waits": the term a
// line opens with, when it is short enough to be a term and not a clause or a
// label such as "Note:" or "Step 2:".
function leadInLength(text) {
  const m = text.match(/^([A-Z0-9(][^:.!?\n]{1,48}?):\s+\S/) || text.match(/^([A-Z0-9(][^:.!?\n]{1,48}?)\s[–—-]\s+\S/);
  if (!m) return 0;
  const lead = m[1].trim();
  const words = lead.split(/\s+/);
  if (words.length > 4 || NOT_A_LEAD.test(lead) || CLAUSE.test(lead)) return 0;
  // "The sender waits:" - an article and two more words is a clause, unless
  // the rest is a name ("The Internet Protocol")
  if (words.length >= 3 && /^(?:the|a|an)$/i.test(words[0]) && !words.slice(1).every((w) => /^[A-Z0-9]/.test(w))) return 0;
  // "1.2", "(a)": a number or a letter, not a term
  if (!/[A-Za-z]{2}/.test(lead)) return 0;
  return m[1].length;
}

// `term` as whole words in `text` ("IP" not inside "SHIP"), or -1.
function indexOfWhole(text, term) {
  const t = String(term || "").trim();
  if (!t) return -1;
  const m = new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(t)})(?![A-Za-z0-9])`).exec(text);
  return m ? m.index + m[1].length : -1;
}

// First whole-term use of `term` in `text`, as [start, end]. A term of several
// words is matched whole, across any spacing or a hyphen ("data link layer",
// "point-to-point link"), with its last word singular or plural ("ring
// topologies" for "ring topology"). An acronym given straight after it is
// part of the match: "local area network (LAN)" is marked as one. `skip`
// passes over uses inside a longer term already marked ("layer" in "network layer").
function termRegex(term) {
  const words = String(term).trim().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return null;
  const last = words[words.length - 1];
  const lastRe = /[^aeiou]y$/i.test(last)
    ? `(?:${escapeRe(last)}s?|${escapeRe(last.slice(0, -1))}ies)`
    : `${escapeRe(last.replace(/s$/i, ""))}(?:s|es)?`;
  const body = [...words.slice(0, -1).map(escapeRe), last.length > 3 ? lastRe : `${escapeRe(last)}(?:s|es)?`].join("[\\s-]+");
  return new RegExp(`(^|[^A-Za-z0-9])(${body})(?![A-Za-z0-9])(\\s*\\([A-Z][A-Za-z0-9/-]{1,9}\\))?`, "gi");
}

// Every whole-term use of `term` in `text`, as [start, end] pairs.
function allTerms(text, term) {
  const re = termRegex(term);
  if (!re) return [];
  return [...text.matchAll(re)].map((m) => {
    const start = m.index + m[1].length;
    return [start, start + m[2].length + (m[3] ? m[3].length : 0)];
  });
}

function findTerm(text, term, skip = () => false) {
  const re = termRegex(term);
  if (!re) return null;
  for (const m of text.matchAll(re)) {
    const start = m.index + m[1].length;
    const hit = [start, start + m[2].length + (m[3] ? m[3].length : 0)];
    if (!skip(hit)) return hit;
  }
  return null;
}

/**
 * Split one block's text into [{ text, mark }] pieces. Marked pieces are:
 *   - the terms the author set in bold (`strong`),
 *   - the term a line opens with ("Atomicity: ..."),
 *   - each of the note's keywords, the first time it appears in the note - the
 *     way a textbook sets a term in bold where it is introduced, not every
 *     time it is used (`used` remembers which have been spent).
 */
export function markText(text, { strong = [], keywords = [], used = new Set() } = {}) {
  const ranges = [];
  const lead = leadInLength(text);
  if (lead) ranges.push([0, lead]);
  for (const term of strong) {
    const at = indexOfWhole(text, term);
    if (at >= 0) ranges.push([at, at + String(term).trim().length]);
  }
  const overlaps = (list) => (s, e) => list.some(([a, b]) => s < b && e > a);
  // what the author marked: a term already set in bold there counts as introduced
  const byAuthor = overlaps([...ranges]);
  const covered = overlaps(ranges);
  // longest first, so "data link layer" is marked whole before "layer" can take a piece of it
  const byLength = [...keywords].sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length);
  // every use of a longer key term: a shorter one ("layer") is never marked
  // inside one ("data link layer"), even where that use is not itself marked
  const wordsOf = (t) => ` ${String(t).toLowerCase().trim().split(/[\s-]+/).join(" ")} `;
  for (const k of byLength) {
    if (used.has(k)) continue;
    const longer = byLength.filter((l) => l !== k && wordsOf(l).length > wordsOf(k).length && wordsOf(l).includes(wordsOf(k)));
    const inLonger = overlaps(longer.flatMap((l) => allTerms(text, l)));
    const first = findTerm(text, k, ([s, e]) => inLonger(s, e));
    if (!first) continue;
    used.add(k);
    if (byAuthor(first[0], first[1])) continue;
    const hit = findTerm(text, k, ([s, e]) => covered(s, e) || inLonger(s, e));
    if (!hit) continue;
    ranges.push(hit);
  }
  if (ranges.length === 0) return [{ text, mark: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) out.push({ text: text.slice(pos, s), mark: false });
    out.push({ text: text.slice(s, e), mark: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), mark: false });
  return out;
}

// "lock", "locks" and "locking" are one term to a reader: keep the first.
function distinctKeywords(keywords) {
  const stem = (k) => String(k).toLowerCase().trim().split(/\s+/).map((w) => (w.length > 4 ? w.replace(/(ing|es|s)$/, "") : w)).join(" ");
  const seen = new Set();
  return (keywords || []).filter((k) => k && !seen.has(stem(k)) && seen.add(stem(k)));
}

/** Consecutive list entries (flat, with `depth`) -> a nested tree. */
function nestItems(items) {
  const root = { children: [] };
  const stack = [{ depth: -1, node: root }];
  for (const it of items) {
    while (stack[stack.length - 1].depth >= it.depth) stack.pop();
    const node = { ...it, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth: it.depth, node });
  }
  return root.children;
}

/**
 * A note's `content` blocks -> what the reading pane renders: the same blocks
 * with `segments` (see markText) on paragraphs and list entries, and each run
 * of list entries gathered into one { type: "list", items } tree.
 */
export function layoutContent(content, keywords = []) {
  const out = [];
  const used = new Set();
  let run = null;
  keywords = distinctKeywords(keywords);
  // `index`: where the block is in `content`, for editing the note line by line
  for (const [index, b] of (content || []).entries()) {
    if (b.type === "item") {
      if (!run) out.push({ type: "list", items: (run = []) });
      run.push({ ...b, index, segments: markText(b.text, { strong: b.strong, keywords, used }) });
      continue;
    }
    run = null;
    if (b.type === "heading") out.push({ ...b, index });
    else if (b.type === "para") out.push({ ...b, index, segments: markText(b.text, { strong: b.strong, keywords, used }) });
    else out.push({ ...b, index });
  }
  return out.map((b) => (b.type === "list" ? { ...b, items: nestItems(b.items) } : b));
}

/**
 * Group laid-out blocks into colour sections. With `bySection`, every level-1
 * heading starts a new section in the next topic colour (or the colour
 * `colorOf(headingText)` gives it; `null` = no topic colour). Otherwise the
 * whole note is one section in `baseIndex`.
 */
export function colorSections(blocks, { baseIndex = 0, bySection = false, colorOf = null } = {}) {
  const tops = blocks.filter((b) => b.type === "heading" && b.level === 1).length;
  if (!bySection || tops < 2) return [{ colorIndex: baseIndex, blocks }];
  const sections = [];
  let next = baseIndex;
  let cur = null;
  for (const b of blocks) {
    if (b.type === "heading" && b.level === 1) {
      const colorIndex = colorOf ? colorOf(b.text) ?? null : next++;
      sections.push((cur = { colorIndex, blocks: [b] }));
    } else {
      if (!cur) sections.push((cur = { colorIndex: null, blocks: [] })); // text before the first heading
      cur.blocks.push(b);
    }
  }
  return sections;
}

/**
 * A note's key terms as a reader should see them: whole terms ("bus
 * topology", "data link layer") worked out by the server (`keyTerms`), or the
 * single TF-IDF `keywords` for a note that arrived without them.
 */
export function termsOf(note) {
  return Array.isArray(note?.keyTerms) ? note.keyTerms : note?.keywords || [];
}

/** The words a content block shows (a table: all its cells), as the server checks them. */
export function lineText(block) {
  if (!block) return "";
  if (block.type === "table") return (block.rows || []).flat().join(" ");
  return String(block.text || "");
}
