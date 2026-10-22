// Checks that each question type is only built from content that suits it,
// and that questions render the same whichever writer made them.
//
//   A. classifying content: maths, programming, CS theory, formula-heavy EE
//   B. flattened comparison tables put back into rows (the SPOS screenshot)
//   C. mixed chapters: MCQs only from MCQ material; theory covers the rest
//   D. an AI that writes MCQs from formulas, steps and table rows; what the AI
//      is sent; malformed replies (LaTeX in JSON, broken JSON)
//   E. formatting: repairs, rejections, the client's rich-text reader
//
// No real AI service is called: a local HTTP server stands in for Groq.
import { createServer } from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyText, parseFlattenedComparison } from "../src/services/suitability.js";
import { generateQuestions, isReported, mcqSourceProblem } from "../src/services/testEngine.js";
import { formattingProblems, repairFormatting, validateQuestion } from "../src/services/questionQuality.js";
import { escapeLatexBackslashes, parseJsonLoose } from "../src/services/llm.js";
import { blocksFromPlainText, normalizeContent } from "../src/services/documentStructure.js";
import { withContent } from "../src/services/noteView.js";
import { computeTfidf } from "../src/services/tfidf.js";
import { parseInline, parseRichText } from "../../client/src/lib/richText.js";
import { fitWithin, imageProblem } from "../../client/src/lib/answerImages.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/subjects/${name}`, import.meta.url)), "utf8");
const noteOf = (title, rawText, n = 1) => ({
  _id: String(n).padStart(24, "a"),
  title,
  rawText,
  keywords: computeTfidf(rawText, []).keywords,
  content: normalizeContent(blocksFromPlainText(rawText)),
});
const quiet = () => {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = (...a) => (/^\s*(PASS|FAIL)|^\n?===/.test(String(a[0])) ? log(...a) : null);
  console.warn = () => {};
  console.error = () => {};
  return () => {
    console.log = log;
    console.warn = warn;
    console.error = error;
  };
};
const restore = quiet();

// ---------------------------------------------------------------------------
console.log("\n=== A. Classifying content ===");
const kindOf = (t, ctx) => classifyText(t, ctx);
const cases = [
  // [text, context, expected kind, MCQ allowed]
  ["A loader is a system program that places the executable program into main memory.", {}, "definition", true],
  ["An absolute loader loads the object code at the address specified by the assembler.", {}, "fact", true],
  ["The derivative is defined as the limit $f'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}$ whenever this limit exists.", {}, "formula", false],
  ["For resistors in parallel the total resistance is given by 1/R = 1/R1 + 1/R2, and the same voltage appears across each resistor.", {}, "formula", false],
  ["Ohm's law states that the current is proportional to the voltage, as V = I × R.", {}, "formula", false],
  ["The statement `return n * factorial(n - 1);` multiplies n by the factorial of the smaller number.", {}, "code", false],
  ["int factorial(int n) { if (n <= 1) return 1; }", {}, "code", false],
  ["Read each object module and note its length.", { blockType: "item", section: "Algorithm for pass 1 of a two-pass linker" }, "step", false],
  ["Differentiate the function.", { blockType: "item", ordered: true, section: "Steps to find the maximum of a function" }, "step", false],
  ["Substituting u = x^2 and v = sin x we get the product.", {}, "formula", false],
  ["Substituting the values we get the total delay of the pipeline.", {}, "derivation", false],
  ["Complexity – implementation difficult due to memory management, relocation etc.", { blockType: "item", section: "Disadvantages of Loader" }, "fragment", false],
  ["Overhead – loading and relocation take extra time before the program can start.", { blockType: "item", section: "Disadvantages of Loader" }, "point", false],
  ["Fault tolerance: the distributed system continues to operate correctly when some of its nodes fail.", { blockType: "item", section: "Characteristics" }, "fact", true],
  ["Concurrency: several processes execute at the same time on different nodes.", { blockType: "item", section: "Characteristics" }, "fact", true],
  ["Basic It generates the executable module of a source program. It loads the executable module to the main memory.", {}, "table-row", false],
  ["Tail recursion is a form of recursion in which the recursive call is the last operation of the function.", {}, "definition", true],
  // a list entry that opens with a noun also used as a verb is a statement, not a step
  ["Load balancing distributes incoming requests across several servers.", { blockType: "item" }, "fact", true],
  ["Link state routing floods each router's link information to all routers.", { blockType: "item", section: "Types of routing" }, "fact", true],
  ["Update anomaly occurs when the same data is stored in several places.", { blockType: "item" }, "fact", true],
  ["Set LOCCTR to the starting address given in the START statement.", { blockType: "item" }, "step", false],
  ["Store values in registers before the call is made.", { blockType: "item" }, "step", false],
  ["Scan the symbol table for an undefined symbol before linking.", { blockType: "item" }, "step", false],
  // "therefore" alone opens a conclusion, not working
  ["Therefore deadlock cannot occur when any one of the four conditions is broken.", {}, "fact", true],
  ["C++ is an object oriented language derived from the C language.", {}, "fact", true],
  // naming an operator is prose; using one between operands is code
  ["The == operator compares two values for equality in C.", {}, "fact", true],
  ["The loop stops when count++ reaches the limit of the buffer.", {}, "code", false],
];
for (const [t, ctx, kind, mcq] of cases) {
  const got = kindOf(t, ctx);
  check(`${kind}${mcq ? " (MCQ)" : " (theory only)"}: "${t.slice(0, 55)}..."`, got.kind === kind && got.mcq === mcq && got.theory === true, `${got.kind} mcq=${got.mcq}`);
}

