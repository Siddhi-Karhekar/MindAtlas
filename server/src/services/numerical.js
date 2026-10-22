// Numerical MCQs from a formula in the notes, computed - never guessed.
//
// A formula cannot be blanked into a fair MCQ ("EA = _____ + displacement"
// tests reading). It CAN be applied: "The effective address is computed as
// $EA = base + displacement$. What is $EA$ when $base = 2000$ and
// $displacement = 40$?" tests whether the student can use it, and the answer
// is a number the server works out itself. The wrong options are the numbers
// a student gets by a typical slip: one operator confused with its inverse
// (× for ÷, + for −), the operands of a division swapped, a term left out of a
// sum, or - for "1/R = 1/R1 + 1/R2" - forgetting to take the reciprocal.
//
// Safety: nothing here evaluates text as code. A formula is accepted only
// when it parses, with the small grammar below, into numbers, variables,
// + − × ÷ ^ and brackets; anything else (functions, limits, sums, words that
// are not variables) is no numerical question. Code in the notes is never run
// either: executing a student's upload on the server would be a way into it,
// so code-tracing questions are left to the theory section.
//
// Every numerical question carries `computation` ({ formula, target, values,
// reciprocal }), and the quality gate (questionEvaluator.js) parses the
// formula again and recomputes the answer before the question is accepted.

const FUNCTION_WORDS = new Set(
  "sin cos tan log ln exp lim sum max min mod sqrt abs where and or the of is are as for with when then if per in on at by to".split(" ")
);

// tokens: numbers, identifiers (R1, R_1, base, EA), operators, brackets
function tokenize(src) {
  const s = String(src)
    .replace(/\\times|\\cdot|×|·|∗/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–]/g, "-")
    .replace(/\\left|\\right|\{|\}/g, (m) => (m === "{" ? "(" : m === "}" ? ")" : ""));
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z][A-Za-z0-9_]*'?)|([-+*/^()=]))/y;
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    if (m[1]) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2]) out.push({ t: "id", v: m[2] });
    else out.push({ t: "op", v: m[3] });
    i = re.lastIndex;
  }
  return out;
}

// expr := term (('+'|'-') term)* ; term := power (('*'|'/') power)* ;
// power := unary ('^' unary)? ; unary := '-'? atom ; atom := num | id | '(' expr ')'
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const take = (v) => (peek()?.t === "op" && peek().v === v ? (p++, true) : false);
  function atom() {
    const tk = peek();
    if (!tk) throw new Error("end");
    if (tk.t === "num") return p++, { n: tk.v };
    if (tk.t === "id") {
      if (FUNCTION_WORDS.has(tk.v.toLowerCase())) throw new Error("function");
      return p++, { v: tk.v };
    }
    if (take("(")) {
      const e = expr();
      if (!take(")")) throw new Error("bracket");
      return e;
    }
    throw new Error("atom");
  }
  function unary() {
    return take("-") ? { op: "neg", a: atom() } : atom();
  }
  function power() {
    const a = unary();
    return take("^") ? { op: "^", a, b: unary() } : a;
  }
  function term() {
    let a = power();
    for (;;) {
      if (take("*")) a = { op: "*", a, b: power() };
      else if (take("/")) a = { op: "/", a, b: power() };
      else return a;
    }
  }
  function expr() {
    let a = term();
    for (;;) {
      if (take("+")) a = { op: "+", a, b: term() };
      else if (take("-")) a = { op: "-", a, b: term() };
      else return a;
    }
  }
  const e = expr();
  if (p !== tokens.length) throw new Error("trailing");
  return e;
}

export function evaluate(node, values) {
  if ("n" in node) return node.n;
  if ("v" in node) {
    if (!(node.v in values)) throw new Error(`no value for ${node.v}`);
    return values[node.v];
  }
  const a = evaluate(node.a, values);
  if (node.op === "neg") return -a;
  const b = evaluate(node.b, values);
  switch (node.op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return a / b;
    case "^": return a ** b;
    default: throw new Error("op");
  }
}

const variablesOf = (node, out = new Set()) => {
  if ("v" in node) out.add(node.v);
  if (node.a) variablesOf(node.a, out);
  if (node.b) variablesOf(node.b, out);
  return out;
};
const opsOf = (node, out = []) => {
  if (node.op) out.push(node.op);
  if (node.a) opsOf(node.a, out);
  if (node.b) opsOf(node.b, out);
  return out;
};

