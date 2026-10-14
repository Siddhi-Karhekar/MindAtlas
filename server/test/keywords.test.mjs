// Tests for a note's keywords (services/tfidf.js): TextRank weighted by IDF,
// with singular and plural as one keyword, and the vector left as it was.
// Also that the question evaluation's baseline still gets the TF-IDF keywords
// it was measured with (evaluation/baseline/keywords.tfidf.js).
import { computeTfidf, rankKeywords, sameWord, tokenize, tokenSet } from "../src/services/tfidf.js";
import { tfidfKeywords } from "../evaluation/baseline/keywords.tfidf.js";
import { withBaselineKeywords } from "../evaluation/generate.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
  if (!cond) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tfidfTop = (vector) => Object.entries(vector).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);

const CELL = "The cell is the basic unit of life. The cell membrane controls what enters and leaves the cell. The nucleus holds DNA, and mitochondria release energy through respiration. Plant cells also have a cell wall and chloroplasts.";
const WAREHOUSE = "Data warehouse stores data. A data warehouse integrates data from many sources. The warehouse schema is a star schema with fact tables.";
const DEDV = ["Data cleaning fixes dirty data.", "Data mining finds patterns in data.", "Data visualisation shows data."];

console.log("\n=== Singular and plural ===");
check("cell / cells, class / classes, query / queries, bus / buses are one word",
  sameWord("cell", "cells") && sameWord("classes", "class") && sameWord("query", "queries") && sameWord("buses", "bus"));
check("...and nothing else is: not distributed / distribution, relational / relative, general / generation",
  !sameWord("distributed", "distribution") && !sameWord("relational", "relative") && !sameWord("general", "generation") && !sameWord("process", "processing"));

console.log("\n=== TextRank weighted by IDF ===");
const result = computeTfidf(WAREHOUSE, DEDV);
check("computeTfidf still returns exactly { vector, keywords } (callers save the whole result on the note)",
  same(Object.keys(result).sort(), ["keywords", "vector"]));
check("the vector is TF-IDF as before: its top 12 are the keywords the baseline gets",
  same(tfidfTop(result.vector), tfidfKeywords(WAREHOUSE, DEDV)) && same(tfidfTop(computeTfidf(CELL).vector), tfidfKeywords(CELL)));
check("a word joined to many others outranks the rest",
  computeTfidf("Router forwards packets. Router stores tables. Router runs protocols. Switch learns addresses.").keywords[0] === "router");
check("with no other notes, a word the note repeats wins", computeTfidf(WAREHOUSE).keywords[0] === "data", computeTfidf(WAREHOUSE).keywords.join(", "));
check("  ...but one every note in the subject uses is pushed down by its IDF",
  result.keywords[0] === "warehouse" && result.keywords.indexOf("data") > 2, result.keywords.join(", "));
const plural = computeTfidf("Cells divide. The cells grow. A cell membrane surrounds each cell nucleus. Cells need energy.").keywords;
check("a word's singular and plural take one slot", plural.filter((k) => sameWord(k, "cell")).length === 1, plural.join(", "));
check("  ...shown as the note writes it most often", plural[0] === "cells", plural.join(", "));
check("  ...or, on a tie, the shorter form", computeTfidf("The cell grows. Two cells divide.").keywords.includes("cell"));
check("numbers are never keywords", !computeTfidf("Port 1024 and port 80 carry 1024 requests over TCP.").keywords.some((k) => /^\d+$/.test(k)));
check("every keyword is a word of the note, as written",
  [CELL, WAREHOUSE].every((t) => computeTfidf(t, DEDV).keywords.every((k) => tokenize(t).includes(k))));
check("at most 12 keywords", computeTfidf(`${CELL} ${WAREHOUSE} ${DEDV.join(" ")}`).keywords.length === 12);
check("the order of the other notes makes no difference", same(result.keywords, computeTfidf(WAREHOUSE, [...DEDV].reverse()).keywords));
check("token sets and raw text give the same keywords", same(result.keywords, computeTfidf(WAREHOUSE, DEDV.map(tokenSet)).keywords));
check("the window can be tried wider (for the link evaluation), and changes the ranking",
  !same(rankKeywords(CELL, [], { window: 2 }), rankKeywords(CELL, [], { window: 4 })));
check("no text, no keywords", computeTfidf("").keywords.length === 0 && computeTfidf("12 345 6789").keywords.length === 0);

console.log("\n=== The question evaluation's baseline keeps its keywords ===");
// what computeTfidf returned for CELL before TextRank (main, f9472e8)
check("the frozen TF-IDF keywords are what they were",
  same(tfidfKeywords(CELL), ["cell", "basic", "unit", "life", "membrane", "controls", "enters", "leaves", "nucleus", "holds", "dna", "mitochondria"]),
  tfidfKeywords(CELL).join(", "));
const doc = [
  { _id: "d-1", rawText: WAREHOUSE, keywords: computeTfidf(WAREHOUSE, DEDV).keywords },
  ...DEDV.map((t, i) => ({ _id: `d-${i + 2}`, rawText: t, keywords: [] })),
];
const baselineNotes = withBaselineKeywords(doc);
check("the baseline strategy gets them, each topic against the file's other topics",
  same(baselineNotes[0].keywords, tfidfKeywords(WAREHOUSE, DEDV)) && same(baselineNotes[1].keywords, tfidfKeywords(DEDV[0], [WAREHOUSE, DEDV[1], DEDV[2]])));
check("  ...without changing the notes the other strategies use", same(doc[0].keywords, computeTfidf(WAREHOUSE, DEDV).keywords) && baselineNotes[0] !== doc[0]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