// ---------------------------------------------------------------------------
console.log("\n=== B. Flattened comparison tables ===");
const FLAT = "BASIS FOR COMPARISON LINKER LOADER Basic It generates the executable module of a source program. It loads the executable module to the main memory. Input It takes as input, the object code generated by an assembler. It takes executable module generated by a linker. Type/Approach Linkage Editor, Dynamic linker. Absolute loading, Relocatable loading and Dynamic Run-time loading.";
const parsed = parseFlattenedComparison(FLAT);
check("the header's two names are found", parsed?.names.join("|") === "Linker|Loader", JSON.stringify(parsed?.names));
check("each row is put back with its label and both cells", parsed?.rows.map((r) => r.label).join("|") === "Basic|Input|Type/Approach" && parsed.rows[0].cells[1] === "It loads the executable module to the main memory.", JSON.stringify(parsed?.rows?.[2]));
check("ordinary prose is not taken for a table", parseFlattenedComparison("A linker combines object modules. A loader loads them.") === null);
const spos = noteOf("Linker and Loader", fixture("spos_linker_loader.txt"));
const table = spos.content.find((b) => b.type === "table");
check("an uploaded note shows the flattened table as a table", table?.comparison === true && table.rows[0].join("|") === "Basis|Linker|Loader" && table.rows.length === 5, JSON.stringify(table?.rows?.[0]));
const old = withContent({ _id: "b".repeat(24), title: "Old", rawText: FLAT, content: [{ type: "para", text: FLAT }] });
check("a note saved before the fix is shown with the table too", old.content[0].type === "table");

