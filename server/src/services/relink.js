// Relinking: apply the current keyword and linking rules to notes that were
// saved under older ones.
//
// A note's keywords, vector (tfidf.js) and links (graphEngine.js) are worked
// out once, when it is saved, against the notes that existed at that moment.
// So a change to either rule leaves every existing note on the old one, and
// a note's keywords depend on the order the subject's notes were added in.
// Relinking one student recomputes, for everything they own:
//   - each note's keywords and vector, from its rawText, against the rest of
//     its subject: a topic against every other topic (a subtopic's siblings
//     included, as when it was saved), a split document against the topics
//     outside it;
//   - every pair of topics, across all their subjects, with classifyPair().
//
// What it keeps:
//   - links the student removed (correction: "removed") stay removed, and
//     stay stored even when the pair would no longer be linked - that is the
//     student's decision about the pair, as in noteLifecycle.js;
//   - a link whose pair still qualifies keeps its edge and id (the graph
//     page uses edge ids for remove / undo); only changed fields are written.
// It deletes links the current rule no longer makes, and links to notes that
// no longer exist. Running it twice changes nothing the second time, so a
// run that stops half way is finished by running it again.
//
// Run it with scripts/relink.mjs. Take a backup before running it on the
// live database (npm run db:backup).

import { deleteEdgesByIds, edgeFields, findEdgesForNotes, isRemoved, upsertEdge } from "../models/GraphEdge.js";
import { findNotesByIds, findNotesByOwner, isSplitParent, updateNote } from "../models/Note.js";
import { classifyPair } from "./graphEngine.js";
import { computeTfidf, tokenSet } from "./tfidf.js";

const sameId = (a, b) => String(a) === String(b);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// edges are stored lower id first (graphEngine.js), so this is their key too
const pairKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);

const LINK_TYPES = ["same-subject", "cross-subject", "rejected"];
// rows from before cross-subject linking have no edgeType (GraphEdge.js)
const countByType = (edges) => Object.fromEntries(LINK_TYPES.map((t) => [t, edges.filter((e) => (e.edgeType || "same-subject") === t).length]));

/**
 * Each note's { keywords, vector }, by note id, recomputed from its text
 * against the rest of its subject (see the top of this file). Pure.
 */
export function freshTerms(notes) {
  const topics = notes.filter((n) => !isSplitParent(n));
  const sets = new Map(topics.map((t) => [String(t._id), tokenSet(t.rawText || "")]));
  const bySubject = new Map();
  for (const t of topics) {
    const key = String(t.subjectId);
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(t);
  }
  return new Map(
    notes.map((note) => {
      const others = (bySubject.get(String(note.subjectId)) || []).filter((t) =>
        isSplitParent(note) ? !sameId(t.parentNoteId, note._id) : !sameId(t._id, note._id)
      );
      return [String(note._id), computeTfidf(note.rawText || "", others.map((t) => sets.get(String(t._id))))];
    })
  );
}

/**
 * Every pair of `topics` the current rule keeps, as Map of pair key -> the
 * edge's fields (edgeFields()). Pure. Split documents must already be left
 * out: only topics are linked.
 */
export function desiredEdges(topics) {
  const edges = new Map();
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const pair = classifyPair(topics[i], topics[j]);
      if (!pair) continue;
      const [source, target] = String(topics[i]._id) < String(topics[j]._id) ? [topics[i], topics[j]] : [topics[j], topics[i]];
      edges.set(
        pairKey(source._id, target._id),
        edgeFields({
          sourceNoteId: source._id,
          targetNoteId: target._id,
          sourceSubjectId: source.subjectId,
          targetSubjectId: target.subjectId,
          ...pair,
        })
      );
    }
  }
  return edges;
}

/**
 * Relink everything `ownerId` owns. With `dryRun`, work out what would change
 * and write nothing. Returns a report:
 *   notes, topics     - how many notes, and how many of them are topics
 *   keywordsChanged   - notes whose keywords change
 *   termsChanged      - notes rewritten (keywords or vector changed)
 *   before, after     - links by type, not counting removed ones
 *   kept              - links that stay exactly as they are
 *   updated           - links that stay, with a new weight, type or shared keywords
 *   added, dropped    - links the current rule adds, and no longer makes
 *   removedKept       - links the student removed, left removed
 *   dangling          - links to notes that no longer exist, deleted
 */
export async function relinkOwner(ownerId, { dryRun = false } = {}) {
  const notes = await findNotesByOwner(ownerId);
  const terms = freshTerms(notes);
  const termsOf = (n) => terms.get(String(n._id));
  const rewritten = notes.filter((n) => !same(n.keywords, termsOf(n).keywords) || !same(n.vector, termsOf(n).vector));
  const topics = notes.filter((n) => !isSplitParent(n)).map((n) => ({ ...n, ...termsOf(n) }));
  const desired = desiredEdges(topics);

  const ownIds = new Set(notes.map((n) => String(n._id)));
  const stored = await findEdgesForNotes([...ownIds]);
  // An end outside this student's notes is a note that was deleted without
  // its links (possible before deleting cleaned them up), or one saved while
  // this ran - which links itself, so its edges are left alone.
  const outside = [...new Set(stored.flatMap((e) => [String(e.sourceNoteId), String(e.targetNoteId)]).filter((id) => !ownIds.has(id)))];
  const existing = new Set((await findNotesByIds(outside)).map((n) => String(n._id)));

  const report = {
    notes: notes.length,
    topics: topics.length,
    keywordsChanged: notes.filter((n) => !same(n.keywords, termsOf(n).keywords)).length,
    termsChanged: rewritten.length,
    before: null,
    after: null,
    kept: 0,
    updated: 0,
    added: 0,
    dropped: 0,
    removedKept: 0,
    dangling: 0,
  };
  const toDelete = [];
  const toWrite = [];
  const seen = new Set();
  const removedKeys = new Set();
  const active = [];

  for (const e of stored) {
    const ends = [String(e.sourceNoteId), String(e.targetNoteId)];
    const away = ends.filter((id) => !ownIds.has(id));
    if (away.length) {
      if (away.some((id) => !existing.has(id))) {
        toDelete.push(String(e._id));
        report.dangling += 1;
      }
      continue;
    }

    const key = pairKey(...ends);
    const want = desired.get(key);
    seen.add(key);
    if (isRemoved(e)) {
      removedKeys.add(key);
      report.removedKept += 1;
      // Re-scored only while the pair is still a link (upsertEdge never clears
      // `correction`). Turned into "rejected", the graph page would still
      // offer to restore it, and restoring a rejected pair is refused.
      if (want && want.edgeType !== "rejected" && !Object.entries(want).every(([k, v]) => same(e[k], v))) toWrite.push(want);
      continue;
    }

    active.push(e);
    if (!want) {
      toDelete.push(String(e._id));
      report.dropped += 1;
    } else if (Object.entries(want).every(([k, v]) => same(e[k], v))) {
      report.kept += 1;
    } else {
      toWrite.push(want);
      report.updated += 1;
    }
  }
  for (const [key, want] of desired) {
    if (seen.has(key)) continue;
    toWrite.push(want);
    report.added += 1;
  }
  report.before = countByType(active);
  report.after = countByType([...desired].filter(([key]) => !removedKeys.has(key)).map(([, e]) => e));

  if (!dryRun) {
    for (const n of rewritten) await updateNote(n._id, termsOf(n));
    await deleteEdgesByIds(toDelete);
    for (const e of toWrite) await upsertEdge(e);
  }
  return report;
}
