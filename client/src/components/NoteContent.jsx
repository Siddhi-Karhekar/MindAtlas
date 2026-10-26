import { useMemo, useRef, useState } from "react";
import { colorSections, layoutContent, lineText, topicClass } from "../lib/noteFormat.js";
import MathText from "./MathText.jsx";
import Icon from "./Icon.jsx";
import { hasMath } from "../lib/math.js";

// The one place a note's text is formatted, so every note reads the same way
// whatever it came from - a PDF, slides, a Word file, a photo or typed text.
//
// Input is the note's `content` (see server/src/models/Note.js): headings with
// a level, paragraphs, list entries with a depth, tables. The look:
//   - a topic has one colour; its headings and key terms wear it and the rest
//     of the text is plain, so the colour says "this belongs to that topic"
//     without tinting whole paragraphs;
//   - the heading level sets size and weight (1 is largest and boldest);
//   - lists get real markers, a different one per nesting depth; numbered
//     lists keep the numbers the author gave them.

const HEADING = {
  1: "text-[26px] leading-[34px] font-bold tracking-tight mt-space-xl pb-space-xs border-b border-topic-soft",
  2: "text-[21px] leading-[28px] font-semibold tracking-tight mt-space-lg",
  3: "text-[18px] leading-[26px] font-semibold mt-space-base",
  4: "text-[13px] leading-[18px] font-bold uppercase tracking-wider mt-space-base",
};
const BODY = "font-body-lg text-body-lg text-on-surface";

function Marked({ segments, onUnmark = null }) {
  // a formula can span key-term highlights ("\int" marked inside "$$\int_0^1$$"):
  // a paragraph with a formula is shown whole, typeset, without the highlights
  const whole = segments.map((s) => s.text).join("");
  if (hasMath(whole)) return <MathText text={whole} />;
  return segments.map((s, i) =>
    s.mark ? (
      onUnmark ? (
        <button
          type="button"
          key={i}
          onClick={() => onUnmark(s.text)}
          title="Remove this highlight"
          data-testid="highlighted-term"
          className="text-topic font-semibold underline decoration-dotted underline-offset-4 hover:bg-topic-soft rounded-sm"
        >
          {s.text}
        </button>
      ) : (
        <span key={i} className="text-topic font-semibold">
          {s.text}
        </span>
      )
    ) : (
      <MathText key={i} text={s.text} />
    )
  );
}

// ---------------------------------------------------------------------------
// Editing the formatted note (when `edit` is given): every line gets a small
// toolbar - change its words, add a line below it, delete it - and every
// highlighted word can be clicked to take the highlight off. Selecting words
// offers to highlight them (NoteContent below). The page does the saving.
// ---------------------------------------------------------------------------

const KINDS = [
  { value: "para", label: "Paragraph" },
  { value: "item", label: "Bullet point" },
  { value: "heading", label: "Heading" },
];