// ---------------------------------------------------------------------------
console.log("\n=== C. Mixed chapters: each type from its own content ===");
const subjects = [
  ["SPOS (CS theory)", spos],
  ["Maths", noteOf("Differentiation", fixture("maths_differentiation.md"), 2)],
  ["Programming", noteOf("Recursion", fixture("programming_recursion.md"), 3)],
  ["Electrical", noteOf("DC Circuits", fixture("ee_circuits.md"), 4)],
];
for (const [label, note] of subjects) {
  const r = await generateQuestions([note], { mcqCount: 10, theoryCount: 6, marksPerQuestion: 1 });
  const mcqs = r.accepted.filter((q) => q.type === "mcq");
  const theory = r.accepted.filter((q) => q.type === "theory");
  const bad = mcqs.filter((q) => !classifyText(q.supportingExcerpt).mcq || /=|`|\bIt (?:generates|loads|takes)\b/.test(q.supportingExcerpt));
  check(`${label}: every MCQ comes from a definition or a fact`, mcqs.length >= 1 && bad.length === 0, bad.map((q) => q.supportingExcerpt.slice(0, 60)).join(" | ") || `${mcqs.length} MCQs`);
  check(`${label}: fewer MCQs than asked rather than forced ones`, mcqs.length < 10, `${mcqs.length} of 10`);
  check(`${label}: no MCQ blanks a word out of a formula, code, a step or a table`, !mcqs.some((q) => /[=×÷^]|\$|`|\bReturn\b/.test(q.prompt)));
  const forms = new Set(theory.map((q) => q.form));
  const wanted = { "SPOS (CS theory)": ["compare", "steps", "formula"], Maths: ["steps", "formula"], Programming: ["compare", "steps"], Electrical: ["formula"] }[label];
  check(`${label}: the theory section covers what MCQs cannot (${wanted.join(", ")})`, wanted.every((f) => forms.has(f)), [...forms].join(", "));
  check(`${label}: every question passes the quality gate`, r.accepted.every((q) => validateQuestion(q, { type: q.type, contextText: note.rawText }).ok));
}
const flatNote = noteOf("Linker vs Loader", `Linker vs Loader\n\n${FLAT}\n\nA linker is a system program that combines object modules into one executable program.`, 9);
const fr = await generateQuestions([flatNote], { mcqCount: 5, theoryCount: 2, marksPerQuestion: 1 });
check("the SPOS screenshot: no MCQ from a table row ('_____ FOR COMPARISON LINKER LOADER ...')", !fr.accepted.some((q) => q.type === "mcq" && /COMPARISON|It (?:generates|loads|takes)/.test(`${q.prompt} ${q.supportingExcerpt}`)), fr.accepted.map((q) => q.prompt.slice(0, 60)).join(" | "));
check("  ...it is asked as 'Differentiate between Linker and Loader' instead", fr.accepted.some((q) => q.form === "compare" && /Linker.*Loader/.test(q.prompt)));
const listNote = noteOf("Loaders", "Disadvantages of Loader\n\n• Complexity – implementation difficult due to memory management, relocation etc.\n• Overhead – loading and relocation take extra time before the program can start.\n• Memory usage – the loader itself occupies main memory.\n\nA loader is a system program that places the executable program into main memory and prepares it for execution.", 10);
const lr = await generateQuestions([listNote], { mcqCount: 5, theoryCount: 2, marksPerQuestion: 1 });
check("the second screenshot: no MCQ blanks a list point's label ('_____ – implementation difficult ...')", !lr.accepted.some((q) => q.type === "mcq" && /–|implementation difficult|Overhead|Memory usage/.test(`${q.prompt} ${q.supportingExcerpt}`)), lr.accepted.map((q) => q.prompt.slice(0, 60)).join(" | "));
check("  ...the list is asked as a whole ('List ... the disadvantages of loader')", lr.accepted.some((q) => q.form === "list" && /disadvantages of loader/i.test(q.prompt)), lr.accepted.map((q) => q.prompt).join(" | "));
check("a note with only formulas and steps gives no MCQ at all, rather than forced ones", (await generateQuestions([noteOf("Formulas", "The power is P = V × I.\n\nSteps to measure power:\n1. Connect the meter.\n2. Read the voltage.\n3. Read the current.", 11)], { mcqCount: 4, theoryCount: 0, marksPerQuestion: 1 })).accepted.length === 0);

