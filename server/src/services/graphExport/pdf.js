// A graph download (model.js) written as a PDF.
//
// A4 landscape. The first page is the drawing - the whole graph, scaled to
// fill the page, labels that would overlap nudged apart, with its legend
// under it - and the tables follow from the
// second page: a row moves to the next page whole when it can, and the head
// row is repeated there. Each table is a bookmark in the reader's outline.
//
// Fonts, text colours and footers are those of the notes download
// (services/noteExport/pdf.js), so the two files look like one app's: DejaVu
// Sans, with the Greek letters and maths signs engineering notes use. pdfkit
// is loaded on first use, so it costs no memory until someone downloads.

import { fileURLToPath } from "node:url";
import { INK, MUTED, PRIMARY, RULE, tint } from "../noteExport/format.js";

const FONT_DIR = fileURLToPath(new URL("../../../assets/fonts/", import.meta.url));
const PAGE = { width: 841.89, height: 595.28, margin: 40 }; // A4 landscape
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin;
const TEXT_WIDTH = RIGHT - LEFT;
const TOP = PAGE.margin;
const BOTTOM = PAGE.height - PAGE.margin - 14; // the last 14 pt belong to the footer
// Node graphics are drawn at the page's CSS size times this, kept between
// these: a small graph does not get poster-sized labels and a big one stays
// readable (a 13 px note title ends up between 6.5 and 9 pt). Past the
// minimum, a very large graph crowds rather than shrinks further.
const NODE_SCALE = { min: 0.5, max: 0.7 };
// Points per canvas unit at most, so two or three notes are not spread to the corners.
const MAX_SPREAD = 1.2;
const FRAME_PAD = 12; // between the drawing's frame and its nodes
const NODE_GAP = 3; // points kept between two labels that had to be moved apart
const LEGEND = { size: 7.5, row: 12, spacing: 14 };
const TABLE = { size: 8.5, leading: 1.4, padX: 5, padY: 4 };
// Where a line of text sits: pdfkit places text by the top of its line, and
// the middle of lower- and upper-case letters is about this far below it, in
// font sizes.
const TEXT_MIDDLE = 0.6;

let PDFDocument = null;
async function load() {
  PDFDocument ||= (await import("pdfkit")).default;
  return PDFDocument;
}

