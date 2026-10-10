// Finding formulas in note text: $x^2 + y^2$ inline, $$\int_0^1 f(x)\,dx$$ on
// its own line. Shared by components/MathText.jsx and NoteContent.jsx.
//
// A "$" only starts a formula when what follows looks like maths (it holds
// one of \ ^ _ { } =), so prices such as "$5 and $10" stay plain text.
export const MATH = /\$\$([^$]{1,2000})\$\$|\$(?!\s)([^$\n]{1,500}?)(?<!\s)\$(?!\d)/g;
export const looksLikeMath = (tex) => /[\\^_{}=]/.test(tex);

export function hasMath(text) {
  for (const m of String(text || "").matchAll(MATH)) if (looksLikeMath(m[1] ?? m[2])) return true;
  return false;
}