// ---------------------------------------------------------------------------
console.log("\n=== D. With an AI: the same rules ===");
const tableRow = "It generates the executable module of a source program.";
const formula = "The effective address is computed as EA = base + displacement, where the base register holds the start address.";
const loaderDef = "A loader is a system program that places the executable program into main memory and prepares it for execution.";
const AI_MCQ = [
  { prompt: "Which of the following places the executable program into main memory and prepares it for execution?", options: ["loader", "linker", "assembler", "compiler"], correctAnswer: "loader", supportingExcerpt: loaderDef, difficulty: "easy", concept: "loader" },
  { prompt: "Which of the following generates the executable module of a source program?", options: ["linker", "loader", "assembler", "editor"], correctAnswer: "linker", supportingExcerpt: tableRow, difficulty: "medium", concept: "linker" },
  { prompt: "Which of the following gives the effective address when the base register holds the start address?", options: ["$base + displacement$", "$base - displacement$", "$base \\times displacement$", "$displacement / base$"], correctAnswer: "$base + displacement$", supportingExcerpt: formula, difficulty: "hard", concept: "effective address" },
  { prompt: "Which of the following is the first step of pass 1 of a two-pass linker?", options: ["Read each object module and note its length", "Assign a starting address to each module", "Build the global symbol table", "Relocate the code"], correctAnswer: "Read each object module and note its length", supportingExcerpt: "Read each object module and note its length.", difficulty: "medium", concept: "pass 1" },
];
let mode = "mcq";
const bodies = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    bodies.push(body);
    const theory = /theory \(short-answer\)/.test(body);
    let content;
    if (mode === "latex") content = String.raw`[{"prompt":"Which expression gives the effective address when the base register holds the start address?","options":["$\text{base} + \text{displacement}$","$\text{base} - \text{displacement}$","$\frac{\text{base}}{2}$","$\theta$"],"correctAnswer":"$\text{base} + \text{displacement}$","supportingExcerpt":"A loader is a system program","difficulty":"easy"}]`;
    else if (mode === "broken") content = '[{"prompt": "Which of the following ...", "options": ["a", "b"';
    else content = JSON.stringify(theory ? [] : AI_MCQ);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => fake.listen(4597, r));
