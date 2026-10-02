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

// "Atomicity: all or nothing" / "Wait-die - the older one waits": the term a
// line opens with, when it is short enough to be a term and not a clause.
function leadInLength(text) {
  const m = text.match(/^([A-Z0-9(][^:.!?\n]{1,48}?):\s+\S/) || text.match(/^([A-Z0-9(][^:.!?\n]{1,48}?)\s[–—-]\s+\S/);
  if (!m) return 0;
  return m[1].trim().split(/\s+/).length <= 5 ? m[1].length : 0;
}

// First whole-word use of `word` (or its plural) in `text`, as [start, end].
function findWord(text, word) {
  const m = new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(word)}(?:s|es)?)(?![A-Za-z0-9])`, "i").exec(text);
  return m ? [m.index + m[1].length, m.index + m[1].length + m[2].length] : null;
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
    const at = text.indexOf(term);
    if (at >= 0) ranges.push([at, at + term.length]);
  }
  const covered = (s, e) => ranges.some(([a, b]) => s < b && e > a);
  for (const k of keywords) {
    if (used.has(k)) continue;
    const hit = findWord(text, k);
    if (!hit) continue;
    used.add(k);
    if (!covered(hit[0], hit[1])) ranges.push(hit);
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
  const stem = (k) => (k.length > 4 ? k.replace(/(ing|es|s)$/, "") : k);
  const seen = new Set();
  return (keywords || []).filter((k) => !seen.has(stem(k)) && seen.add(stem(k)));
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