/**
 * Parse "LHS = RHS" into { target, reciprocal, rhs, variables }, or null.
 * LHS is one variable ("V") or its reciprocal ("1/R").
 */
export function parseRelation(formula) {
  const tokens = tokenize(formula);
  if (!tokens) return null;
  const eq = tokens.findIndex((x) => x.t === "op" && x.v === "=");
  if (eq < 1 || tokens.slice(eq + 1).some((x) => x.t === "op" && x.v === "=")) return null;
  const lhs = tokens.slice(0, eq);
  let target = null;
  let reciprocal = false;
  if (lhs.length === 1 && lhs[0].t === "id") target = lhs[0].v;
  else if (lhs.length === 3 && lhs[0].t === "num" && lhs[0].v === 1 && lhs[1].v === "/" && lhs[2].t === "id") {
    target = lhs[2].v;
    reciprocal = true;
  }
  if (!target || FUNCTION_WORDS.has(target.toLowerCase())) return null;
  let rhs;
  try {
    rhs = parse(tokens.slice(eq + 1));
  } catch {
    return null;
  }
  const variables = [...variablesOf(rhs)];
  // something to compute: at least one variable and one operation, never the
  // target on both sides, never more inputs than a question can state
  if (!variables.length || variables.length > 4 || variables.includes(target) || !opsOf(rhs).length) return null;
  return { target, reciprocal, rhs, variables };
}

const LEAD_END = /\b(?:is|are|as|given by|computed as|calculated as|defined as|obtained as|equals?)\s*$/i;
/**
 * The formulas in a sentence that can be applied, with the words that lead up
 * to each ("The effective address is computed as"). A formula ends at a comma,
 * a semicolon, the end of the sentence, "where" or a second "=".
 */
export function relationsIn(sentence) {
  const s = String(sentence || "");
  const out = [];
  // inside $...$ first, then plain text
  const latex = [...s.matchAll(/\$([^$]{3,80})\$/g)].map((m) => ({ text: m[1], at: m.index, raw: m[0] }));
  const plain = latex.length
    ? []
    : [...s.matchAll(/(?:(?<=\s)|^)((?:1\s*\/\s*)?[A-Za-z][A-Za-z0-9_]{0,15})\s*=\s*([^=,;]+?)(?=\s*(?:,|;|\.\s|\.$|\b(?:where|which|when|and|for|in|if|with|is|are|gives?|watts|ohms|volts|units?)\b|=|$))/g)].map((m) => ({
        text: `${m[1]} = ${m[2].trim()}`,
        at: m.index,
        raw: m[0],
      }));
  for (const f of [...latex, ...plain]) {
    // a run of "= ... =" (P = V × I = I^2 R): only the first link is taken
    const first = f.text.split("=").slice(0, 2).join("=");
    const rel = parseRelation(first);
    if (!rel) continue;
    const before = s.slice(0, f.at).trim();
    const lead = LEAD_END.test(before) && before.split(/\s+/).length <= 16 && !/[=$]/.test(before) ? before : null;
    out.push({ formula: first.trim(), ...rel, lead });
  }
  return out;
}