process.env.GROQ_API_KEY = "test-key";
process.env.LLM_API_URL = "http://localhost:4597/v1/chat/completions";
process.env.LLM_TIMEOUT_MS = "3000";
try {
  const r = await generateQuestions([spos], { mcqCount: 4, theoryCount: 2, marksPerQuestion: 1 });
  const ai = r.accepted.filter((q) => q.generatedBy === "llm");
  const why = Object.fromEntries(r.discarded.filter((q) => q.generatedBy === "llm").map((q) => [q.prompt.slice(25, 60), q.discardReason]));
  check("the AI's MCQ from a definition is used", ai.some((q) => q.prompt.startsWith("Which of the following places the executable")), ai.map((q) => q.prompt.slice(0, 50)).join(" | "));
  check("  ...its MCQs from a table row, a formula and an algorithm's step are all rejected", !ai.some((q) => /generates the executable|effective address|first step of pass 1/.test(q.prompt)) && Object.keys(why).length === 3, JSON.stringify(why));
  check("  ...the formula and the step by the suitability rule", Object.values(why).filter((w) => /suitability:(formula|step)/.test(w)).length === 2, JSON.stringify(why));
  check("  ...and a table row is caught by it too, on its own", mcqSourceProblem(tableRow, { yes: [], no: [{ text: "basic it generates the executable module of a source program. it loads the executable module to the main memory.", kind: "table-row" }] }) === "table-row");
  const mcqAsk = bodies.find((b) => /multiple-choice questions/.test(b)) || "";
  const theoryAsk = bodies.find((b) => /theory \(short-answer\)/.test(b)) || "";
  check("for MCQs the AI is only sent MCQ material (no formula, step or table)", mcqAsk.includes("A loader is a system program") && !mcqAsk.includes("EA = base") && !mcqAsk.includes("Read each object module") && !mcqAsk.includes("It loads the executable module"));
  check("  ...while for theory it gets everything, the table as rows", theoryAsk.includes("EA = base") && theoryAsk.includes("Read each object module") && theoryAsk.includes("| Basic |"));
  check("both prompts ask for formulas in LaTeX and code in backticks", /LaTeX between single dollar signs/.test(mcqAsk) && /LaTeX between single dollar signs/.test(theoryAsk));

  mode = "latex";
  const lx = await generateQuestions([spos], { mcqCount: 2, theoryCount: 0, marksPerQuestion: 1 });
  const lq = [...lx.accepted, ...lx.discarded].find((q) => q.generatedBy === "llm");
  check("an AI reply with LaTeX in JSON (\\frac, \\theta, \\text) is read, not lost", Boolean(lq) && lq.options.includes("$\\frac{\\text{base}}{2}$") && lq.options.includes("$\\theta$"), JSON.stringify(lq?.options));
  // eslint-disable-next-line no-control-regex
  check("  ...without control characters (\\f read as a form feed)", !/[\u0000-\u001f]/.test((lq?.options || []).join("")));
  mode = "broken";
  const br = await generateQuestions([spos], { mcqCount: 2, theoryCount: 0, marksPerQuestion: 1 });
  check("a broken AI reply falls back to the rules, and says why", br.generation.mcq.status === "rule-based-fallback" && br.generation.mcq.fallbackReason === "invalid-response" && br.accepted.length > 0);
  check("  ...and the rules follow the same suitability rules", br.accepted.every((q) => !mcqSourceProblem(q.supportingExcerpt)));
} finally {
  fake.close();
  delete process.env.GROQ_API_KEY;
  delete process.env.LLM_API_URL;
  delete process.env.LLM_TIMEOUT_MS;
}
check("JSON escapes that are real are kept (\\n between words, \\\", \\\\, \\u00e9)", JSON.stringify(parseJsonLoose(String.raw`{"a":"x\ny \"q\" \\ é"}`)) === JSON.stringify({ a: 'x\ny "q" \\ é' }));
check("  ...and an already-doubled \\\\frac stays as it is", escapeLatexBackslashes(String.raw`"\\frac"`) === String.raw`"\\frac"`);

// ---------------------------------------------------------------------------
console.log("\n=== E. Formatting ===");
check("control characters, <br> and entities are repaired", repairFormatting("a\u000Cb<br>c &amp; d") === "ab\nc & d");
check("an unclosed formula is rejected", formattingProblems("Compute $x^2 + y").includes("format:unclosed-formula"));
check("  ...but prices are not formulas", formattingProblems("It costs $5 and $10.").length === 0);
check("unclosed code is rejected", formattingProblems("Use `MOV A, B to copy").includes("format:unclosed-code"));
check("escapes printed as text are rejected", formattingProblems("Explain \\u00e9 here").includes("format:escapes-as-text"));
check("markdown bullets in a question are rejected", formattingProblems("**Explain** the stack.\n- push\n- pop").includes("format:markdown"));
const fq = validateQuestion(
  { prompt: "Which expression gives the effective address when $B$ is the base and $D$ the displacement?", options: ["$B + D$", "$B - D$", "$B \\times D$", "$D / B$"], answerKey: "$B + D$", supportingExcerpt: "The effective address is EA = B + D." },
  { type: "mcq" }
);
check("formula options that differ only in symbols are not duplicates", !fq.reasons.includes("mcq:duplicate-options"), fq.reasons.join(","));
const tq = validateQuestion({ prompt: "Explain what this code computes:\n```c\nint f(int n) {\n  return n * 2;\n}\n```", answerKey: "It returns twice the number that is passed to it.", keyPoints: ["twice"], supportingExcerpt: "x" }, { type: "theory" });
check("a question's line breaks are kept (code stays on its lines)", tq.question.prompt.includes("{\n") && tq.question.prompt.includes("\n}"));

