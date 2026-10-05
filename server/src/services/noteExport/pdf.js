// The export model (model.js) written as a PDF.
//
// A4 pages with the same look as the Word file and the reading pane: topic
// headings and key terms in the topic's colour, body text plain; four heading
// sizes; bullets with a different marker per level; tables with a tinted head.
// On top of that a PDF can carry things only a fixed layout can:
//   - a contents list with page numbers, each line a link to its topic;
//   - bookmarks (the reader's sidebar outline) for the same topics;
//   - "Page 3 of 12" on every page.
//
// Text is laid out here, word by word, rather than by pdfkit's own paragraph
// code: a line mixes plain and coloured bold words, and placing them ourselves
// is what lets a heading stay with the text under it, a list marker stay with
// its entry and a table row move to the next page whole.
//
// The fonts are DejaVu Sans (assets/fonts/): free to ship, and they have the
// Greek letters, arrows and maths signs that engineering notes are full of.
// Only the characters a file uses are embedded, so files stay small.
// pdfkit is loaded on first use, so it costs no memory until someone exports.

import { fileURLToPath } from "node:url";
import { INK, MUTED, PRIMARY, RULE, tint } from "./format.js";

const FONT_DIR = fileURLToPath(new URL("../../../assets/fonts/", import.meta.url));
const PAGE = { width: 595.28, height: 841.89, margin: 56.7 }; // A4, 2 cm margins
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const TEXT_WIDTH = RIGHT - LEFT;
const TOP = PAGE.margin;
const BOTTOM = PAGE.height - PAGE.margin - 14; // the last 14 pt belong to the page number
const SIZE = { title: 24, 1: 18, 2: 14.5, 3: 12, 4: 9.5, body: 10.5, small: 8.5, table: 9.5 };
const LEADING = 1.45; // line height as a multiple of the type size
const BEFORE = { 1: 24, 2: 18, 3: 14, 4: 12 }; // space above a heading
const AFTER = { 1: 10, 2: 6, 3: 5, 4: 4 };
const LIST_STEP = 16;

let PDFDocument = null;
async function load() {
  PDFDocument ||= (await import("pdfkit")).default;
  return PDFDocument;
}

