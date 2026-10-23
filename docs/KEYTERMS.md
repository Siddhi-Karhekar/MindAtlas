# Key terms: how they are found, and how to check them

Key terms decide what MindAtlas highlights in a note, what its concept records are built around, and so what tests ask about. Written 23 October 2026 for branch `quiz/keyterms` (on top of `quiz/concept-records`).

**What changed in this round:**
- a part-of-speech tagger;
- AI-suggested terms at upload;
- terms the student adds or removes;
- a syllabus per subject;
- a labelled evaluation set with a script that scores all of the above.

## 1. Where key terms come from now

| Source | What it adds | File | Without it |
| --- | --- | --- | --- |
| The note's text and layout (as before) | Phrases of 1-4 words that recur or that the author marked (title, heading, bold, "Term:" label, spelled-out acronym), scored by occurrences × rarity × marks | `services/keyTerms.js` `extractTerms` | — |
| **Part-of-speech tagger** | wink-nlp with its small English model (MIT licence). A word the note mostly uses as a verb, adjective or function word is no term ("solve", "any", "called"); a word it clearly uses as a noun is ("derivative"); a compound noun said once is a term ("global symbol table", "translation lookaside buffer") but ranks below terms with more evidence (× 0.6). Upload-time TF-IDF keywords drop non-nouns too (the vector used for links is unchanged) | `services/posTags.js`, `keyTerms.js`, `tfidf.js` | `KEYTERMS_POS=off`, or the library failing to load: the rules alone, as before |
| **AI suggestions** (Groq) | Once per upload (one request for all of a document's subtopics, at most 4), after the response is sent. Prompt `keyterms-v1`, temperature 0. Each term must appear in the note word for word (any case, singular or plural), be 1-6 words, not a formula, not a single generic word; at most 12 per note. Stored on the note as `aiTerms` with a fingerprint of the text; ignored once the text changes and asked again after an edit. Notes saved earlier get them after a test build, a few at a time | `services/aiKeyTerms.js` | No `GROQ_API_KEY`, `KEYTERMS_AI=off`, or any failure: nothing stored, the rules work alone |
| **The student** | `PUT /api/notes/:id/key-terms { add: [], remove: [] }` (max 30 each). An added term must be in the note (else 400 `not_in_note`); it is always a key term, shown first and marked "yours". A removed term is never one. Stored as `termMarks`. A split document's terms are set on its subtopics | `routes/noteItems.js`, client `components/KeyTermEditor.jsx` | — |
| **A syllabus per subject** | `PATCH /api/subjects/:id { syllabus }` (up to 20,000 characters; `""` clears it). It is split into phrases ("Unit 3: paging, page table, TLB" → paging, page table, TLB). A note term the syllabus names gets a mark (+0.6), and a term inside a syllabus topic gets +0.25 | `services/keyTermSignals.js`, `routes/subjects.js`, client `components/SyllabusCard.jsx` | — |

All four act as **marks**, like a heading. A marked term is accepted even when said once, and the bonuses are:

| Mark | Bonus |
| --- | --- |
| student | +1.0 |
| syllabus | +0.6 |
| AI, importance 3 / 2 / 1 | +0.6 / +0.4 / +0.25 |
| title | +0.6 |
| heading, bold | +0.5 |

Whatever caches terms or concept records includes a fingerprint of these signals (`signalsFingerprint`). `CONCEPTS_VERSION` is 2, so records built by the old extractor are rebuilt on the next test or `/concepts` request.

**What the reading pane shows.** `keyTermDetails`: each term with where it came from (`you`, `ai`, `syllabus`, `notes`). `keyTermMarks`: the student's own lists. `aiTerms` and the attached `syllabus` are never sent to the client.

**When the AI is asked.** If a note has nothing an MCQ or theory question could be drawn from, test generation now sends Groq **no request** and reports `fallbackReason: "no-material"`, instead of sending an empty prompt.

## 2. Measured results

`npm run eval:keyterms -- --before <concept-records checkout>`. Rules only: no AI key, no embedding model. The full report is in `server/evaluation/keyterms/report.md`.

- **The set:** 8 documents (circuits, differentiation, recursion, linker/loader, cyber security, DBMS, distributed systems, operating systems), split into notes as an upload is, with 190 marked terms.
- **Precision** is the share of the system's terms that are marked. **Recall** is the share of marked terms the system found. **Strict** means the same words, ignoring case, plurals, hyphens and possessives.

| Output | Before | Rules + tagger | Rules + tagger + syllabus |
| --- | --- | --- | --- |
| Terms tests are built from (top 16/note): precision | 50% | 51% | 51% |
| ... recall | 52% | **68%** | **68%** |
| ... F1 | 0.51 | 0.58 | 0.58 |
| Terms shown in the note (top 10): precision | 76% | 74% | 75% |
| ... recall | 46% | **61%** | **61%** |
| Upload keywords (TF-IDF top 12): precision, lenient | 44% | 51% | 51% |

**What this shows:**
- The tagger finds many more of the marked terms: "translation lookaside buffer", "mutual exclusion", "banker's algorithm", "vector clock", "Merkle-Damgard construction".
- Precision stays about the same.

**Where it is worse or flat:**
- Recursion notes: "stack overflow" is no longer found.
- DBMS: precision fell from 61% to 48%. The new compound rule lets in unmarked phrases ("consistent state", "weaker isolation"); a rater might count some of them as fair.
- The syllabus adds one correct term on this set: the syllabi name terms the tagger already finds. It matters more when a key term is said once and unmarked.
- Upload keywords are still single words, so strict precision barely moves (14% to 15%).

**Not measured:**
- **AI suggestions:** these need a live Groq key. The code path is tested with a stand-in AI server (`test/keyTermSignals.test.mjs`), and every suggested term is checked against the note's text. Whether it improves recall or precision is unmeasured.
- **Student marks:** these make a term a key term by definition, so there is nothing to measure.

**The labels are provisional.** They were marked by an AI session from the texts alone, before any system output was looked at. To make the numbers count, have two people mark the same 8 documents independently, settle disagreements, and replace `server/evaluation/keyterms/labels.json`. Then rerun.

## 2a. Other ranking methods tried: YAKE, TextRank, RAKE, BM25

All four are implemented and switchable. Each was measured, and none is on by default: none improved the results on this set.

| Method | What it does | Where | Switch | Result | Default |
| --- | --- | --- | --- | --- | --- |
| **YAKE** | Ranks phrases from the note alone: first position, capitals, frequency, spread over sentences, variety of neighbours | `services/keyphraseScores.js` `yake` | `KEYTERMS_SCORERS=yake` | Question terms 129 → 129 correct (128 at double weight); shown terms 115 → 114 | off |
| **TextRank** | PageRank over the note's content words, linked within two words | `textrank` | `KEYTERMS_SCORERS=textrank` | 129 → 130; shown 115 → 115 | off |
| **RAKE** | Word degree ÷ frequency inside content-word runs | `rake` | `KEYTERMS_SCORERS=rake` | 129 → 131; shown 115 → 114 | off |
| All three averaged | — | `keyphraseSignal` | `KEYTERMS_SCORERS=yake,textrank,rake` | 129 → 130; shown 115 → 115 | off |
| **YAKE for upload keywords** | Scales each keyword's TF-IDF weight by its YAKE rank (×0.75–1.25); the link vector is unchanged | `tfidf.js` | `KEYWORDS_YAKE=on` | Keywords 42 → 43 correct; for a note with no other notes to compare against (the "first note" case), 40 → 40 | off |
| **BM25** for link vectors | Okapi BM25 (k1 1.2, b 0.75) instead of TF-IDF: repetition saturates, long notes are discounted | `tfidf.js` `computeTfidf({ weighting })` | `LINK_WEIGHTING=bm25`, then `npm run relink` | Proxy only (below) | off |

**How the three scorers are applied.** They do not decide whether a phrase is a term; they only re-order accepted terms by ±25% (`KEYTERMS_SCORER_WEIGHT`, 0–2, default 0.5). Most notes here have 16 accepted terms or fewer, so the order rarely changes which terms are used. That is why the differences are one or two terms out of 190 — within noise. They may matter on long notes (many more than 16 candidate terms), which this set lacks: re-test there before switching any on.

**BM25: why it is off.** The human ratings behind the link thresholds (`docs/LINK_EVALUATION.md`) are not in the repository, so BM25 could only be compared on a proxy: every pair of subtopics in the 8 sample documents. The measure (AUC) is how often a pair from the same document scores higher than a pair from different documents; 0.5 would be chance.

| Weighting | AUC | Same-document links at 0.11 | Different-document pairs at or above 0.11 |
| --- | --- | --- | --- |
| TF-IDF | 0.745 | 21 of 65 | 11 of 286 |
| BM25 | 0.626 | 8 of 65 | 9 of 286 |

BM25 separated related from unrelated topics less well, and it would change 13 of 65 same-subject link decisions at the current threshold (rank agreement with TF-IDF: Spearman 0.905).

To decide on real ratings, run the rated link evaluation again with BM25. Use the run folder with the raters' `ratings_*.csv` files:

`LINK_WEIGHTING=bm25 npm run eval:links -- score <run folder> --recompute <notes folder>`

Compare the result with the TF-IDF run. If BM25 wins, set new thresholds from its grid, set `LINK_WEIGHTING=bm25` on Render, and run `npm run relink`.

**Key terms on the graph page.** This is what "use the key-term extractor for keywords" became. The graph API's nodes now carry `keyTerms`, the same terms the reading pane shows. The graph page lists them as "Key terms" for the selected note and searches them. The stored single-word `keywords` stay as they are, because cluster labels ("shared ideas") and the keyword map compare single words across notes: phrases would rarely be shared.

## 3. Costs and switches

- **Memory:** the tagger adds about 30-60 MB once loaded (on the first upload or test build). Render's free server has 512 MB, and OCR of a large photo was measured near that limit before (HANDOVER.md §6). OCR could not be run here to measure the combination. If the API restarts on large photo uploads, set `KEYTERMS_POS=off`.
- **Speed:** loading takes about 0.2 s, once. Tagging takes about 0.13 s per 100,000 characters.
- **AI cost:** one Groq request per upload (more only for very long documents), plus at most one per test build for older notes. Each is about 18,000 characters of input at most.
- **Settings:**
  - `KEYTERMS_SCORERS` (yake, textrank, rake; off by default), `KEYTERMS_SCORER_WEIGHT` (0–2, default 0.5), `KEYWORDS_YAKE=on`, `LINK_WEIGHTING=bm25`: all off by default, see §2a.
  - `KEYTERMS_POS=off` turns the tagger off.
  - `KEYTERMS_AI=off` turns AI suggestions off.
  - Without `GROQ_API_KEY`, AI suggestions are off anyway.
- **Logs:** `[keyterms] ai: notes=… requests=… stored=… terms=… dropped=…` (counts only, never note text), and `[keyterms] part-of-speech tagger unavailable` if it fails to load.

## 4. Tests

- **`test/keyTermSignals.test.mjs`** covers:
  - the tagger's effect on terms and keywords;
  - syllabus parsing and bonuses;
  - AI terms: verbatim check, invalid terms dropped, stale after an edit, failure tolerated, logs without text;
  - the key-terms endpoint: not-in-note refusal, limits, owner only, split documents, clearing;
  - the syllabus endpoint;
  - concept records picking all of it up.
- **`test/assessment.test.mjs`:** the request-budget test now uses a note with a real term per chapter, and checks that a note with nothing to ask about makes no AI request.
- **Client:** the key-term editor and syllabus card were checked in a headless browser against a local server: add, refuse a term not in the note, save, "yours" and "syllabus" tags.
