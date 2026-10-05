// The export model (model.js) written as a Word file.
//
// It is an ordinary, editable document: topic headings use Word's own
// Heading 1-4 styles (so the Navigation pane lists them and the student can
// restyle them in one go), bullets are real lists, tables are real tables.
// The contents list links to each topic. It has no page numbers: Word only
// works those out when the file is open on the reader's machine, and the one
// way to ask for them from here makes Word greet the student with a warning
// about "fields that may refer to other files". The PDF has page numbers.
//
// Built with the `docx` package, loaded on first use so a server that never
// exports anything does not pay for it in memory.

import { INK, MUTED, PRIMARY, RULE, tint } from "./format.js";

const FONT = "Calibri"; // ships with Word; LibreOffice substitutes Carlito, same widths
const BULLET_FONT = "Arial"; // has the three bullet shapes on every platform
// half-points
const SIZE = { title: 52, 1: 38, 2: 30, 3: 25, 4: 20, body: 22, small: 18, index: 22 };
// A4 with 2 cm margins, in twentieths of a point
const PAGE = { width: 11906, height: 16838, margin: 1134 };
const TEXT_WIDTH = PAGE.width - 2 * PAGE.margin;
const LIST_STEP = 360; // indent per list level
const BULLETS = ["•", "◦", "▪"]; // filled dot, ring, small square
const LIST_LEVELS = 6;

const hex = (color) => color.replace("#", "").toUpperCase();
const bulletRef = (color) => `bullets-${hex(color)}`;

let lib = null;
async function load() {
  lib ||= await import("docx");
  return lib;
}