/** The model as a PDF file. Returns a Buffer. */
export async function renderPdf(model) {
  const Doc = await load();
  const doc = new Doc({
    size: "A4",
    margin: PAGE.margin,
    bufferPages: true, // pages stay open, so page numbers can be written once all are known
    lang: "en",
    displayTitle: true,
    info: { Title: model.title, Author: "Mind Atlas", Subject: [model.kicker, model.meta].filter(Boolean).join(" - "), Creator: "Mind Atlas" },
  });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.registerFont("regular", `${FONT_DIR}DejaVuSans.ttf`);
  doc.registerFont("bold", `${FONT_DIR}DejaVuSans-Bold.ttf`);

  // ---- characters the font cannot draw become one visible replacement,
  // rather than a silent gap, and are checked once each
  const face = doc.font("regular")._font.font;
  const fallback = face.hasGlyphForCodePoint(0xfffd) ? "�" : "?";
  const drawable = new Map();
  const printable = (text) => {
    let out = "";
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (!drawable.has(cp)) drawable.set(cp, cp === 0x20 || cp === 0xa0 || face.hasGlyphForCodePoint(cp));
      out += drawable.get(cp) ? ch : fallback;
    }
    return out;
  };

  // ---- measuring and drawing styled text
  const widths = new Map();
  const use = (style) => doc.font(style.bold ? "bold" : "regular").fontSize(style.size);
  const widthOf = (text, style) => {
    const key = `${style.bold ? 1 : 0}|${style.size}|${style.tracking || 0}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      w = use(style).widthOfString(text, { characterSpacing: style.tracking || 0 });
      widths.set(key, w);
    }
    return w;
  };
  const draw = (text, x, y, style) =>
    use(style).fillColor(style.color).text(text, x, y, { lineBreak: false, characterSpacing: style.tracking || 0 });

  /**
   * Break styled runs [{ text, style }] (see `style` below) into lines no
   * wider than `maxWidth`. Lines break at spaces only, so "Atomicity:" stays
   * together although the term is bold and the colon is not. A line is a list
   * of { text, style, width } pieces ready to draw; `width` is the line's own.
   */
  const layout = (runs, maxWidth) => {
    // words: each a list of pieces, because one word can change style inside
    const words = [];
    let word = null;
    for (const run of runs) {
      for (const part of printable(run.text).split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) word = null;
        else {
          if (!word) words.push((word = { pieces: [], width: 0 }));
          const width = widthOf(part, run.style);
          word.pieces.push({ text: part, style: run.style, width });
          word.width += width;
        }
      }
    }
    const lines = [];
    let line = null;
    const start = () => lines.push((line = { pieces: [], width: 0 }));
    const add = (piece) => {
      const last = line.pieces[line.pieces.length - 1];
      if (last && last.style === piece.style) {
        last.text += piece.text;
        last.width += piece.width;
      } else line.pieces.push({ ...piece });
      line.width += piece.width;
    };
    for (const w of words) {
      const first = w.pieces[0].style;
      const space = widthOf(" ", first);
      if (!line) start();
      else if (line.width + space + w.width > maxWidth) start();
      else if (line.pieces.length) {
        // the space takes the style of the word before it, so a run of plain
        // words is drawn as one string
        const last = line.pieces[line.pieces.length - 1];
        last.text += " ";
        last.width += widthOf(" ", last.style);
        line.width += widthOf(" ", last.style);
      }
      if (w.width <= maxWidth) w.pieces.forEach(add);
      else {
        // one word wider than the line (a URL, a long identifier): cut it
        for (const piece of w.pieces) {
          let rest = piece.text;
          while (rest) {
            let n = rest.length;
            while (n > 1 && line.width + widthOf(rest.slice(0, n), piece.style) > maxWidth) n -= 1;
            if (n === 1 && line.pieces.length && line.width + widthOf(rest[0], piece.style) > maxWidth) {
              start();
              continue;
            }
            const text = rest.slice(0, n);
            add({ text, style: piece.style, width: widthOf(text, piece.style) });
            rest = rest.slice(n);
            if (rest) start();
          }
        }
      }
    }
    return lines;
  };

  // ---- the page cursor
  let y = TOP;
  const atTop = () => y <= TOP + 0.5;
  const newPage = () => {
    doc.addPage();
    y = TOP;
  };
  /** Make sure `height` fits below the cursor, starting a page if it does not. */
  const need = (height) => {
    if (y + height > BOTTOM && !atTop()) newPage();
  };
  const drawLine = (line, x, size) => {
    let at = x;
    for (const piece of line.pieces) {
      draw(piece.text, at, y, piece.style);
      at += piece.width;
    }
    y += size * LEADING;
  };
  /**
   * Lines of text at `x`, moving to a new page when they run out of room. A
   * paragraph is never split so that one line is left alone at the foot of a
   * page or carried alone to the top of the next.
   */
  const drawLines = (lines, x, size) => {
    const lineH = size * LEADING;
    let fit = Math.floor((BOTTOM - y) / lineH);
    if (fit < lines.length && !atTop()) {
      if (fit < 2) fit = 0;
      else if (lines.length - fit === 1) fit -= 1;
    } else fit = lines.length;
    lines.forEach((line, i) => {
      if (i === fit) newPage();
      else need(lineH);
      drawLine(line, x, size);
    });
  };
  const style = (size, color = INK, bold = false, tracking = 0) => ({ size, color, bold, tracking });
  const bodyRuns = (segments, color, size = SIZE.body) => {
    const plain = style(size);
    const marked = style(size, color, true);
    return segments.map((s) => ({ text: s.text, style: s.mark ? marked : plain }));
  };

  // ---- title block
  if (model.kicker) {
    const lines = layout([{ style: style(SIZE.small, MUTED, false, 0.8), text: model.kicker.toUpperCase() }], TEXT_WIDTH);
    drawLines(lines, LEFT, SIZE.small);
    y += 2;
  }
  {
    const lines = layout([{ style: style(SIZE.title, model.titleColor, true), text: model.title }], TEXT_WIDTH);
    for (const line of lines) {
      draw(line.pieces.map((p) => p.text).join(""), LEFT, y, line.pieces[0].style);
      y += SIZE.title * 1.25;
    }
    y += 2;
    drawLines(layout([{ style: style(SIZE.small, MUTED), text: model.meta }], TEXT_WIDTH), LEFT, SIZE.small);
    y += 6;
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.75).strokeColor(RULE).stroke();
    y += 18;
  }

  const keyTerms = (el) => {
    const lines = layout(
      [
        { style: style(SIZE.small, MUTED), text: "Key terms  " },
        { style: style(SIZE.small, el.color, true), text: el.terms.join("  \u00B7  ") },
      ],
      TEXT_WIDTH
    );
    drawLines(lines, LEFT, SIZE.small);
    y += 6;
  };
  if (model.lead) {
    y -= 8;
    keyTerms(model.lead);
    y += 8;
  }

  // ---- contents: the entries now, their page numbers once the pages exist
  const pending = []; // { id, page, y, textEnd, size }
  if (model.index.length) {
    draw("Contents", LEFT, y, style(13, PRIMARY, true));
    y += 13 * LEADING + 4;
    const numberWidth = 30;
    for (const entry of model.index) {
      const main = entry.level === 0;
      const x = LEFT + entry.level * 16;
      const lines = layout([{ style: style(SIZE.body, entry.strong ? entry.color : INK, main), text: entry.text }], RIGHT - x - numberWidth);
      if (main && !atTop()) y += 5;
      need(lines.length * SIZE.body * LEADING);
      const top = y;
      const page = doc.bufferedPageRange().count - 1;
      for (const line of lines) drawLine(line, x, SIZE.body);
      // the whole entry is the link, not just its words
      doc.goTo(x, top, RIGHT - x, y - top, entry.id);
      pending.push({ id: entry.id, page, y: y - SIZE.body * LEADING, textEnd: x + lines[lines.length - 1].width, bold: main });
      y += 1.5;
    }
    if (model.kind === "note") y += 14;
    else newPage(); // a document's text starts on a fresh page after its contents
  }

  // ---- body
  const pageOf = new Map(); // heading id -> page number, for the contents list
  const outline = [doc.outline]; // bookmark parents by level

  const headingLines = (el) => {
    const caps = el.size === 4;
    return layout([{ style: style(SIZE[el.size], el.color, true, caps ? 0.7 : 0), text: caps ? el.text.toUpperCase() : el.text }], TEXT_WIDTH);
  };
  const headingHeight = (el) => headingLines(el).length * SIZE[el.size] * LEADING + AFTER[el.size] + (el.rule ? 3 : 0);
  // What has to fit under the cursor for the heading at `i` to be worth
  // starting here: the heading, any headings and key-term lines directly
  // under it ("Recovery" then "Log-Based Recovery"), and the first lines of
  // the text they introduce. A heading is never left alone at the foot of a page.
  const reserve = (i) => {
    let height = headingHeight(model.elements[i]);
    for (let j = i + 1; j < model.elements.length; j++) {
      const next = model.elements[j];
      if (next.kind === "heading" && !next.pageBreak) height += BEFORE[next.size] + headingHeight(next);
      else if (next.kind === "keywords") height += SIZE.small * LEADING + 6;
      else break;
    }
    return height + 2.5 * SIZE.body * LEADING;
  };

  const heading = (el, i) => {
    const size = SIZE[el.size];
    const lines = headingLines(el);
    if (el.pageBreak && !atTop()) newPage();
    if (!atTop()) y += BEFORE[el.size];
    const room = reserve(i);
    if (room < (BOTTOM - TOP) * 0.6) need(room);
    if (el.id) {
      pageOf.set(el.id, doc.bufferedPageRange().count);
      doc.addNamedDestination(el.id, "XYZ", null, Math.max(y - 10, 0), null);
      const level = Math.min(el.outline ?? 0, outline.length - 1);
      outline.length = level + 1;
      outline.push(outline[level].addItem(printable(el.text), { expanded: level === 0 }));
    }
    for (const line of lines) drawLine(line, LEFT, size);
    if (el.rule) {
      y += 1;
      doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.75).strokeColor(tint(el.color, 0.7)).stroke();
      y += 2;
    }
    y += AFTER[el.size];
  };

  const bullet = (x, depth, color) => {
    const cy = y + SIZE.body * 0.62;
    const cx = x + 4;
    if (depth === 0) doc.circle(cx, cy, 1.7).fillColor(color).fill();
    else if (depth === 1) doc.circle(cx, cy, 1.6).lineWidth(0.7).strokeColor(color).stroke();
    else doc.rect(cx - 1.3, cy - 1.3, 2.6, 2.6).fillColor(color).fill();
  };

  const list = (items, color, depth = 0) => {
    const x = LEFT + depth * LIST_STEP;
    items.forEach((it, i) => {
      const marker = it.ordered ? printable(it.marker || `${items.slice(0, i + 1).filter((n) => n.ordered).length}.`) : null;
      const markerStyle = style(SIZE.body, color, true);
      const indent = marker ? Math.max(18, widthOf(marker, markerStyle) + 6) : 14;
      const lines = layout(bodyRuns(it.segments, color), RIGHT - x - indent);
      // the marker and the first two lines of its entry stay on one page
      need(Math.min(lines.length, 2) * SIZE.body * LEADING);
      if (marker) draw(marker, x, y, markerStyle);
      else bullet(x, depth, color);
      drawLines(lines, x + indent, SIZE.body);
      y += 2.5;
      if (it.children?.length) list(it.children, color, depth + 1);
    });
  };

  const table = (el) => {
    const columns = Math.max(...el.rows.map((r) => r.length));
    const rows = el.rows.map((r) => Array.from({ length: columns }, (_, i) => String(r[i] ?? "")));
    const weights = Array.from({ length: columns }, (_, c) => Math.min(Math.max(...rows.map((r) => r[c].length), 6), 40));
    const total = weights.reduce((a, b) => a + b, 0);
    const cols = weights.map((w) => (w / total) * TEXT_WIDTH);
    const padX = 5;
    const padY = 4;
    const lineH = SIZE.table * LEADING;
    const hasHead = rows.length > 1;
    const cellLines = (r, head) => r.map((text, c) => layout([{ style: style(SIZE.table, head ? el.color : INK, head), text }], cols[c] - 2 * padX));

    // draws one row, or as much of it as fits, and returns the lines left over
    const drawRow = (cells, head) => {
      const longest = Math.max(1, ...cells.map((l) => l.length));
      const fit = Math.max(1, Math.floor((BOTTOM - y - 2 * padY) / lineH));
      const count = Math.min(longest, fit);
      const height = count * lineH + 2 * padY;
      let x = LEFT;
      cells.forEach((lines, c) => {
        if (head) doc.rect(x, y, cols[c], height).fillColor(tint(el.color)).fill();
        doc.rect(x, y, cols[c], height).lineWidth(0.5).strokeColor(RULE).stroke();
        const rowTop = y;
        y += padY;
        lines.slice(0, count).forEach((line) => drawLine(line, x + padX, SIZE.table));
        y = rowTop;
        x += cols[c];
      });
      y += height;
      return longest > count ? cells.map((l) => l.slice(count)) : null;
    };

    y += 4;
    const headLines = hasHead ? cellLines(rows[0], true) : null;
    rows.forEach((r, ri) => {
      const head = hasHead && ri === 0;
      let cells = head ? headLines : cellLines(r, false);
      const height = Math.max(1, ...cells.map((l) => l.length)) * lineH + 2 * padY;
      // a row moves to the next page whole when it can; the head is repeated there
      if (y + height > BOTTOM && !atTop()) {
        newPage();
        if (hasHead && !head) drawRow(headLines, true);
      }
      while (cells) {
        cells = drawRow(cells, head);
        if (cells) newPage(); // a row taller than a page continues on the next
      }
    });
    y += 10;
  };

  model.elements.forEach((el, i) => {
    if (el.kind === "heading") heading(el, i);
    else if (el.kind === "keywords") keyTerms(el);
    else if (el.kind === "para") {
      drawLines(layout(bodyRuns(el.segments, el.color), TEXT_WIDTH), LEFT, SIZE.body);
      y += 6;
    } else if (el.kind === "label") {
      const lines = layout([{ style: style(SIZE.body, el.color, true), text: el.text }], TEXT_WIDTH);
      need((lines.length + 2) * SIZE.body * LEADING); // stays with the list it introduces
      y += 2;
      drawLines(lines, LEFT, SIZE.body);
      y += 2;
    } else if (el.kind === "list") {
      list(el.items, el.color);
      y += 4;
    } else if (el.kind === "table") table(el);
  });

  // ---- now that every page exists: contents page numbers, then page footers
  const small = style(SIZE.small, MUTED);
  for (const entry of pending) {
    const number = String(pageOf.get(entry.id) ?? "");
    if (!number) continue;
    doc.switchToPage(entry.page);
    const st = style(SIZE.body, INK, entry.bold);
    const numberX = RIGHT - widthOf(number, st);
    draw(number, numberX, entry.y, st);
    const lineY = entry.y + SIZE.body * 0.98;
    if (numberX - 6 > entry.textEnd + 6) {
      doc.moveTo(entry.textEnd + 6, lineY).lineTo(numberX - 6, lineY).lineWidth(0.6).dash(0.6, { space: 3 }).strokeColor(RULE).stroke().undash();
    }
  }
  const pages = doc.bufferedPageRange().count;
  let footerTitle = printable(model.title);
  while (footerTitle.length > 4 && widthOf(footerTitle, small) > TEXT_WIDTH - 90) footerTitle = `${footerTitle.slice(0, -4).trimEnd()}...`;
  for (let i = 0; i < pages; i++) {
    doc.switchToPage(i);
    const label = `Page ${i + 1} of ${pages}`;
    const fy = PAGE.height - PAGE.margin + 4;
    draw(footerTitle, LEFT, fy, small);
    draw(label, RIGHT - widthOf(label, small), fy, small);
  }

  doc.end();
  return done;
}
