// Helpers for the two-level note hierarchy: a long uploaded document is saved
// as a PARENT note (childCount > 0) plus one CHILD note per subtopic
// (parentNoteId set). Ordinary notes have neither. Works on both the notes
// list (`_id`) and graph nodes (`id`).

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
