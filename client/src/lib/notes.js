// Helpers for the two-level note hierarchy: a long uploaded document is saved
// as a PARENT note (childCount > 0) plus one CHILD note per subtopic
// (parentNoteId set). Ordinary notes have neither. Works on both the notes
// list (`_id`) and graph nodes (`id`).
//
// Storage is two levels, but a document's outline can be deeper: each child
// carries `path`, the headings above it in the source, outermost first
// (["Unit 3", "Memory Management"]). outlineTree() turns a document's children
// back into that outline for display.

const idOf = (n) => String(n._id ?? n.id);

export function isSplitParent(n) {
  return !n.parentNoteId && (n.childCount || 0) > 0;
}

/** Topic notes are everything a question can be about: all but split parents. */
export function isTopicNote(n) {
  return !isSplitParent(n);
}

/**
 * Group notes for display: top-level notes (newest first) and each parent's
 * children in document order.
 */
export function noteTree(notes) {
  const list = notes || [];
  const childrenOf = new Map();
  for (const n of list) {
    if (!n.parentNoteId) continue;
    const key = String(n.parentNoteId);
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n);
  }
  for (const kids of childrenOf.values()) kids.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const ids = new Set(list.map(idOf));
  // a child whose parent is missing is shown at top level rather than lost
  const top = list
    .filter((n) => !n.parentNoteId || !ids.has(String(n.parentNoteId)))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { top, childrenOf: (n) => childrenOf.get(idOf(n)) || [] };
}

/**
 * Split a topic label "Document › Subtopic" back into its parts. Prefer the
 * structured `parentTopic` / `subtopic` fields when an object has them.
 */
export function topicParts(t) {
  if (t && typeof t === "object") {
    if (t.subtopic && t.parentTopic) return { parent: t.parentTopic, name: t.subtopic };
    return topicParts(t.topic ?? t.topicLabel ?? "");
  }
  const label = String(t || "");
  const i = label.lastIndexOf(" › ");
  return i > 0 ? { parent: label.slice(0, i), name: label.slice(i + 3) } : { parent: null, name: label };
}

/** The headings a subtopic sits under, outermost first. */
export function notePath(n) {
  if (Array.isArray(n?.path) && n.path.length) return n.path;
  return n?.sectionGroup ? [n.sectionGroup] : []; // notes saved before `path` existed
}

const sameTitle = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * A document's subtopics as a nested outline, in document order.
 * `items` are child notes (or the upload preview's sections): anything with a
 * `title` and a `path`. Returns the top-level nodes:
 *   { key, title, depth, item, children, colorIndex }
 * `item` is the note itself, or null for a heading that only groups others.
 * A chapter's own introduction is a note AND a group: its node has both.
 * `colorIndex` numbers the main (top-level) topics; everything below a main
 * topic shares its colour.
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