const blocks = parseRichText("Find $x^2$ when `n = 3`:\n**Note** the case\n```c\nint a = 1;\nint b = 2;\n```\nThen stop.");
check("rich text: code blocks keep their lines", blocks.some((b) => b.type === "code" && b.text === "int a = 1;\nint b = 2;"));
check("  ...lines stay separate", blocks[0].type === "lines" && blocks[0].lines.length === 2);
check("  ...inline code and bold are found", JSON.stringify(blocks[0].lines[0]).includes('"type":"code","text":"n = 3"') && blocks[0].lines[1][0].type === "bold");
check("  ...a formula is kept whole, even with ** or ` inside", parseInline("Use $a**b$ and $`x`$ here").length === 1);
check("  ...and nothing becomes HTML (text stays text)", parseInline("<img src=x onerror=alert(1)>")[0].text === "<img src=x onerror=alert(1)>");

console.log("\n=== F. Picture checks in the browser ===");
check("a picture is shrunk to at most 1600 px on its longest side", JSON.stringify(fitWithin(4000, 3000)) === JSON.stringify({ width: 1600, height: 1200 }) && JSON.stringify(fitWithin(800, 600)) === JSON.stringify({ width: 800, height: 600 }));
check("a fourth picture is refused with how to add it", /at most 3 pictures/.test(imageProblem({ name: "a.jpg", type: "image/jpeg", size: 10 }, { count: 3 })));
check("a PDF or a GIF is refused, a JPG / PNG / WebP / HEIC accepted", /not a picture/.test(imageProblem({ name: "a.pdf", type: "application/pdf", size: 10 })) && /gif/.test(imageProblem({ name: "a.gif", type: "image/gif", size: 10 })) && ["a.jpg|image/jpeg", "a.png|image/png", "a.webp|image/webp", "a.heic|image/heic"].every((x) => imageProblem({ name: x.split("|")[0], type: x.split("|")[1], size: 10 }) === ""));
check("an empty file is refused", /empty/.test(imageProblem({ name: "a.jpg", type: "image/jpeg", size: 0 })));

// ---------------------------------------------------------------------------
console.log("\n=== G. A question reported as broken is not generated again ===");
{
  const note = noteOf("Linker and Loader", fixture("spos_linker_loader.txt"), 7);
  const first = await generateQuestions([note], { mcqCount: 5, theoryCount: 2, marksPerQuestion: 1 });
  const bad = first.accepted.find((q) => q.type === "mcq");
  const badTheory = first.accepted.find((q) => q.type === "theory");
  const blocked = [bad, badTheory].filter(Boolean).map((q) => ({ prompt: q.prompt, excerpt: q.supportingExcerpt, answer: q.type === "mcq" ? q.answerKey : null }));
  const again = await generateQuestions([note], { mcqCount: 5, theoryCount: 2, marksPerQuestion: 1 });
  const next = await generateQuestions([note], { mcqCount: 5, theoryCount: 2, marksPerQuestion: 1, blocked });
  check("without a report, the same notes give the reported questions again", Boolean(bad && badTheory) && again.accepted.some((q) => q.prompt === bad.prompt));
  check("with the report, neither comes back", !next.accepted.some((q) => [bad?.prompt, badTheory?.prompt].includes(q.prompt)));
  check("  ...they are stored as discarded, reason \"reported\"", next.discarded.filter((q) => q.discardReason === "reported").length >= 2);
  const mcqs = (r) => r.accepted.filter((q) => q.type === "mcq").length;
  check("  ...and nothing else is lost (a short note simply has one MCQ fewer)", mcqs(next) >= mcqs(again) - 1, `${mcqs(again)} -> ${mcqs(next)}`);
  check("isReported: a reworded copy of a reported question is caught", isReported({ prompt: `${bad.prompt.replace(/\?$/, "")} ?`, supportingExcerpt: "x" }, blocked));
  check("isReported: an unrelated question is not", !isReported({ prompt: "Which program combines object modules into one executable program?", supportingExcerpt: "y" }, [{ prompt: "Define the term “loader”.", excerpt: "z", answer: null }]));
}

restore();
console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
