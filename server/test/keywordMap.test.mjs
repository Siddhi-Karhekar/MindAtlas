// Tests for a note's keyword map (services/keywordMap.js), on a note built
// through the real TF-IDF step exactly as routes/notes.js stores it.
import { computeTfidf, tokenize } from "../src/services/tfidf.js";
import { buildKeywordMap, splitSentences } from "../src/services/keywordMap.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};

const rawText =
  "The cell is the basic unit of life. The cell membrane controls what enters and leaves the cell. " +
  "The nucleus holds DNA, and mitochondria release energy through respiration. Plant cells also have a cell wall and chloroplasts.\n" +
  "Osmosis moves water across the membrane of every cell.";
const { vector, keywords } = computeTfidf(rawText, []);
const note = { rawText, vector, keywords };
const map = buildKeywordMap(note);
const entry = (k) => map.find((e) => e.keyword === k);

console.log("\n=== Sentences ===");
check("splits on sentence ends and line breaks", splitSentences("One. Two!\nThree? Four").length === 4);
check("empty text has no sentences", splitSentences("").length === 0 && splitSentences(undefined).length === 0);

console.log("\n=== Keywords ===");
check("one entry per keyword, in the note's own order", JSON.stringify(map.map((e) => e.keyword)) === JSON.stringify(keywords),
  map.map((e) => e.keyword).join(", "));
check("the strongest keyword has weight 1", map[0].weight === 1, `${map[0].keyword}: ${map[0].weight}`);
check("weights stay within 0..1 and never rise down the list",
  map.every((e, i) => e.weight >= 0 && e.weight <= 1 && (i === 0 || e.weight <= map[i - 1].weight)));

console.log("\n=== Sentences per keyword ===");
const cell = entry("cell");
check("'cell' is on the map", Boolean(cell));
check("its sentences all use the word", cell.sentences.length > 0 && cell.sentences.every((s) => /\bcell\b/i.test(s)), `${cell.sentences.length} sentence(s)`);
check("at most three sentences", map.every((e) => e.sentences.length <= 3));
const cellSentences = splitSentences(rawText).filter((s) => tokenize(s).includes("cell"));
check("sentenceCount counts every sentence that uses it, not just the ones shown",
  cell.sentenceCount === cellSentences.length && cell.sentenceCount > cell.sentences.length,
  `${cell.sentences.length} shown of ${cell.sentenceCount}`);

console.log("\n=== Related words ===");
check("at most five per keyword", map.every((e) => e.subKeywords.length <= 5));
check("never another of the note's top keywords", map.every((e) => e.subKeywords.every((s) => !keywords.includes(s))));
check("never the keyword's own plural ('cells' is not related to 'cell')", !cell.subKeywords.includes("cells"), cell.subKeywords.join(", "));
const sentenceWords = new Set(cellSentences.flatMap((s) => tokenize(s)));
check("drawn from the sentences that use the keyword", cell.subKeywords.every((s) => sentenceWords.has(s)), cell.subKeywords.join(", "));
check("same note, same map", JSON.stringify(buildKeywordMap(note)) === JSON.stringify(map));

console.log("\n=== Edge cases ===");
const long = `${"Word ".repeat(80)}and here the enzyme finally appears ${"filler ".repeat(40)}end.`;
const longMap = buildKeywordMap({ rawText: long, keywords: ["enzyme"], vector: { enzyme: 0.5 } });
check("a very long sentence is trimmed around the keyword", longMap[0].sentences[0].length <= 242 && /enzyme/.test(longMap[0].sentences[0]),
  `${longMap[0].sentences[0].length} chars`);
const noVector = buildKeywordMap({ rawText: "Alpha beta. Beta gamma.", keywords: ["beta", "gamma"] });
check("a note stored without weights falls back to keyword order", noVector[0].weight === 1 && noVector[1].weight < 1,
  noVector.map((e) => e.weight).join(", "));
check("a note with no text or keywords gives an empty map", buildKeywordMap({}).length === 0);
const missing = buildKeywordMap({ rawText: "Nothing relevant here.", keywords: ["enzyme"], vector: { enzyme: 1 } });
check("a keyword not found in any sentence has no sentences or related words",
  missing[0].sentences.length === 0 && missing[0].subKeywords.length === 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