// a small deterministic random sequence, so the same formula gives the same
// question in a test and in its re-check
function seeded(seed) {
  let x = 0;
  for (const c of String(seed)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

export const formatNumber = (x) => {
  if (!Number.isFinite(x)) return null;
  const r = Math.abs(x) >= 100 ? Math.round(x * 100) / 100 : Math.round(x * 1000) / 1000;
  return String(Number(r.toFixed(3)));
};

/** The value the formula gives for these inputs (the reciprocal taken when the formula is for 1/target). */
export function computeTarget(rel, values) {
  const v = evaluate(rel.rhs, values);
  return rel.reciprocal ? 1 / v : v;
}

// One slip at a time, each a different tree: an operator confused with
// another (× for ÷, + for ×, ...), the operands of a division or subtraction
// swapped, a term of a sum left out, or every "1/x" read as "x".
const OTHER_OPS = { "*": ["/", "+"], "/": ["*", "-"], "+": ["-", "*"], "-": ["+", "/"], "^": ["*"] };
function slips(node) {
  const out = [];
  const walk = (n, rebuild) => {
    if (!n.op || n.op === "neg") {
      if (n.a) walk(n.a, (x) => rebuild({ ...n, a: x }));
      return;
    }
    for (const op of OTHER_OPS[n.op]) out.push({ why: `${n.op}->${op}`, tree: rebuild({ ...n, op }) });
    if (n.op === "/" || n.op === "-" || n.op === "*") out.push({ why: `operands-swapped:${n.op}`, tree: rebuild(n.op === "*" ? { ...n, op: "/", a: n.b, b: n.a } : { ...n, a: n.b, b: n.a }) });
    if (n.op === "+") {
      out.push({ why: "term-left-out", tree: rebuild(n.a) });
      out.push({ why: "term-left-out", tree: rebuild(n.b) });
    }
    walk(n.a, (x) => rebuild({ ...n, a: x }));
    walk(n.b, (x) => rebuild({ ...n, b: x }));
  };
  walk(node, (x) => x);
  return out;
}
// "1/R1 + 1/R2" read as "R1 + R2"
const withoutReciprocals = (n) =>
  n.op === "/" && n.a && "n" in n.a && n.a.n === 1 ? withoutReciprocals(n.b) : n.op ? { ...n, a: n.a && withoutReciprocals(n.a), b: n.b && withoutReciprocals(n.b) } : n;

/**
 * A numerical MCQ for one relation: inputs, the computed answer, and three
 * wrong answers from typical slips. Null when no set of inputs gives four
 * clearly different, sensible numbers.
 */
export function numericalItem(rel, { seed = rel.formula } = {}) {
  const random = seeded(seed);
  for (let attempt = 0; attempt < 25; attempt++) {
    const values = {};
    const used = new Set();
    for (const v of rel.variables) {
      let x;
      do x = 2 + Math.floor(random() * 11);
      while (used.has(x) && used.size < 10);
      used.add(x);
      values[v] = x;
    }
    let answer;
    try {
      answer = computeTarget(rel, values);
    } catch {
      return null;
    }
    if (!Number.isFinite(answer) || answer === 0) continue;
    const answerText = formatNumber(answer);
    // a tidy answer first ("1.25" rather than "1.222"), any answer later
    if (attempt < 15 && /\.\d{3,}$/.test(answerText)) continue;
    // the answer must not be one of the inputs, or the stem would print it
    if (Object.values(values).some((x) => formatNumber(x) === answerText)) continue;
    const wrong = [];
    const seen = new Set([answerText]);
    const close = (a, b) => Math.abs(a - b) <= 0.02 * Math.max(Math.abs(a), Math.abs(b));
    const valueOf = (tree) => {
      try {
        const v = evaluate(tree, values);
        return rel.reciprocal ? 1 / v : v;
      } catch {
        return NaN;
      }
    };
    const candidates = slips(rel.rhs).map((sl) => ({ ...sl, value: valueOf(sl.tree) }));
    // "1/R = 1/R1 + 1/R2": the sum itself, the reciprocal never taken
    if (rel.reciprocal) {
      const plain = withoutReciprocals(rel.rhs);
      candidates.unshift(
        { why: "reciprocal-not-taken", value: evaluate(rel.rhs, values) },
        { why: "terms-not-inverted", value: evaluate(plain, values) },
        { why: "terms-not-inverted-then-inverted", value: 1 / evaluate(plain, values) }
      );
    }
    for (const c of candidates) {
      if (wrong.length === 3) break;
      const text = formatNumber(c.value);
      // same sign as the answer: a negative resistance is no temptation
      if (!text || seen.has(text) || Math.sign(c.value) !== Math.sign(answer) || close(c.value, answer) || wrong.some((w) => close(w.value, c.value))) continue;
      seen.add(text);
      wrong.push({ text, value: c.value, why: c.why });
    }
    if (wrong.length < 3) continue;
    return { values, answer: answerText, distractors: wrong.map((w) => w.text), slips: wrong.map((w) => w.why) };
  }
  return null;
}

/** Recompute a stored question's answer from its `computation`: the check the quality gate runs. */
export function recompute(computation) {
  const rel = parseRelation(computation?.formula);
  if (!rel || rel.target !== computation.target) return null;
  try {
    return formatNumber(computeTarget(rel, computation.values || {}));
  } catch {
    return null;
  }
}

/** LaTeX for a formula as parsed: × for *, kept as written otherwise. */
export const latexOf = (formula) => String(formula).replace(/\s*(?:\*|×|·|\\cdot)\s*/g, " \\times ").replace(/\s+/g, " ").trim();
