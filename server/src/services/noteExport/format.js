// How a note's text is dressed, for the downloadable files.
//
// The rule is the one the reading pane follows: a topic has one colour, and
// only its headings and key terms wear it - body text stays plain.
//
// Everything down to `colorSections` is a copy of client/src/lib/noteFormat.js
// and the outline helpers are a copy of client/src/lib/notes.js, because the
// server cannot import client code once deployed. A download has to mark the
// same words and give the same topic the same colour as the screen does, so
// test/noteExport.test.mjs runs both copies on the same notes and fails if
// they disagree. Change one, change the other.

export const TOPIC_COLORS = 6;

// --c-topic-1..6 of the light theme (client/src/index.css): paper is white
export const TOPIC_HEX = ["#2a62b8", "#b4481f", "#15775c", "#7d44b0", "#8f6400", "#b82e6a"];
// the light theme's text colours: --c-on-surface, --c-on-surface-variant,
// --c-outline and --c-primary
export const INK = "#33352e"; // body text
export const MUTED = "#6a6d63"; // captions, page numbers
export const RULE = "#b9b6a6"; // table borders
export const PRIMARY = "#364156"; // a heading with no topic colour of its own

/** The colour for a topic index (wraps around); null = no topic colour. */
export function topicHex(index) {
  if (index === null || index === undefined) return PRIMARY;
  return TOPIC_HEX[((index % TOPIC_COLORS) + TOPIC_COLORS) % TOPIC_COLORS];
}

/** A pale tint of a colour, for table heads and rules (`amount` of white mixed in). */
export function tint(hex, amount = 0.88) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
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
 * Split one block's text into [{ text, mark }] pieces. Marked pieces are the
 * terms the author set in bold, the term a line opens with, and each of the
 * note's keywords the first time it appears (`used` remembers which are spent).
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
 * A note's `content` blocks -> the same blocks with `segments` (see markText)
 * on paragraphs and list entries, and each run of list entries gathered into
 * one { type: "list", items } tree.
 */
export function layoutContent(content, keywords = []) {
  const out = [];
  const used = new Set();
  let run = null;
  keywords = distinctKeywords(keywords);
  for (const b of content || []) {
    if (b.type === "item") {
      if (!run) out.push({ type: "list", items: (run = []) });
      run.push({ ...b, segments: markText(b.text, { strong: b.strong, keywords, used }) });
      continue;
    }
    run = null;
    if (b.type === "heading") out.push(b);
    else if (b.type === "para") out.push({ ...b, segments: markText(b.text, { strong: b.strong, keywords, used }) });
    else out.push(b);
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

// ---------------------------------------------------------------------------
// A document's outline (copy of client/src/lib/notes.js)
// ---------------------------------------------------------------------------

/** The headings a subtopic sits under, outermost first. */
export function notePath(n) {
  if (Array.isArray(n?.path) && n.path.length) return n.path;
  return n?.sectionGroup ? [n.sectionGroup] : []; // notes saved before `path` existed
}

const sameTitle = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * A document's subtopics as a nested outline, in document order. Returns the
 * top-level nodes: { key, title, depth, item, children, colorIndex }. `item`
 * is the note, or null for a heading that only groups others. `colorIndex`
 * numbers the main topics; everything below a main topic shares its colour.
 */
export function outlineTree(items) {
  const root = { children: [] };
  let groups = 0;
  (items || []).forEach((item, i) => {
    let at = root;
    notePath(item).forEach((title, depth) => {
      const last = at.children[at.children.length - 1];
      if (last && sameTitle(last.title, title)) at = last;
      else {
        const group = { key: `group-${groups++}`, title, depth, item: null, children: [] };
        at.children.push(group);
        at = group;
      }
    });
    at.children.push({ key: String(item._id ?? `item-${i}`), title: item.title, depth: notePath(item).length, item, children: [] });
  });
  const paint = (node, colorIndex) => {
    node.colorIndex = colorIndex;
    node.children.forEach((c) => paint(c, colorIndex));
  };
  root.children.forEach((top, i) => paint(top, i));
  return root.children;
}

/** Outline nodes in reading order, each with `trail`: the titles above it. */
export function flattenOutline(nodes, trail = []) {
  return nodes.flatMap((n) => [{ ...n, trail }, ...flattenOutline(n.children, [...trail, n.title])]);
}
