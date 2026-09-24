// Unit tests for notes ingestion: splitting a long document into one note per
// section, chunking a reference textbook into labelled passages, and linking
// notes to those passages. Inputs are small synthetic documents shaped like
// the real ones (numbered capital headings, running page headers), so the
// tests need no sample files and no network.
import { splitIntoSections, tidyHeading } from "../src/services/sectionSplitter.js";
import { chunkPages, chunkPlainText, indexChunks, findReferences, chunkLabel } from "../src/services/textbook.js";
import { classifyUpload, extractTextFromDocument } from "../src/services/documentText.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const lines = (...texts) => texts.map((text) => ({ text, y: null }));
const para = (word, n = 30) => Array.from({ length: n }, (_, i) => `${word} sentence ${i} about ${word}.`).join(" ");

console.log("\n=== Section splitting ===");
const unit = splitIntoSections(
  lines(
    "UNIT I — INTRODUCTION TO SYSTEM SOFTWARE",
    "1. SOFTWARE — OVERVIEW",
    para("software"),
    "2. COMPONENTS OF SYSTEM SOFTWARE",
    "3a. Assembler",
    para("assembler"),
    "1. Convert symbolic op codes to binary", // a list item, not a heading
    "PART B — LOADERS",
    "3. DESIGN OF 2-PASS ASSEMBLER (ALP)",
    para("pass")
  )
);
check("splits on numbered capital headings", unit?.length === 3, `${unit?.length} sections`);
check("titles are tidied", unit?.[0].title === "Software — Overview", unit?.[0].title);
check("sub-headings stay inside their section", unit?.[1].text.includes("3a. Assembler"));
check("numbered list items are not headings", unit?.[1].text.includes("1. Convert symbolic op codes"));
check("PART / UNIT lines are dropped", !unit?.some((s) => /PART B|UNIT I/.test(s.text)));
check("a title-only preamble is not a note", !unit?.some((s) => s.title === "Introduction"));

const tiny = splitIntoSections(lines("1. FIRST", para("first"), "2. SECOND", "short", "3. THIRD", para("third")));
check("a tiny section is folded into the previous one", tiny?.length === 2 && tiny[0].text.includes("Second"), `${tiny?.length} sections`);

check("no headings -> null (kept as one note)", splitIntoSections(lines(para("plain"), para("more"))) === null);
const md = splitIntoSections(lines("# Stacks", para("stack"), "## Queues", para("queue")));
check("markdown headings split too", md?.length === 2 && md[1].title === "Queues");
check("tidyHeading keeps bracketed acronyms", tidyHeading("DYNAMIC LINK LIBRARIES (DLL)") === "Dynamic Link Libraries (DLL)");
check("tidyHeading lower-cases small words", tidyHeading("MACRO VS FUNCTION") === "Macro vs Function");
check("tidyHeading leaves mixed-case titles alone", tidyHeading("Pass 1 of Macro Processor") === "Pass 1 of Macro Processor");

console.log("\n=== Textbook chunking ===");
// A tiny "book": contents page, chapter 1 opening + running headers, chapter 2.
const page = (pageNumber, ...texts) => ({ pageNumber, lines: texts.map((text, i) => ({ text, y: 800 - i * 14 })) });
const contents = Array.from({ length: 10 }, (_, i) => `1.${i} Some Section ${i + 5}`);
const book = [
  page(1, "Contents", ...contents),
  page(2, "CHAPTER 1", "Assemblers", "3.1 Elements of Assembly Language", para("assembler symtab")),
  page(3, "2 Systems Programming", para("assembler littab")),
  page(4, "Assemblers 3", para("assembler pass")),
  page(5, "CHAPTER 2", "Linkers and", "Loaders", para("linker relocation")),
  page(6, "5 Systems Programming", para("loader relocation")),
];
const { chunks, skippedPages } = chunkPages(book);
check("contents pages are skipped", skippedPages === 1, `skipped ${skippedPages}`);
check("chapter titles come from chapter openings", chunks[0].chapter === "Assemblers", chunks[0].chapter);
check("two-line chapter titles are joined", chunks.some((c) => c.chapter === "Linkers and Loaders"));
check("passages never cross a chapter", chunks.every((c) => c.text.includes("assembler") !== c.text.includes("linker")));
check("running headers are stripped from text", !chunks.some((c) => c.text.includes("Systems Programming")));
check("printed page numbers are inferred", chunks[0].printedPages?.[0] === 1, JSON.stringify(chunks[0].printedPages));
check("section headings are captured", chunks[0].sections[0] === "3.1 Elements of Assembly Language");
check("labels read chapter + pages", chunkLabel(chunks[0]).startsWith("Assemblers · pp. 1"), chunkLabel(chunks[0]));
check("plain-text books split into parts", chunkPlainText(`${para("a", 60)}\n\n${para("b", 60)}\n\n${para("c", 60)}`).length >= 2);

console.log("\n=== Linking notes to passages ===");
const indexed = indexChunks(chunks);
const library = [
  {
    textbook: { _id: "book1", title: "Systems Programming", df: indexed.df, numDocs: indexed.numDocs },
    chunks: indexed.chunks.map((c, i) => ({ ...c, _id: `c${i}` })),
  },
];
const refs = findReferences("Relocation: the linker and loader adjust addresses.", library);
check("a note links to the matching chapter", refs[0]?.label.startsWith("Linkers and Loaders"), refs[0]?.label);
check("at most three references", refs.length <= 3);
check("unrelated text links to nothing", findReferences("photosynthesis chlorophyll leaves", library).length === 0);
const withConstructor = findReferences("A constructor sets up the assembler symtab.", library);
check("words like 'constructor' don't break scoring", withConstructor.every((r) => Number.isFinite(r.score)));

console.log("\n=== File handling ===");
check("classifies a PDF", classifyUpload({ originalname: "Unit 1.pdf", mimetype: "application/pdf" }) === "pdf");
check("classifies a photo", classifyUpload({ originalname: "page.jpg", mimetype: "image/jpeg" }) === "image");
check("rejects a .pptx", classifyUpload({ originalname: "slides.pptx", mimetype: "" }) === null);
let pdfError = "";
try {
  await extractTextFromDocument({ buffer: Buffer.from("not a pdf"), originalname: "x.pdf" }, "pdf");
} catch (err) {
  pdfError = err.message;
}
check("a damaged PDF gives a readable error", /could not read this PDF/.test(pdfError), pdfError);

console.log(`\n${failures === 0 ? "All checks passed." : failures + " FAILING CHECK(S)"}`);
process.exit(failures === 0 ? 0 : 1);
