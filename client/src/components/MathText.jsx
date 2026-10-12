import { useEffect, useState } from "react";

// Formulas in notes: $x^2 + y^2$ inline, $$\int_0^1 f(x)\,dx$$ on its own
// line, written the way LaTeX writes them. Rendered with KaTeX, which is
// loaded only when a note actually has a formula.
//
// Safe for untrusted text: KaTeX escapes everything it is given, and with
// `trust: false` the commands that could add links or HTML (\href, \url,
// \htmlClass, \includegraphics...) are refused. Its output is the only HTML
// the app inserts as HTML. Anything that fails to parse is shown as written.
// Which "$...$" count as formulas: lib/math.js.
import { MATH, hasMath, looksLikeMath } from "../lib/math.js";

let katexLoading = null;
const loadKatex = () =>
  (katexLoading ||= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([k]) => k.default || k));

function split(text) {
  const parts = [];
  let last = 0;
  for (const m of String(text).matchAll(MATH)) {
    const tex = m[1] ?? m[2];
    if (!looksLikeMath(tex)) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ tex, display: m[1] !== undefined, raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export default function MathText({ text }) {
  const [katex, setKatex] = useState(null);
  const math = hasMath(text);
  useEffect(() => {
    if (!math) return undefined;
    let live = true;
    loadKatex()
      .then((k) => live && setKatex(() => k))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [math]);
  if (!math || !katex) return text;
  return split(text).map((p, i) => {
    if (p.text !== undefined) return p.text;
    let html;
    try {
      html = katex.renderToString(p.tex, { displayMode: p.display, throwOnError: false, trust: false, strict: "ignore", maxSize: 20, maxExpand: 200 });
    } catch {
      return p.raw;
    }
    // eslint-disable-next-line react/no-danger
    return <span key={i} className={p.display ? "block my-space-sm overflow-x-auto" : undefined} data-testid="math" dangerouslySetInnerHTML={{ __html: html }} />;
  });
}