/** The model as a PDF file. Returns a Buffer. */
export async function renderGraphPdf(model) {
  const Doc = await load();
  const doc = new Doc({
    size: "A4",
    layout: "landscape",
    margin: PAGE.margin,
    bufferPages: true, // pages stay open, so "Page 1 of 3" can be written once all exist
    lang: "en",
    displayTitle: true,
    info: { Title: `${model.title} - ${model.kicker}`, Author: "Mind Atlas", Subject: model.meta, Creator: "Mind Atlas" },
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

  // ---- measuring and drawing text
  const font = (bold, size) => doc.font(bold ? "bold" : "regular").fontSize(size);
  const widths = new Map();
  const widthOf = (text, size, bold = false, tracking = 0) => {
    const key = `${bold ? 1 : 0}|${size}|${tracking}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      w = font(bold, size).widthOfString(text, { characterSpacing: tracking });
      widths.set(key, w);
    }
    return w;
  };
  const draw = (text, x, y, { size, bold = false, color = INK, tracking = 0 }) =>
    font(bold, size).fillColor(color).text(text, x, y, { lineBreak: false, characterSpacing: tracking });
  /** `text` cut short with "…" where it would run past `maxWidth`. */
  const fitText = (text, size, bold, maxWidth) => {
    let t = printable(text);
    if (widthOf(t, size, bold) <= maxWidth) return t;
    while (t.length > 1 && widthOf(`${t}…`, size, bold) > maxWidth) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  };

  /**
   * Styled runs [{ text, bold, color }] broken into lines no wider than
   * `maxWidth`, at spaces and at "\n". A line is { pieces, width }, each piece
   * { text, bold, color, width } ready to draw.
   */
  const wrap = (runs, maxWidth, size) => {
    const lines = [{ pieces: [], width: 0 }];
    let line = lines[0];
    let space = null; // the space before the next word, in the style it was written in
    const push = (piece) => {
      const last = line.pieces[line.pieces.length - 1];
      if (last && last.bold === piece.bold && last.color === piece.color) {
        last.text += piece.text;
        last.width += piece.width;
      } else line.pieces.push({ ...piece });
      line.width += piece.width;
    };
    const newLine = () => {
      lines.push((line = { pieces: [], width: 0 }));
      space = null;
    };
    for (const run of runs) {
      const bold = Boolean(run.bold);
      const color = run.color || INK;
      for (const raw of String(run.text).split(/(\n| +)/)) {
        if (!raw) continue;
        if (raw === "\n") {
          newLine();
          continue;
        }
        if (!raw.trim()) {
          if (line.pieces.length) space = { text: " ", bold, color, width: widthOf(" ", size, bold) };
          continue;
        }
        const part = printable(raw);
        const width = widthOf(part, size, bold);
        if (line.pieces.length && line.width + (space?.width || 0) + width > maxWidth) newLine();
        else if (space) push(space);
        space = null;
        if (width <= maxWidth) {
          push({ text: part, bold, color, width });
          continue;
        }
        // one word wider than the column (a URL, a long identifier): cut it
        let rest = part;
        while (rest) {
          let n = rest.length;
          while (n > 1 && line.width + widthOf(rest.slice(0, n), size, bold) > maxWidth) n -= 1;
          if (n === 1 && line.pieces.length && line.width + widthOf(rest[0], size, bold) > maxWidth) {
            newLine();
            continue;
          }
          const text = rest.slice(0, n);
          push({ text, bold, color, width: widthOf(text, size, bold) });
          rest = rest.slice(n);
          if (rest) newLine();
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
  const need = (height) => {
    if (y + height > BOTTOM && !atTop()) newPage();
  };

  // ---- page 1: title block
  draw(printable(model.kicker.toUpperCase()), LEFT, y, { size: 8, color: MUTED, tracking: 0.8 });
  y += 8 * 1.6;
  draw(fitText(model.title, 18, true, TEXT_WIDTH), LEFT, y, { size: 18, bold: true, color: PRIMARY });
  y += 18 * 1.3;
  draw(fitText(model.meta, 8, false, TEXT_WIDTH), LEFT, y, { size: 8, color: MUTED });
  y += 8 * 1.5 + 8;
  doc.outline.addItem(model.kicker);

  // ---- page 1: legend, laid out first so the drawing gets the room left over
  const legendItems = model.drawing.legend.map((item) => {
    const swatch = item.swatch.kind === "line" ? 18 : item.swatch.kind === "box" ? 11 : 7.5;
    const text = printable(item.text);
    return { ...item, text, swatchWidth: swatch, width: swatch + 4 + widthOf(text, LEGEND.size) };
  });
  const legendRows = [[]];
  let rowWidth = 0;
  for (const item of legendItems) {
    if (legendRows[legendRows.length - 1].length && rowWidth + LEGEND.spacing + item.width > TEXT_WIDTH) {
      legendRows.push([]);
      rowWidth = 0;
    }
    rowWidth += (legendRows[legendRows.length - 1].length ? LEGEND.spacing : 0) + item.width;
    legendRows[legendRows.length - 1].push(item);
  }
  const legendTop = BOTTOM - legendRows.length * LEGEND.row;

  // ---- page 1: the drawing
  const frame = { x: LEFT, y, w: TEXT_WIDTH, h: legendTop - 8 - y };
  doc.roundedRect(frame.x, frame.y, frame.w, frame.h, 8).lineWidth(0.75).stroke("#e3e1d3");
  const area = { x: frame.x + FRAME_PAD, y: frame.y + FRAME_PAD, w: frame.w - 2 * FRAME_PAD, h: frame.h - 2 * FRAME_PAD };

  // a node's size in CSS pixels (pdfkit measures a 13 pt string as 13 px would be)
  const lineHeight = (l, stacked) => l.size * (stacked ? 1.25 : 1.35);
  const measure = (n) => {
    const stacked = n.lines.length > 1;
    const textW = Math.max(...n.lines.map((l) => widthOf(printable(l.text), l.size, l.bold, l.size * (l.tracking || 0))));
    const textH = n.lines.reduce((h, l) => h + lineHeight(l, stacked), 0);
    const lead = n.dot?.size || n.glyph?.size || 0;
    const badgeW = n.badge ? widthOf(printable(n.badge.text), 10) + 12 : 0;
    const w = n.padX + (lead ? lead + n.gap : 0) + textW + (badgeW ? n.gap + badgeW : 0) + (n.padR ?? n.padX);
    const h = 2 * n.padY + Math.max(textH, lead, n.badge ? 16 : 0);
    return { w, h, textH, badgeW, stacked };
  };
  const nodes = model.drawing.nodes.map((n) => ({ n, m: measure(n) }));

  // The largest spread (points per canvas unit) at which every node, at node
  // scale `f`, fits `room` along one axis. Nodes keep their size as the
  // spread changes, so the answer is found by halving.
  const extent = (coords, halves, s) => {
    let lo = Infinity;
    let hi = -Infinity;
    coords.forEach((c, i) => {
      lo = Math.min(lo, c * s - halves[i]);
      hi = Math.max(hi, c * s + halves[i]);
    });
    return { lo, hi };
  };
  const spreadFor = (coords, halves, room) => {
    const fits = (s) => {
      const e = extent(coords, halves, s);
      return e.hi - e.lo <= room;
    };
    if (fits(MAX_SPREAD)) return MAX_SPREAD;
    let lo = 0;
    let hi = MAX_SPREAD;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  // Nodes that overlap at spread `s` pushed apart until none do - each pair
  // the shorter way, which for a wide label is up or down. Moves the canvas
  // positions in `xs` and `ys`; true if anything moved.
  const separate = (xs, ys, hw, hh, s) => {
    let any = false;
    for (let pass = 0; pass < 100; pass++) {
      let moved = false;
      for (let i = 0; i < xs.length; i++) {
        for (let j = i + 1; j < xs.length; j++) {
          const dx = (xs[j] - xs[i]) * s;
          const dy = (ys[j] - ys[i]) * s;
          const ox = hw[i] + hw[j] + NODE_GAP - Math.abs(dx);
          const oy = hh[i] + hh[j] + NODE_GAP - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (oy <= ox) {
            const push = ((dy < 0 ? -1 : 1) * oy) / 2 / s;
            ys[i] -= push;
            ys[j] += push;
          } else {
            const push = ((dx < 0 ? -1 : 1) * ox) / 2 / s;
            xs[i] -= push;
            xs[j] += push;
          }
        }
      }
      if (!moved) break;
      any = true;
    }
    return any;
  };

  const xs = nodes.map(({ n }) => n.x);
  const ys = nodes.map(({ n }) => n.y);
  let f = NODE_SCALE.max;
  let s = MAX_SPREAD;
  const halves = (side) => nodes.map(({ m }) => (m[side] * f) / 2);
  const fit = () => {
    for (let i = 0; i < 4; i++) {
      s = Math.min(spreadFor(xs, halves("w"), area.w), spreadFor(ys, halves("h"), area.h));
      f = Math.min(NODE_SCALE.max, Math.max(NODE_SCALE.min, s));
    }
  };
  fit();
  // On screen a student zooms in to read labels that overlap; on paper they
  // cannot, so overlapping labels are nudged apart and the graph fitted to the
  // page again. The arrangement stays the page's.
  for (let round = 0; round < 6 && separate(xs, ys, halves("w"), halves("h"), s); round++) fit();
  const ex = extent(xs, halves("w"), s);
  const ey = extent(ys, halves("h"), s);
  const ox = area.x + (area.w - (ex.hi - ex.lo)) / 2 - ex.lo;
  const oy = area.y + (area.h - (ey.hi - ey.lo)) / 2 - ey.lo;
  const placed = new Map(nodes.map(({ n }, i) => [n.id, [ox + xs[i] * s, oy + ys[i] * s]]));

  for (const l of model.drawing.lines) {
    const a = placed.get(l.from);
    const b = placed.get(l.to);
    if (!a || !b) continue;
    doc.save();
    doc.opacity(l.opacity ?? 1).lineWidth(Math.max(0.4, l.width * f)).lineCap(l.cap || "butt");
    if (l.dash) doc.dash(l.dash[0] * f, { space: l.dash[1] * f });
    doc.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke(l.color);
    doc.restore();
  }

  // a page with a folded corner, for the screen's "description" icon
  const documentGlyph = (x, cy, size, color) => {
    const w = size * 0.62;
    const h = size * 0.8;
    const fold = w * 0.35;
    const left = x + (size - w) / 2;
    const top = cy - h / 2;
    doc.save().lineWidth(size * 0.08).lineJoin("round").strokeColor(color);
    doc.moveTo(left, top).lineTo(left + w - fold, top).lineTo(left + w, top + fold).lineTo(left + w, top + h).lineTo(left, top + h).closePath().stroke();
    doc.moveTo(left + w * 0.22, top + h * 0.52).lineTo(left + w * 0.78, top + h * 0.52).stroke();
    doc.moveTo(left + w * 0.22, top + h * 0.72).lineTo(left + w * 0.78, top + h * 0.72).stroke();
    doc.restore();
  };
  const dot = (cx, cy, d, { fill, stroke, dash }, hairline) => {
    if (fill) doc.circle(cx, cy, d / 2).fill(fill);
    if (!stroke) return;
    // a ring for a note in no cluster; a hairline edge on a pale filled dot
    const lw = fill ? hairline : Math.max(0.6, d * 0.14);
    doc.circle(cx, cy, d / 2 - lw / 2).lineWidth(lw);
    if (dash) doc.dash(d * 0.18, { space: d * 0.14 });
    doc.stroke(stroke);
    doc.undash();
  };

  for (const { n, m } of nodes) {
    const w = m.w * f;
    const h = m.h * f;
    const [cx, cy] = placed.get(n.id);
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    const r = n.shape === "pill" ? h / 2 : Math.min(h / 2, (n.shape === "card" ? 16 : 8) * f);
    doc.save();
    if (n.opacity !== undefined) doc.opacity(n.opacity);
    if (n.fill) doc.roundedRect(x0, y0, w, h, r).fill(n.fill);
    if (n.ring || n.stroke) {
      doc.roundedRect(x0, y0, w, h, r).lineWidth(n.ring ? 2 * f : Math.max(0.5, f));
      if (n.dash) doc.dash(3 * f, { space: 2 * f });
      doc.stroke(n.ring || n.stroke);
      doc.undash();
    }
    let x = x0 + n.padX * f;
    if (n.dot) {
      dot(x + (n.dot.size * f) / 2, cy, n.dot.size * f, n.dot, 0.75 * f);
      x += (n.dot.size + n.gap) * f;
    } else if (n.glyph) {
      documentGlyph(x, cy, n.glyph.size * f, n.glyph.color);
      x += (n.glyph.size + n.gap) * f;
    }
    let top = cy - (m.textH * f) / 2;
    for (const l of n.lines) {
      const lh = lineHeight(l, m.stacked) * f;
      const size = l.size * f;
      draw(printable(l.text), x, top + lh / 2 - TEXT_MIDDLE * size, { size, bold: l.bold, color: l.color, tracking: size * (l.tracking || 0) });
      top += lh;
    }
    if (n.badge) {
      const bw = m.badgeW * f;
      const bh = 16 * f;
      const bx = x0 + w - (n.padR ?? n.padX) * f - bw;
      doc.roundedRect(bx, cy - bh / 2, bw, bh, 4 * f).fill(n.badge.fill);
      draw(printable(n.badge.text), bx + 6 * f, cy - TEXT_MIDDLE * 10 * f, { size: 10 * f, color: n.badge.color });
    }
    doc.restore();
  }

  legendRows.forEach((row, i) => {
    const mid = legendTop + i * LEGEND.row + LEGEND.row / 2;
    let x = LEFT;
    for (const item of row) {
      const sw = item.swatch;
      doc.save();
      if (sw.kind === "dot") dot(x + 3.75, mid, 7.5, sw, 0.6);
      else if (sw.kind === "box") doc.roundedRect(x, mid - 3.75, 11, 7.5, 1.5).fill(sw.fill);
      else {
        doc.lineWidth(1.6).lineCap(sw.cap || "butt");
        if (sw.dash) doc.dash(sw.dash[0] * 0.8, { space: sw.dash[1] * 0.8 });
        doc.moveTo(x, mid).lineTo(x + 18, mid).stroke(sw.color);
      }
      doc.restore();
      draw(item.text, x + item.swatchWidth + 4, mid - TEXT_MIDDLE * LEGEND.size, { size: LEGEND.size, color: MUTED });
      x += item.width + LEGEND.spacing;
    }
  });

  // ---- the tables, from page 2
  const rowLine = TABLE.size * TABLE.leading;
  const drawPieces = (line, x, top, size, lh) => {
    let at = x;
    for (const p of line.pieces) {
      draw(p.text, at, top + lh / 2 - TEXT_MIDDLE * size, { size, bold: p.bold, color: p.color });
      at += p.width;
    }
  };
  const paragraph = (runs, size = TABLE.size) => {
    for (const line of wrap(runs, TEXT_WIDTH, size)) {
      need(size * 1.45);
      drawPieces(line, LEFT, y, size, size * 1.45);
      y += size * 1.45;
    }
  };

  const table = (section) => {
    const total = section.columns.reduce((a, c) => a + c.width, 0);
    const cols = section.columns.map((c) => (c.width / total) * TEXT_WIDTH);
    const prepare = (cell, c, head) => {
      const runs = head ? [{ text: cell, bold: true, color: PRIMARY }] : typeof cell === "string" ? [{ text: cell }] : cell.runs;
      const mark = !head && typeof cell === "object" ? cell.dot || null : null;
      const indent = mark ? 11 : 0;
      return { lines: wrap(runs, cols[c] - 2 * TABLE.padX - indent, TABLE.size), mark, indent };
    };
    const headCells = section.columns.map((col, c) => prepare(col.title, c, true));
    const heightOf = (cells) => Math.max(1, ...cells.map((c) => c.lines.length)) * rowLine + 2 * TABLE.padY;

    // draws one row, or as much of it as fits, and returns the lines left over
    const drawRow = (cells, head) => {
      const longest = Math.max(1, ...cells.map((c) => c.lines.length));
      const count = Math.min(longest, Math.max(1, Math.floor((BOTTOM - y - 2 * TABLE.padY) / rowLine)));
      const height = count * rowLine + 2 * TABLE.padY;
      let x = LEFT;
      cells.forEach((cell, c) => {
        if (head) doc.rect(x, y, cols[c], height).fill(tint(PRIMARY, 0.9));
        doc.rect(x, y, cols[c], height).lineWidth(0.5).stroke(RULE);
        if (cell.mark) dot(x + TABLE.padX + 3.5, y + TABLE.padY + rowLine / 2, 7, cell.mark, 0.6);
        cell.lines.slice(0, count).forEach((line, i) => drawPieces(line, x + TABLE.padX + cell.indent, y + TABLE.padY + i * rowLine, TABLE.size, rowLine));
        x += cols[c];
      });
      y += height;
      return longest > count ? cells.map((cell) => ({ ...cell, mark: null, lines: cell.lines.slice(count) })) : null;
    };

    drawRow(headCells, true);
    for (const row of section.rows) {
      let cells = row.map((cell, c) => prepare(cell, c, false));
      // a row moves to the next page whole when it can; the head is repeated there
      if (y + heightOf(cells) > BOTTOM) {
        newPage();
        drawRow(headCells, true);
      }
      while (cells) {
        cells = drawRow(cells, false);
        if (cells) {
          newPage(); // a row taller than a page continues on the next
          drawRow(headCells, true);
        }
      }
    }
  };

  newPage();
  for (const section of model.sections) {
    const intro = section.intro ? wrap([{ text: section.intro, color: MUTED }], TEXT_WIDTH, TABLE.size) : [];
    // the heading stays with its introduction, the head row and the first row
    need(13 * 1.5 + intro.length * TABLE.size * 1.45 + 6 + 3 * rowLine + 4 * TABLE.padY);
    doc.outline.addItem(printable(section.title));
    draw(printable(section.title), LEFT, y, { size: 13, bold: true, color: PRIMARY });
    y += 13 * 1.5;
    for (const line of intro) {
      drawPieces(line, LEFT, y, TABLE.size, TABLE.size * 1.45);
      y += TABLE.size * 1.45;
    }
    y += 6;
    if (section.rows.length) table(section);
    else paragraph([{ text: section.empty || "Nothing to list.", color: MUTED }]);
    if (section.after) {
      y += 6;
      paragraph([{ text: section.after }]);
    }
    y += 20;
  }

  // ---- now that every page exists: the footers
  const pages = doc.bufferedPageRange().count;
  const footerTitle = fitText(`${model.title} · ${model.kicker.toLowerCase()}`, LEGEND.size, false, TEXT_WIDTH - 90);
  for (let i = 0; i < pages; i++) {
    doc.switchToPage(i);
    const label = `Page ${i + 1} of ${pages}`;
    const fy = PAGE.height - PAGE.margin + 4;
    draw(footerTitle, LEFT, fy, { size: LEGEND.size, color: MUTED });
    draw(label, RIGHT - widthOf(label, LEGEND.size), fy, { size: LEGEND.size, color: MUTED });
  }

  doc.end();
  return done;
}