/** The model as a .docx file. Returns a Buffer. */
export async function renderDocx(model) {
  const d = await load();
  const { Paragraph, TextRun, Bookmark, InternalHyperlink, Table, TableRow, TableCell } = d;

  const runs = (segments, color, size) =>
    segments.filter((s) => s.text).map((s) => new TextRun({ text: s.text, bold: s.mark || undefined, color: s.mark ? hex(color) : undefined, size }));

  // "a multiple of the type size": said outright, because not every program
  // that opens Word files assumes it
  const AUTO = d.LineRuleType.AUTO;
  const body = [];

  // ---- title block
  if (model.kicker) {
    body.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: model.kicker.toUpperCase(), size: SIZE.small, color: hex(MUTED), characterSpacing: 20 })] }));
  }
  body.push(new Paragraph({ heading: d.HeadingLevel.TITLE, children: [new TextRun({ text: model.title, color: hex(model.titleColor) })] }));
  body.push(
    new Paragraph({
      spacing: { after: 280 },
      border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, space: 8, color: hex(RULE) } },
      children: [new TextRun({ text: model.meta, size: SIZE.small, color: hex(MUTED) })],
    })
  );

  const keyTerms = (el) =>
    new Paragraph({
      spacing: { after: 140 },
      keepNext: true,
      children: [new TextRun({ text: "Key terms  ", size: SIZE.small, color: hex(MUTED) }), new TextRun({ text: el.terms.join("  \u00B7  "), size: SIZE.small, bold: true, color: hex(el.color) })],
    });
  if (model.lead) body.push(keyTerms(model.lead));

  // ---- contents: every topic, indented by level, linked to its heading
  if (model.index.length) {
    body.push(new Paragraph({ style: "ContentsTitle", children: [new TextRun({ text: "Contents" })] }));
    for (const entry of model.index) {
      const main = entry.level === 0;
      body.push(
        new Paragraph({
          style: "ContentsEntry",
          indent: { left: entry.level * LIST_STEP },
          spacing: { before: main ? 100 : 0, after: 40 },
          children: [new InternalHyperlink({ anchor: entry.id, children: [new TextRun({ text: entry.text, bold: main || undefined, color: hex(entry.strong ? entry.color : INK) })] })],
        })
      );
    }
  }
  // a document's text starts on a fresh page after its contents list
  let breakNext = model.index.length > 0 && model.kind !== "note";

  const heading = (el) => {
    const level = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4][el.size - 1];
    const text = new TextRun({ text: el.text, color: hex(el.color) });
    return new Paragraph({
      heading: level,
      pageBreakBefore: el.pageBreak || undefined,
      border: el.rule ? { bottom: { style: d.BorderStyle.SINGLE, size: 6, space: 4, color: hex(tint(el.color, 0.7)) } } : undefined,
      // the index links to a bookmark around the heading's text
      children: el.id ? [new Bookmark({ id: el.id, children: [text] })] : [text],
    });
  };

  const list = (items, color, depth = 0) => {
    const out = [];
    const level = Math.min(depth, LIST_LEVELS - 1);
    items.forEach((it, i) => {
      if (it.ordered) {
        // the author's own number ("2)", "iv.") is kept as text, so it can
        // never renumber itself; a hanging indent lines the entry up
        const marker = it.marker || `${items.slice(0, i + 1).filter((x) => x.ordered).length}.`;
        const left = (level + 1) * LIST_STEP + 140;
        out.push(
          new Paragraph({
            style: "ListEntry",
            indent: { left, hanging: 440 },
            tabStops: [{ type: d.TabStopType.LEFT, position: left }],
            children: [new TextRun({ text: `${marker}\t`, bold: true, color: hex(color) }), ...runs(it.segments, color)],
          })
        );
      } else {
        out.push(new Paragraph({ style: "ListEntry", numbering: { reference: bulletRef(color), level }, children: runs(it.segments, color) }));
      }
      if (it.children?.length) out.push(...list(it.children, color, depth + 1));
    });
    return out;
  };

  const table = (el) => {
    const columns = Math.max(...el.rows.map((r) => r.length));
    const rows = el.rows.map((r) => Array.from({ length: columns }, (_, i) => String(r[i] ?? "")));
    // column widths follow the longest cell, within limits, and add up exactly
    const weights = Array.from({ length: columns }, (_, c) => Math.min(Math.max(...rows.map((r) => r[c].length), 6), 40));
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.floor((w / total) * TEXT_WIDTH));
    widths[columns - 1] += TEXT_WIDTH - widths.reduce((a, b) => a + b, 0);
    const hasHead = rows.length > 1;
    const line = { style: d.BorderStyle.SINGLE, size: 4, color: hex(RULE) };
    return new Table({
      width: { size: TEXT_WIDTH, type: d.WidthType.DXA },
      columnWidths: widths,
      rows: rows.map(
        (r, ri) =>
          new TableRow({
            tableHeader: hasHead && ri === 0 ? true : undefined, // repeats at the top of each page the table runs onto
            cantSplit: true,
            children: r.map((text, ci) => {
              const head = hasHead && ri === 0;
              return new TableCell({
                width: { size: widths[ci], type: d.WidthType.DXA },
                margins: { top: 70, bottom: 70, left: 110, right: 110 },
                borders: { top: line, bottom: line, left: line, right: line },
                shading: head ? { type: d.ShadingType.CLEAR, color: "auto", fill: hex(tint(el.color)) } : undefined,
                children: [new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text, bold: head || undefined, color: head ? hex(el.color) : undefined, size: SIZE.body - 1 })] })],
              });
            }),
          })
      ),
    });
  };

  // Word puts no space around a table by itself
  const gap = () => new Paragraph({ spacing: { before: 0, after: 0, line: 160, lineRule: d.LineRuleType.EXACT }, children: [] });

  for (const el of model.elements) {
    const start = body.length;
    if (el.kind === "heading") body.push(heading(breakNext ? { ...el, pageBreak: true } : el));
    else if (el.kind === "keywords") body.push(keyTerms(el));
    else if (el.kind === "para") body.push(new Paragraph({ pageBreakBefore: breakNext || undefined, children: runs(el.segments, el.color) }));
    else if (el.kind === "label") body.push(new Paragraph({ style: "ListLabel", children: [new TextRun({ text: el.text, color: hex(el.color) })] }));
    else if (el.kind === "list") body.push(...list(el.items, el.color));
    else if (el.kind === "table") body.push(gap(), table(el), gap());
    if (body.length > start) breakNext = false;
  }

  // ---- styles, lists, page
  const headingStyle = (id, name, size, extra = {}) => ({
    id,
    name,
    basedOn: "Normal",
    next: "Normal",
    quickFormat: true,
    run: { font: FONT, size, bold: true, color: hex(PRIMARY), ...extra.run },
    paragraph: { keepNext: true, keepLines: true, ...extra.paragraph },
  });
  const colors = [...new Set(model.elements.filter((e) => e.kind === "list").map((e) => e.color))];
  const footerText = model.title.length > 60 ? `${model.title.slice(0, 57)}...` : model.title;

  const doc = new d.Document({
    creator: "Mind Atlas",
    title: model.title,
    description: [model.kicker, model.meta].filter(Boolean).join(" - "),
    styles: {
      default: { document: { run: { font: FONT, size: SIZE.body, color: hex(INK) }, paragraph: { spacing: { after: 140, line: 300, lineRule: AUTO } } } },
      paragraphStyles: [
        headingStyle("Title", "Title", SIZE.title, { paragraph: { spacing: { before: 0, after: 60, line: 288, lineRule: AUTO } } }),
        headingStyle("Heading1", "Heading 1", SIZE[1], { paragraph: { spacing: { before: 420, after: 160, line: 288, lineRule: AUTO }, outlineLevel: 0 } }),
        headingStyle("Heading2", "Heading 2", SIZE[2], { paragraph: { spacing: { before: 320, after: 110, line: 288, lineRule: AUTO }, outlineLevel: 1 } }),
        headingStyle("Heading3", "Heading 3", SIZE[3], { paragraph: { spacing: { before: 240, after: 90, line: 288, lineRule: AUTO }, outlineLevel: 2 } }),
        headingStyle("Heading4", "Heading 4", SIZE[4], { run: { allCaps: true, characterSpacing: 16 }, paragraph: { spacing: { before: 220, after: 70 }, outlineLevel: 3 } }),
        { id: "ContentsTitle", name: "Contents Title", basedOn: "Normal", next: "Normal", run: { size: 26, bold: true, color: hex(PRIMARY) }, paragraph: { spacing: { before: 60, after: 100 }, keepNext: true } },
        { id: "ContentsEntry", name: "Contents Entry", basedOn: "Normal", run: { size: SIZE.index }, paragraph: { spacing: { after: 40, line: 264, lineRule: AUTO } } },
        { id: "ListEntry", name: "List Entry", basedOn: "Normal", paragraph: { spacing: { after: 70 } } },
        { id: "PageFooter", name: "Page Footer", basedOn: "Normal", run: { size: 16, color: hex(MUTED) }, paragraph: { spacing: { after: 0 } } },
        { id: "ListLabel", name: "List Label", basedOn: "Normal", next: "Normal", run: { bold: true }, paragraph: { spacing: { before: 60, after: 60 }, keepNext: true } },
      ],
    },
    numbering: {
      // one bullet list per topic colour, so the markers wear it too
      config: colors.map((color) => ({
        reference: bulletRef(color),
        levels: Array.from({ length: LIST_LEVELS }, (_, level) => ({
          level,
          format: d.LevelFormat.BULLET,
          text: BULLETS[Math.min(level, BULLETS.length - 1)],
          alignment: d.AlignmentType.LEFT,
          style: { paragraph: { indent: { left: (level + 1) * LIST_STEP, hanging: 260 } }, run: { font: BULLET_FONT, color: hex(color) } },
        })),
      })),
    },
    sections: [
      {
        properties: { page: { size: { width: PAGE.width, height: PAGE.height }, margin: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin } } },
        footers: {
          default: new d.Footer({
            children: [
              // the style, not the run, sets the size: page-number fields take theirs from the paragraph
              new Paragraph({ style: "PageFooter", alignment: d.AlignmentType.RIGHT, children: [new TextRun({ children: [`${footerText}   \u00B7   Page `, d.PageNumber.CURRENT, " of ", d.PageNumber.TOTAL_PAGES] })] }),
            ],
          }),
        },
        children: body,
      },
    ],
  });
  return d.Packer.toBuffer(doc);
}
