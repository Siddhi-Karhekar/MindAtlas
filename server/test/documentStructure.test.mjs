// Checks for the long-document splitter (services/documentStructure.js):
// when a document is split into subtopics, where, and when it is left whole.
// Runs with no server and no files: `node test/documentStructure.test.mjs`.
import { blocksFromPlainText, segmentDocument, MAX_SECTIONS } from "../src/services/documentStructure.js";
import { buildPdfBlocks } from "../src/services/documentText.js";
import { isQuestionWorthy } from "../src/services/testEngine.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const para = (topic, n = 70) =>
  Array.from({ length: n }, (_, i) => `${topic}${i % 7 === 0 ? "." : ""}`).join(" ").replace(/\.$/, "") + ".";

console.log("\n=== Markdown headings ===");
const md = `# Unit 3\n\n## Memory\n\n### Paging\n\n${para("frames pages offset")}\n\n### Segmentation\n\n${para("segment base limit")}\n\n## Deadlocks\n\n### Avoidance\n\n${para("banker safe state")}\n\n## References\n\nSome book.`;
const s1 = segmentDocument(blocksFromPlainText(md));
check("document title is taken from the lone top heading", s1.docTitle === "Unit 3", s1.docTitle);
check("splits at the finest level with enough text", s1.sections.map((s) => s.title).join("|") === "Paging|Segmentation|Avoidance", s1.sections.map((s) => s.title).join("|"));
check("subtopics remember their chapter", s1.sections[0].group === "Memory" && s1.sections[2].group === "Deadlocks");
check("references section is not a topic", !s1.sections.some((s) => /references/i.test(s.title)));

console.log("\n=== Short documents stay whole ===");
const short = segmentDocument(blocksFromPlainText("# Osmosis\n\nWater moves across a membrane.\n\n## Detail\n\nToward higher solute concentration."));
check("a short note is not split", short.sections.length === 0 && short.method === "none");

console.log("\n=== Slide continuations collapse ===");
const slides = [
  { type: "heading", level: 1, text: "OS Lecture" },
  { type: "heading", level: 2, text: "Agenda" }, { type: "para", text: "Paging Deadlocks" },
  { type: "heading", level: 2, text: "Paging" }, { type: "para", text: para("frames pages", 40) },
  { type: "heading", level: 2, text: "Paging (cont.)" }, { type: "para", text: para("tlb lookup", 40) },
  { type: "heading", level: 2, text: "Deadlocks" }, { type: "para", text: para("hold wait circular", 60) },
  { type: "heading", level: 2, text: "Questions?" }, { type: "para", text: "Thank you" },
];
const s2 = segmentDocument(slides);
check("'(cont.)' slides merge into one subtopic", s2.sections.map((s) => s.title).join("|") === "Paging|Deadlocks", s2.sections.map((s) => s.title).join("|"));

console.log("\n=== No headings: even parts ===");
const plain = Array.from({ length: 12 }, (_, i) => para(i < 6 ? "process thread scheduler" : "memory page frame", 90)).join("\n\n");
const s3 = segmentDocument(blocksFromPlainText(plain));
check("long unstructured text is chunked into parts", s3.method === "chunks" && s3.sections.length >= 2, `${s3.method} ${s3.sections.length}`);
check("parts are named after their keywords", /^Part 1 — /.test(s3.sections[0].title), s3.sections[0].title);

console.log("\n=== Section cap ===");
const many = Array.from({ length: 50 }, (_, i) => [{ type: "heading", level: 2, text: `Topic ${i} alpha${i}` }, { type: "para", text: para(`word${i} term${i}`, 30 + i) }]).flat();
const s4 = segmentDocument(many);
check(`never more than ${MAX_SECTIONS} subtopics`, s4.sections.length > 0 && s4.sections.length <= MAX_SECTIONS, String(s4.sections.length));

console.log("\n=== PDF typography ===");
const line = (text, y, size) => ({ text, y, size });
const pages = [0, 1, 2].map((p) => [
  line("CS301 Lecture Notes", 800, 8),
  ...(p === 0 ? [line("Operating Systems", 760, 22)] : []),
  line(p === 1 ? "Paging" : p === 2 ? "Segmentation" : "Scheduling", 720, 16),
  ...Array.from({ length: 8 }, (_, i) => line(para(["cpu burst quantum", "frames pages offset", "segment base limit"][p], 10), 700 - i * 14, 10.5)),
  line(String(p + 1), 30, 8),
]);
const pdf = buildPdfBlocks(pages);
check("running header and page numbers are dropped", !pdf.text.includes("CS301") && !/\n\n[123]\n\n/.test(pdf.text));
const s5 = segmentDocument(pdf.blocks);
check("font-size headings become subtopics", s5.sections.map((s) => s.title).join("|") === "Scheduling|Paging|Segmentation", s5.sections.map((s) => s.title).join("|"));
check("the big first-page line is the document title", s5.docTitle === "Operating Systems", s5.docTitle);

console.log("\n=== Only subject matter becomes a question ===");
for (const junk of [
  "CS302 Computer Networks - Department of Computer Engineering Page 1 Computer Networks - Unit 2 Lecture notes: layers, protocols and addressing Semester V Contents 1.",
  "Computer Networks - Unit 2\n\nLecture notes: layers, protocols and addressing\n\nContents\n\n1.",
  "3. Data Link Layer ........................................ 9",
  "Introduction to Computer Networks 1.1 Network Topologies A network topology describes the arrangement of nodes.",
  "Tanenbaum, A. S. and Wetherall, D. Computer Networks.",
]) check(`rejected: ${JSON.stringify(junk).slice(0, 50)}...`, !isQuestionWorthy(junk));
for (const junk of [
  "Foundations of Information Security: Information security fundamentals and it’s need, security attacks, security services, security mechanisms, Model for network security.",
  "Write a program using JAVA or Python or C++ to implement classical cryptographic algorithm 2.",
  "Convert the plaintext MEET ME to ciphertext using the Caesar cipher.",
  "What is the key space of the Caesar cipher?",
  "and application layers into one, so protocols such as HTTP and DNS handle their own formatting.",
]) check(`rejected (not a statement): ${JSON.stringify(junk).slice(0, 44)}...`, !isQuestionWorthy(junk));
check("accepted: a real sentence", isQuestionWorthy("From the bottom up, the physical layer transmits raw bits over the medium."));
check("accepted: a definition", isQuestionWorthy("A block cipher encrypts a fixed-size block of plaintext into a block of ciphertext of the same size."));

console.log(failures ? `\n${failures} FAILING CHECK(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
