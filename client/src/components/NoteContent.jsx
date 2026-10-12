import { useMemo } from "react";
import { colorSections, layoutContent, topicClass } from "../lib/noteFormat.js";
import MathText from "./MathText.jsx";
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

function Marked({ segments }) {
  // a formula can span key-term highlights ("\int" marked inside "$$\int_0^1$$"):
  // a paragraph with a formula is shown whole, typeset, without the highlights
  const whole = segments.map((s) => s.text).join("");
  if (hasMath(whole)) return <MathText text={whole} />;
  return segments.map((s, i) =>
    s.mark ? (
      <span key={i} className="text-topic font-semibold">
        {s.text}
      </span>
    ) : (
      <MathText key={i} text={s.text} />
    )
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

function List({ items, depth = 0 }) {
  const ordered = items[0]?.ordered;
  const Tag = ordered ? "ol" : "ul";
  // position among the numbered entries, for lists whose source gave no numbers
  const numberOf = (i) => items.slice(0, i + 1).filter((x) => x.ordered).length;
  return (
    <Tag className={`list-none m-0 p-0 flex flex-col gap-space-xs ${depth === 0 ? "mt-space-md" : "mt-space-xs ml-space-lg"}`}>
      {items.map((it, i) => {
        return (
          <li key={i} data-depth={depth}>
            <div className={`flex items-start gap-space-xs ${BODY}`}>
              {it.ordered ? (
                <span className="shrink-0 min-w-[1.75rem] text-topic font-semibold tabular-nums">{it.marker || `${numberOf(i)}.`}</span>
              ) : (
                <Bullet depth={depth} />
              )}
              <span className="min-w-0">
                <Marked segments={it.segments} />
              </span>
            </div>
            {it.children.length > 0 && <List items={it.children} depth={depth + 1} />}
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

function Block({ block, shrink }) {
  if (block.type === "heading") {
    const Tag = `h${Math.min(block.level + 2, 6)}`; // the note's own title is the page's h2
    const size = Math.min(block.level + shrink, 4);
    return (
      <Tag data-testid="note-heading" data-level={block.level} className={`text-topic ${HEADING[size]}`}>
        {block.text}
      </Tag>
    );
  }
  if (block.type === "label") return <p className="text-topic font-semibold text-[15px] leading-[24px] mt-space-md -mb-space-xs">{block.text}</p>;
  if (block.type === "list") return <List items={block.items} />;
  if (block.type === "table") return <Table rows={block.rows} />;
  return (
    <p className={`${BODY} mt-space-md`}>
      <Marked segments={block.segments} />
    </p>
  );
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
export default function NoteContent({ content, keywords = [], colorIndex = 0, bySection = false, colorOf = null, shrink = 0, className = "" }) {
  const sections = useMemo(
    () => colorSections(layoutContent(content, keywords), { baseIndex: colorIndex, bySection, colorOf }),
    [content, keywords, colorIndex, bySection, colorOf]
  );
  return (
    <div className={`flex flex-col [&>section:first-child>*:first-child]:mt-0 ${className}`} data-testid="note-content">
      {sections.map((s, i) => (
        <section key={i} className={`flex flex-col ${topicClass(s.colorIndex)}`}>
          {s.blocks.map((b, j) => (
            <Block key={j} block={b} shrink={shrink} />
          ))}
        </section>
      ))}
    </div>
  );
}
