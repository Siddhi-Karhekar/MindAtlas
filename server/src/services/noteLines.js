// Editing a note's formatted view line by line, the way it reads: take a line
// out, put a new one in below another, change a line's words, or take the
// highlight off a word the author set in bold.
//
// A "line" is one block of the note's `content` (services/noteView.js
// withContent): a heading, a "Label:" line, a paragraph, a list entry or a
// table. The client sends the block's position and the words it showed
// there (`was`), so an edit made on a page that is out of date - the note was
// changed in another tab - is refused instead of hitting the wrong line.
//
// The result is a new `content`; the caller turns it into the note's editable
// text (contentToEditText) and saves it like any other edit
// (noteLifecycle.editNote), so keywords, links, concept records and the
// plain text questions quote all follow.

const MAX_LINE = 2000;

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The words a block shows, for checking it is the one the student saw. */
export function lineText(block) {
  if (!block) return "";
  if (block.type === "table") return (block.rows || []).flat().join(" ");
  return String(block.text || "");
}

// bold terms kept on a restored line: only words that are in it
const strongOf = (spec, text) =>
  Array.isArray(spec?.strong) ? spec.strong.map(clean).filter((t) => t && t.length <= 80 && text.includes(t)).slice(0, 40) : [];

function tableBlock(spec) {
  const rows = Array.isArray(spec?.rows) ? spec.rows : [];
  if (!rows.length || rows.length > 60 || !rows.every((r) => Array.isArray(r) && r.length > 0 && r.length <= 12)) throw fail(400, "a table needs rows of cells");
  return { type: "table", rows: rows.map((r) => r.map((c) => clean(c).slice(0, 500))), ...(spec.comparison ? { comparison: true } : {}) };
}

function newBlock(spec, near) {
  const type = spec?.type;
  if (type === "table") return tableBlock(spec); // putting back a deleted table
  const text = clean(spec?.text);
  if (!text) throw fail(400, "a new line needs some words");
  if (text.length > MAX_LINE) throw fail(400, `a line can be at most ${MAX_LINE} characters`);
  if (type === "heading") {
    const level = Number.isInteger(spec.level) ? Math.min(Math.max(spec.level, 1), 4) : near?.type === "heading" ? near.level || 1 : 2;
    return { type: "heading", level, text };
  }
  if (type === "label") return { type: "label", text };
  if (type === "item") {
    const depth = Number.isInteger(spec.depth) ? Math.min(Math.max(spec.depth, 0), 2) : near?.type === "item" ? near.depth || 0 : 0;
    // a new entry in a numbered list continues its numbering when the note is read back
    const ordered = typeof spec.ordered === "boolean" ? spec.ordered : near?.type === "item" ? Boolean(near.ordered) : false;
    // in a numbered list, the number after the entry above ("3." after "2.")
    const prev = near?.type === "item" && near.ordered ? /^(\d+)([.)])$/.exec(String(near.marker || "")) : null;
    const given = /^[\w]{1,4}[.)]$/.test(String(spec.marker || "")) ? spec.marker : null;
    const marker = given || (prev ? `${Number(prev[1]) + 1}${prev[2]}` : "1.");
    const strong = strongOf(spec, text);
    return { type: "item", text, depth, ordered, ...(ordered ? { marker } : {}), ...(strong.length ? { strong } : {}) };
  }
  if (type === "para") {
    const strong = strongOf(spec, text);
    return { type: "para", text, ...(strong.length ? { strong } : {}) };
  }
  throw fail(400, "a new line is a paragraph (para), a list entry (item), a heading, a label or a table");
}

/**
 * Apply one edit to a note's content blocks. Returns the new blocks; throws
 * an Error with `.status` (400 bad request, 409 out of date) otherwise.
 *   { op: "delete", index, was }
 *   { op: "insert", after, block: { type, text, level?, depth?, ordered? } }   after = -1: at the top
 *   { op: "edit", index, was, text }
 *   { op: "unbold", index, was, term }
 */
export function applyLineEdit(content, edit) {
  const blocks = Array.isArray(content) ? content.map((b) => ({ ...b })) : [];
  const op = edit?.op;
  const at = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= blocks.length) throw fail(409, "that line is no longer in the note - reload it and try again", "stale");
    if (edit.was !== undefined && clean(lineText(blocks[i])) !== clean(edit.was)) {
      throw fail(409, "the note has changed since it was opened - reload it and try again", "stale");
    }
    return blocks[i];
  };

  if (op === "delete") {
    at(edit.index);
    blocks.splice(edit.index, 1);
    if (!blocks.some((b) => clean(lineText(b)))) throw fail(400, "the note cannot be empty - delete it instead if you no longer want it");
    return blocks;
  }
  if (op === "insert") {
    const after = edit.after;
    if (!Number.isInteger(after) || after < -1 || after >= blocks.length) throw fail(409, "that line is no longer in the note - reload it and try again", "stale");
    if (after >= 0 && edit.was !== undefined) at(after);
    const near = after >= 0 ? blocks[after] : blocks[0];
    blocks.splice(after + 1, 0, newBlock(edit.block, near));
    return blocks;
  }
  if (op === "edit") {
    const b = at(edit.index);
    if (b.type === "table") throw fail(400, "a table is changed in the note's text editor");
    const text = clean(edit.text);
    if (!text) throw fail(400, "a line cannot be empty - delete it instead");
    if (text.length > MAX_LINE) throw fail(400, `a line can be at most ${MAX_LINE} characters`);
    blocks[edit.index] = { ...b, text, ...(Array.isArray(b.strong) ? { strong: b.strong.filter((s) => text.includes(s)) } : {}) };
    return blocks;
  }
  if (op === "unbold") {
    const b = at(edit.index);
    const term = clean(edit.term).toLowerCase();
    const strong = Array.isArray(b.strong) ? b.strong : [];
    const kept = strong.filter((s) => clean(s).toLowerCase() !== term);
    if (kept.length === strong.length) throw fail(400, "that word is not set in bold on this line");
    blocks[edit.index] = { ...b, strong: kept };
    return blocks;
  }
  throw fail(400, "op must be delete, insert, edit or unbold");
}