function LineEditor({ initial = "", kind = null, onSave, onCancel, busy, saveLabel }) {
  const [text, setText] = useState(initial);
  const [type, setType] = useState(kind);
  return (
    <div className="mt-space-xs mb-space-sm flex flex-col gap-space-xs rounded-lg bg-surface-container-low p-space-sm" data-testid="line-editor">
      {kind && (
        <div className="flex flex-wrap gap-space-xs" role="radiogroup" aria-label="Kind of line">
          {KINDS.map((k) => (
            <button
              type="button"
              key={k.value}
              role="radio"
              aria-checked={type === k.value}
              onClick={() => setType(k.value)}
              className={`px-space-sm py-space-2xs rounded-full font-label-md text-label-md ${type === k.value ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant"}`}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) onSave(text, type);
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(6, Math.max(2, Math.ceil(text.length / 80)))}
        maxLength={2000}
        placeholder="Write the line here"
        className="w-full rounded-lg bg-surface-container-lowest border border-outline-variant p-space-sm font-body-md text-body-md text-on-surface focus:outline-none focus:border-primary"
      />
      <div className="flex items-center gap-space-sm">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => onSave(text, type)}
          className="h-8 px-space-md rounded-lg bg-primary text-on-primary font-ui-body text-ui-body disabled:opacity-50"
          data-testid="line-save"
        >
          {busy ? "Saving…" : saveLabel}
        </button>
        <button type="button" onClick={onCancel} className="h-8 px-space-md rounded-lg text-on-surface-variant font-ui-body text-ui-body hover:bg-surface-container-high">
          Cancel
        </button>
      </div>
    </div>
  );
}

// One line of the note, with its toolbar when editing.
function Line({ block, edit, children, className = "" }) {
  const [mode, setMode] = useState(null); // null | "edit" | "add"
  if (!edit) return children;
  const was = lineText(block);
  const tool = "w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface";
  const done = (ok) => ok !== false && setMode(null);
  return (
    <div className={`group relative rounded-md -mx-space-xs px-space-xs hover:bg-surface-container-low/60 ${className}`} data-line-index={block.index}>
      <div className="flex items-start gap-space-xs">
        <div className="min-w-0 flex-1">{children}</div>
        <div className="shrink-0 flex items-center opacity-60 group-hover:opacity-100 focus-within:opacity-100 mt-space-sm">
          {block.type !== "table" && (
            <button type="button" className={tool} title="Change this line" aria-label="Change this line" onClick={() => setMode(mode === "edit" ? null : "edit")} data-testid="line-edit">
              <Icon name="edit" className="text-base" />
            </button>
          )}
          <button type="button" className={tool} title="Add a line below" aria-label="Add a line below" onClick={() => setMode(mode === "add" ? null : "add")} data-testid="line-add">
            <Icon name="add" className="text-base" />
          </button>
          <button
            type="button"
            className={`${tool} hover:text-error`}
            title="Delete this line"
            aria-label="Delete this line"
            disabled={edit.busy}
            onClick={() => edit.onDelete(block, was)}
            data-testid="line-delete"
          >
            <Icon name="delete" className="text-base" />
          </button>
        </div>
      </div>
      {mode === "edit" && (
        <LineEditor initial={block.text} busy={edit.busy} saveLabel="Save" onCancel={() => setMode(null)} onSave={async (text) => done(await edit.onEdit(block, was, text))} />
      )}
      {mode === "add" && (
        <LineEditor
          kind={block.type === "item" ? "item" : block.type === "heading" ? "para" : "para"}
          busy={edit.busy}
          saveLabel="Add line"
          onCancel={() => setMode(null)}
          onSave={async (text, type) => done(await edit.onInsert(block, was, { type, text }))}
        />
      )}
    </div>
  );
}

// filled dot, ring, small square: one marker per nesting depth
function Bullet({ depth }) {
  const shape =
    depth === 0 ? "w-1.5 h-1.5 rounded-full bg-topic" : depth === 1 ? "w-1.5 h-1.5 rounded-full border border-topic" : "w-1 h-1 bg-topic";
  return (
    <span className="shrink-0 w-5 h-[28px] flex items-center justify-center" aria-hidden="true">
      <span className={shape}></span>
    </span>
  );
}

function List({ items, depth = 0, edit = null }) {
  const ordered = items[0]?.ordered;
  const Tag = ordered ? "ol" : "ul";
  // position among the numbered entries, for lists whose source gave no numbers
  const numberOf = (i) => items.slice(0, i + 1).filter((x) => x.ordered).length;
  return (
    <Tag className={`list-none m-0 p-0 flex flex-col gap-space-xs ${depth === 0 ? "mt-space-md" : "mt-space-xs ml-space-lg"}`}>
      {items.map((it, i) => {
        return (
          <li key={i} data-depth={depth}>
            <Line block={it} edit={edit}>
              <div className={`flex items-start gap-space-xs ${BODY}`}>
                {it.ordered ? (
                  <span className="shrink-0 min-w-[1.75rem] text-topic font-semibold tabular-nums">{it.marker || `${numberOf(i)}.`}</span>
                ) : (
                  <Bullet depth={depth} />
                )}
                <span className="min-w-0">
                  <Marked segments={it.segments} onUnmark={edit ? (text) => edit.onUnmark(it, text) : null} />
                </span>
              </div>
            </Line>
            {it.children.length > 0 && <List items={it.children} depth={depth + 1} edit={edit} />}
          </li>
        );
      })}
    </Tag>
  );
}

function Table({ rows }) {
  const [head, ...body] = rows.length > 1 ? rows : [null, ...rows];
  const cell = "px-space-md py-space-sm text-left align-top border border-outline-variant";
  return (
    <div className="mt-space-md overflow-x-auto">
      <table className="w-full border-collapse font-body-md text-body-md text-on-surface">
        {head && (
          <thead>
            <tr>
              {head.map((c, i) => (
                <th key={i} className={`${cell} bg-topic-soft text-topic font-semibold`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={cell}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block, shrink, edit = null }) {
  if (block.type === "list") return <List items={block.items} edit={edit} />;
  let inner;
  if (block.type === "heading") {
    const Tag = `h${Math.min(block.level + 2, 6)}`; // the note's own title is the page's h2
    const size = Math.min(block.level + shrink, 4);
    inner = (
      <Tag data-testid="note-heading" data-level={block.level} className={`text-topic ${HEADING[size]}`}>
        {block.text}
      </Tag>
    );
  } else if (block.type === "label") inner = <p className="text-topic font-semibold text-[15px] leading-[24px] mt-space-md -mb-space-xs">{block.text}</p>;
  else if (block.type === "table") inner = <Table rows={block.rows} />;
  else
    inner = (
      <p className={`${BODY} mt-space-md`}>
        <Marked segments={block.segments} onUnmark={edit ? (text) => edit.onUnmark(block, text) : null} />
      </p>
    );
  return (
    <Line block={block} edit={edit}>
      {inner}
    </Line>
  );
}

// The words a student selected inside one line, for "Highlight": null when
// the selection is empty, spans lines, or is too long to be a key term.
function selectedTerm(root) {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !root) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})+]+$/gu, "");
  if (!text || text.length > 80 || text.split(" ").length > 8) return null;
  const lineOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.("[data-line-index]");
  const a = lineOf(sel.anchorNode);
  if (!a || a !== lineOf(sel.focusNode) || !root.contains(a)) return null;
  const box = sel.getRangeAt(0).getBoundingClientRect();
  const frame = root.getBoundingClientRect();
  return { text, x: box.left - frame.left + box.width / 2, y: box.top - frame.top };
}

/**
 * `colorIndex`: the topic colour of the note (see topicClass).
 * `bySection`: give every top-level heading inside the note its own colour -
 * for a note that holds several topics, or a whole document.
 * `colorOf(headingText)`: with bySection, look a section's colour up instead
 * of counting (so a document's sections match its subtopics' colours).
 * `shrink`: how many sizes smaller the headings start. A subtopic deep in its
 * document has a smaller title, and the headings inside it must stay smaller
 * than that title.
 */
/*
 * `edit`: makes the note editable in place - { busy, onDelete(block, was),
 * onInsert(block, was, { type, text }), onEdit(block, was, text),
 * onHighlight(text), onUnmark(block, text) } - each returning a promise that
 * resolves to false when the change could not be saved.
 */
export default function NoteContent({ content, keywords = [], colorIndex = 0, bySection = false, colorOf = null, shrink = 0, className = "", edit = null }) {
  const root = useRef(null);
  const [picked, setPicked] = useState(null); // { text, x, y }: words selected to highlight
  const sections = useMemo(
    () => colorSections(layoutContent(content, keywords), { baseIndex: colorIndex, bySection, colorOf }),
    [content, keywords, colorIndex, bySection, colorOf]
  );
  const watchSelection = () => edit && setPicked(selectedTerm(root.current));
  return (
    <div
      ref={root}
      className={`relative flex flex-col [&>section:first-child>*:first-child]:mt-0 ${className}`}
      data-testid="note-content"
      onMouseUp={watchSelection}
      onKeyUp={watchSelection}
      onTouchEnd={() => setTimeout(watchSelection, 0)}
    >
      {sections.map((s, i) => (
        <section key={i} className={`flex flex-col ${topicClass(s.colorIndex)}`}>
          {s.blocks.map((b, j) => (
            <Block key={j} block={b} shrink={shrink} edit={edit} />
          ))}
        </section>
      ))}
      {edit && picked && (
        <button
          type="button"
          // keep the selection: the click must not clear it before it is read
          onMouseDown={(e) => e.preventDefault()}
          onClick={async () => {
            const text = picked.text;
            setPicked(null);
            window.getSelection()?.removeAllRanges();
            await edit.onHighlight(text);
          }}
          style={{ left: Math.max(8, picked.x), top: Math.max(0, picked.y - 44) }}
          className="absolute -translate-x-1/2 z-10 px-space-md py-space-xs rounded-full bg-inverse-surface text-inverse-on-surface shadow-lg font-label-md text-label-md flex items-center gap-space-xs whitespace-nowrap"
          data-testid="highlight-selection"
        >
          <Icon name="ink_highlighter" className="text-sm" />
          Highlight “{picked.text.length > 30 ? `${picked.text.slice(0, 30)}…` : picked.text}”
        </button>
      )}
    </div>
  );
}
