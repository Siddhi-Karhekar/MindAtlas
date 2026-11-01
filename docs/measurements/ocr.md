# How accurately MindAtlas reads text from images

A student can upload a photo of their notes, and can attach photos of a handwritten
answer to a test. This measurement checks how close what the app reads is to what
is really on the page. It uses the app's own functions, on the same path a real
upload takes:

- **Photos of notes** are read by Tesseract (`server/src/services/ocr.js`), and the
  page is then rebuilt into the note's text (`server/src/routes/notes.js`).
- **Photos of answers** are read by a Groq vision model first, with Tesseract as the
  fallback (`server/src/services/answerImages.js`).
- **Scanned PDFs are not read at all.** The app reads only a PDF's text layer. If
  there is none, it tells the student to upload the pages as images
  (`routes/notes.js`). So there is no scanned-PDF score here.

App behaviour is unchanged. Checking this measurement found two bugs in the app. Both
are still there, so the scores below include them: see
[The bugs this found](#the-bugs-this-found).

## The result in short

- **Printed notes read very well when the page is clean or has one mild problem.**
  A clean page has a character error rate of 2.7%, and 80% of those errors are the
  dots on one contents page. On the other 18 pages it is 0.57%, most of it page numbers
  the app removes on purpose. Low resolution, blur and tilt stay at 3.8% to 6.2%.
- **Uneven light is the main weakness on print.** A soft shadow costs a third of the
  text (35.1% errors), though a person can still read the page. A mix of mild damage,
  the closest thing here to a real photo, gives 65.5% errors.
- **Tesseract cannot read handwriting.** It finds only 15.1% of the words, gives no
  text at all on 24.4% of photos, and invents so much junk that the character error
  rate passes 100% (113.3%). This was expected, and it is reported as it came out.
- **The vision model is far better on the same photos**: 77.7% against 15.9% on the
  word score that ignores reading order. A typical page has 6.5% character errors
  against 69.7%. It is used only for answer photos. A photo of notes is always read
  by Tesseract.
- **The app's `confidence` does not warn of a bad page.** A shadowed page losing a
  third of its text scores 0.95, against 0.96 for a clean one, because `confidence`
  only looks at the words Tesseract kept. The flag for badly read notes caught 0 of 24
  printed pages and 6 of 100 handwritten pages with at least 50% errors.
- **Two bugs were found, and neither is fixed.** A photo of notes can be read on its
  side because of how its rotation tag is written (0.4% errors become 91.7%). And a
  vision reply holding `\%` is thrown away. See
  [The bugs this found](#the-bugs-this-found).
- **These are synthetic damage and other people's handwriting, not our students'
  photos.** Read [the limits](#limits) before quoting any of these numbers.

## What the scores mean

**Character error rate (CER)** is how many single letters must be added, removed or
changed to turn the reading into the correct text, divided by the length of the
correct text. **Word error rate (WER)** is the same, counting whole words. One wrong
letter makes a whole word wrong, so WER is usually higher than CER.

| CER | Meaning |
| --- | --- |
| 0% | The reading is exactly right |
| 5% | About one letter in twenty is wrong |
| 100% | As many changes as there are letters. An empty reading scores exactly this |
| Above 100% | The reading has invented more junk than there was real text |

**Pooled and median.** The main scores are pooled: all the errors divided by all the
correct text, so a long page counts for more. One page full of junk can dominate a
pooled score, so the median page is shown as well: half the pages did better than it.

**Before scoring, only two things were tidied**: everything was put in lower case, and
every run of spaces, tabs and line breaks became one space (spacing at the very start
and end was removed). Punctuation, symbols and accents stay, so "word," and "word"
differ.

**Word scores that ignore reading order.** CER and WER also count words in the wrong
order as errors, so a correct reading of two columns taken in the other order would
score badly. These scores treat each page as a bag of words:

- **Words found:** of the words on the page, the share the reading has anywhere.
- **Words right:** of the words in the reading, the share really on the page.
- **F1:** one score from those two. It is high only when both are high.

**"All pages" and "no-text pages left out".** The app returns nothing when Tesseract
is confident in fewer than 3 words, and the student is told to try a sharper photo.
"All pages" counts such a page as all wrong (100%). The other column leaves it out.

**95% intervals** are in square brackets. They show how far a score moves if a
different sample of pages had been used (see [Method](#method)).

## Results: printed pages

19 pages from our two PDFs, each at seven levels of damage, so 133 images.

| Level | What was done | No text | CER, all pages [95%] | WER, all pages [95%] | CER, no-text pages left out [95%] | WER, no-text pages left out [95%] |
| --- | --- | --- | --- | --- | --- | --- |
| Clean | 300 DPI, nothing added | 0 of 19 | 2.7% [0.5%, 7.7%] | 1.8% [0.8%, 4.2%] | 2.7% [0.5%, 7.5%] | 1.8% [0.8%, 4.1%] |
| Low resolution | 100 DPI | 0 of 19 | 3.8% [0.7%, 10.6%] | 3.5% [1.7%, 7.4%] | 3.8% [0.7%, 11.1%] | 3.5% [1.7%, 7.9%] |
| Blur | Gaussian blur, sigma 3 pixels | 0 of 19 | 6.2% [0.7%, 17.3%] | 4.8% [1.4%, 11.9%] | 6.2% [0.7%, 16.8%] | 4.8% [1.4%, 11.8%] |
| Tilt | Turned 5 degrees | 0 of 19 | 5.2% [1.9%, 12.2%] | 10.1% [7.5%, 13.6%] | 5.2% [1.8%, 11.7%] | 10.1% [7.1%, 13.8%] |
| Shadow | A soft shadow, 40% brightness at the far corner | 1 of 19 (5.3% [0.0%, 15.8%]) | 35.1% [29.4%, 41.9%] | 37.2% [32.1%, 43.6%] | 34.7% [28.6%, 41.0%] | 36.8% [31.4%, 42.9%] |
| Noise | Grain, sigma 30 grey levels | 0 of 19 | 55.5% [0.5%, 241.4%]\* | 108.0% [0.9%, 475.7%]\* | 55.5% [0.5%, 193.3%]\* | 108.0% [0.9%, 384.3%]\* |
| Combination | Shadow to 60%, turned 3 degrees, blur sigma 2, 150 DPI, grain sigma 15 | 2 of 19 (10.5% [0.0%, 26.3%]) | 65.5% [60.2%, 71.9%] | 118.1% [101.6%, 141.8%] | 65.1% [59.5%, 71.3%] | 118.4% [100.8%, 139.7%] |

\* One page causes this, and these intervals are not reliable: see the notes below.

| Level | CER, median page | Words found | Words right | Time, median | Time, slowest | Mean confidence |
| --- | --- | --- | --- | --- | --- | --- |
| Clean | 0.5% | 98.2% | 99.2% | 2.5 s | 4.4 s | 0.96 |
| Low resolution | 0.9% | 96.7% | 97.7% | 1.5 s | 2.4 s | 0.94 |
| Blur | 0.6% | 95.2% | 99.5% | 2.4 s | 4.1 s | 0.95 |
| Tilt | 3.2% | 90.1% | 91.3% | 2.3 s | 4.1 s | 0.93 |
| Shadow | 34.5% | 63.5% | 92.5% | 1.8 s | 3.5 s | 0.95 |
| Noise | 0.5% | 97.3% | 47.7% | 2.7 s | 155.7 s | 0.95 |
| Combination | 68.5% | 31.9% | 24.5% | 5.0 s | 5.8 s | 0.87 |

Times are for one image at a time on an Apple M2 laptop with 8 GB of memory. They
include starting a new Tesseract worker for each image, as the app does. They are not
the live server's times.

**What is behind these numbers** (from the page-by-page readings):

- **Clean pages score near 0, as they should.** The one contents page holds 80% of the
  errors, because Tesseract reads its rows of dots as letters. On 16 of the other 18
  pages, the only difference from the correct text is the page number, which the app
  removes on purpose. The other two pages hold the only real misses: one letter read
  wrongly, and one large title line that Tesseract skipped.
- **A shadow loses text. It does not garble it.** The words kept are 92.5% right, but
  only 63.5% of the words on the page are found. Tesseract drops the darker part of the
  page.
- **Noise is one page.** On 18 of the 19 pages noise does little harm (2.8% CER
  without the other page). The other is a nearly empty page of 199 characters, where
  Tesseract read the grain as 15,167 characters of junk, in 155.7 seconds. That page
  holds 95% of all the errors at this level, and the app did not flag it. Its intervals
  are not reliable either: the same 19 pages gave 241.4% and 193.3% in two draws, and
  400,000 draws give about 199%.
- **The rebuild into a note does not harm the reading.** Scored before the rebuild,
  Tesseract's own text has 3.1% CER on clean pages and 65.6% on the combination,
  against 2.7% and 65.5% after it.

## Results: handwriting

172 GNHK photos of English handwriting, read by Tesseract exactly as a note upload is.
51 of them also hold some printed words, so the 121 with none are shown as well.

| Photos | No text [95%] | CER, all pages [95%] | WER, all pages [95%] | CER, no-text pages left out [95%] | WER, no-text pages left out [95%] |
| --- | --- | --- | --- | --- | --- |
| All 172 | 42 (24.4% [18.0%, 30.8%]) | 113.3% [92.0%, 142.3%] | 208.9% [165.5%, 267.6%] | 115.6% [90.3%, 153.3%] | 226.9% [177.1%, 300.0%] |
| The 121 with no printed words | 34 (28.1% [20.7%, 36.4%]) | 121.5% [92.8%, 167.5%] | 226.2% [166.5%, 318.8%] | 126.3% [90.2%, 184.8%] | 253.6% [179.3%, 371.1%] |

| Photos | Words found [95%] | Words right [95%] | F1 [95%] | CER, median page | Time, median | Time, slowest |
| --- | --- | --- | --- | --- | --- | --- |
| All 172, all pages | 15.1% [12.9%, 17.8%] | 7.5% [5.7%, 9.9%] | 10.1% [8.1%, 12.4%] | 76.1% | 2.5 s | 50.9 s |
| All 172, no-text pages left out | 17.6% [15.2%, 20.4%] | 7.5% [5.7%, 10.0%] | 10.6% [8.4%, 13.1%] | | | |
| The 121, all pages | 12.0% [9.7%, 14.4%] | 5.7% [3.7%, 8.2%] | 7.7% [5.6%, 10.2%] | 85.9% | 2.4 s | 50.9 s |
| The 121, no-text pages left out | 14.6% [12.1%, 17.5%] | 5.7% [3.9%, 8.2%] | 8.2% [6.1%, 10.7%] | | | |

- **Reading order is not the problem.** Ignoring order, only 15.1% of the words on the
  page appear anywhere in the reading, and only 7.5% of the words read are real.
- **The error passes 100% because of invented junk.** 30 of the 172 pages are above
  100%, and the worst is 2,701%. The five worst pages hold 21% of all the character
  errors. Without them the CER is still 92.3%.

## Results: answer photos, vision model against Tesseract

30 of the same photos, picked with the seed and shrunk as the browser shrinks an answer
photo before sending it. Both readers go through the app's `readAnswerImages`. The
model is `qwen/qwen3.8-27b`, and it still works. It read 29 of the 30. The 30th hit
the second bug below, so the scores are on the same 29 photos.

| Reader | No text | CER, all pages [95%] | WER, all pages [95%] | CER, no-text pages left out [95%] | WER, no-text pages left out [95%] |
| --- | --- | --- | --- | --- | --- |
| Vision model | 0 of 29 | 26.1% [10.4%, 48.9%] | 38.2% [23.4%, 55.3%] | 26.1% [10.1%, 50.1%] | 38.2% [23.5%, 56.9%] |
| Tesseract (the fallback) | 8 of 29 (27.6% [13.8%, 44.8%]) | 67.9% [60.8%, 75.7%] | 114.3% [104.5%, 126.1%] | 61.2% [55.0%, 67.5%] | 117.9% [105.9%, 132.4%] |

| Reader | CER, median page | Words found [95%] | Words right [95%] | F1 [95%] | Time, median | Time, slowest | Sent for a person to review |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vision model | 6.5% | 83.2% [77.4%, 88.2%] | 72.9% [62.3%, 82.7%] | 77.7% [70.5%, 84.5%] | 1.0 s | 4.0 s | 2 of 29 |
| Tesseract (the fallback) | 69.7% | 16.3% [11.2%, 21.4%] | 15.5% [11.7%, 19.9%] | 15.9% [11.7%, 20.0%] | 1.7 s | 3.2 s | 29 of 29 |

The difference on the same photos, over the same resamples. An interval that does not
cross zero means a real difference, for these photos.

| Vision model minus Tesseract | CER [95%] | WER [95%] | F1 [95%] |
| --- | --- | --- | --- |
| In percentage points | −41.8 [−59.3, −16.2] | −76.1 [−98.6, −52.0] | +61.8 [+52.5, +69.3] |

- **One photo pulls the vision score down.** The model wrote 1,413 characters for a
  page with 509 in its labels, and that page holds 40% of its errors. Without it the
  CER is 16.6% and the WER 31.1%. 20 of the 29 pages are under 10% CER.
- **Some of its "errors" are what the app asks for.** The app tells the model to write
  formulas in LaTeX and to describe diagrams in brackets, and the labels have neither.
  Those parts are 1,584 of the 10,193 characters it wrote (16%), on a few photos, and
  they can count as errors here.
- **"Clear" does not always mean right.** The model called 27 of the 29 pages "clear",
  and those skip review. Most are good (median 6.5% CER), but 5 of the 27 have at least
  20% CER.
- **Tesseract scores better here than on all 172 photos, for two reasons.** The very
  worst pages happen not to be in this sample. And shrinking cuts its junk: on these
  same 29 photos at full size, its CER is 100.5% and its words right 8.5%, against
  67.9% and 15.5% when shrunk. It finds the same share of words either way (16.1% and
  16.3%). A photo of notes is not shrunk before reading.

Published figures are context only. The
[GNHK paper](https://cdn.amazon.science/38/fe/4c3105fb43129bf59cc0aadb5d78/gnhk-a-dataset-for-english-handwriting-in-the-wild.pdf)
(read 2026-11-01, Table 6) reports a best character accuracy of 0.861 and word accuracy
of 0.502. That is a model trained on GNHK, reading single words already cropped out by
hand, with scribbles, maths and punctuation-only words removed. Ours read whole pages
and were not trained on GNHK, so the numbers cannot be compared. The paper reports no
Tesseract result, and no published figure for current Tesseract on whole pages of
handwriting was found that could be cited.

## Does the app's confidence track errors?

**What it is.** `confidence` is the average certainty of only the words Tesseract was
at least 60% sure of (`services/ocr.js`). So it can never be below 0.60, and text
Tesseract dropped cannot lower it.

Spearman correlation runs from −1 to +1. Here −1 would mean that the page's errors
always rise as confidence falls, and 0 that the two are unrelated.

| Set | Pages with text | Lowest and highest confidence | Spearman with the page's CER [95%] |
| --- | --- | --- | --- |
| Printed, every level | 130 | 0.73 to 0.96 | −0.67 [−0.77, −0.56] |
| Handwriting | 130 | 0.63 to 0.96 | −0.37 [−0.50, −0.24] |

| Confidence | Printed pages | Printed CER (median page) | Handwritten pages | Handwriting CER (median page) |
| --- | --- | --- | --- | --- |
| Below 0.70 | 0 | - | 22 | 190.3% (78.1%) |
| 0.70 to 0.79 | 1 | 7,499% (the junk page above) | 68 | 107.9% (66.8%) |
| 0.80 to 0.89 | 16 | 64.3% (68.3%) | 33 | 86.2% (61.9%) |
| 0.90 and above | 113 | 9.5% (1.1%) | 7 | 55.9% (59.4%) |

So it does move the right way, but it cannot be relied on to say a page is bad:

- **It misses dropped text.** Clean pages average 0.96 and shadowed pages 0.95, with
  2.7% and 35.1% CER.
- **It stays high on handwriting.** Pages at 0.90 and above still have a median of 59.4%
  CER, and the mean over all handwriting is 0.77 with an F1 of 10.1%.

## Are badly read pages flagged?

**How the app uses it.** `extractionConfidence` in `services/conceptRecords.js` starts
from `confidence`, then lowers it if the text has too many misread-looking words. Below
0.5, the note's concepts are marked "text not read reliably" and no test question is
made from them. Since `confidence` is never below 0.60, it can never cause this flag
by itself. Only the word-pattern checks can, and those caused all 7 flags below.
Nothing in the client shows a student this flag.

| Real CER of the page | Printed pages | Printed pages flagged | Handwritten pages | Handwritten pages flagged |
| --- | --- | --- | --- | --- |
| Below 5% | 83 | 0 | 0 | 0 |
| 5% to 19% | 7 | 0 | 1 | 0 |
| 20% to 49% | 16 | 0 | 29 | 1 |
| 50% and above | 24 | **0** | 100 | **6** |

**So badly read pages mostly pass.** Their words can then become test questions. The
strongest protection is the 3-word rule, which stopped 42 of the 172 handwritten
photos outright. Of the 130 that got through, 100 have at least 50% errors and 94 of
those are not flagged.

## The bugs this found

Neither is fixed. Both are written up here so the team can decide.

### 1. A photo's rotation tag is ignored in one of its two byte orders

Phones often save a photo on its side, with a tag saying which way to turn it. The tag
can be written in two byte orders. `tesseract.js` looks for the tag using a byte
pattern that matches only one of them
(`node_modules/tesseract.js/src/worker-script/utils/setImage.js`, line 14). With the
other, the page is read on its side.

The same 3 printed pages, each saved on its side and tagged to be turned:

| Image | CER | WER |
| --- | --- | --- |
| Upright, no tag | 0.4% | 0.8% |
| On its side, tag in big-endian order | 0.4% | 0.8% |
| On its side, tag in little-endian order | **91.7%** | **296.1%** |
| On its side, no tag at all | 91.7% | 296.1% |

A one-off run on one page found the same for all three turning tags (3, 6 and 8): 0.8%
with big-endian, and 83.0% to 112.2% with little-endian.

- **Who it reaches.** Photos of notes, because they go to Tesseract as sent. Answer
  photos are safe, because the browser turns them first.
- **How common it is.** 37 of the 172 GNHK photos need turning, and the library misses
  the tag on 9 of them. How often it happens with our students' phones has not been
  checked.
- **On handwriting it matters little,** because Tesseract reads handwriting so poorly
  anyway. Turning those 9 photos first cuts the no-text pages from 5 to 2 and raises the
  F1 by 2.4 points [0.7, 5.3]. Their CER does not clearly change (178.2% as sent, 193.6%
  turned, and the interval on the difference crosses zero). On printed notes it is the
  difference between 0.4% and 91.7%.

### 2. A vision reply holding `\%` is thrown away

The app tells the vision model to write symbols in LaTeX, and to reply in JSON.
`escapeLatexBackslashes` in `services/llm.js` repairs LaTeX backslashes only when a
letter follows, as in `\frac`. Anything else breaks the JSON, and the whole reply is
lost.

| The reply holds | The app reads it? |
| --- | --- |
| `\frac`, `\alpha` | Yes |
| `\%`, `\{`, `\,`, `\_`, `\&`, `\$` | **No, the whole reply is lost** |

The table is from made-up replies through the real `parseJsonLoose`. It happened for
real on 1 of the 30 photos: all 3 tries in the run gave a reply the app could not use, so
it fell back to Tesseract. Two more calls on that photo showed why. The model's reply was
complete, it held `\%`, and the JSON reader stopped exactly there. That answer is still
sent for review, so no wrong mark is given silently, but the reading is far worse.
The same function also reads the AI's replies for writing questions, marking answers and
choosing key terms (`testEngine.js`, `gradingEngine.js`, `aiKeyTerms.js`). Whether this
reaches them has not been measured here.

## Limits

**About what was tested**

- **Synthetic damage is not the same as real photos.** The blur, tilt, shadow and grain
  are made by code, with sizes chosen by looking at the pages. A real photo also has
  curved paper, glare and fingers. The combination level is the nearest thing here, and
  it is still an imitation.
- **GNHK is not our students' notes.** Its paper describes things like shopping lists,
  sticky notes and diaries from around the world, taken with phone cameras. Our students'
  handwriting and subjects could score better or worse.
- **The printed notes are ones the team developed on.** `networks_unit2` and `os_unit3`
  are the team's own working samples, so they may read better than other notes. They are
  also only 2 documents (17 of the 19 pages are one document), with plain text in common
  fonts and no tables or formula symbols.
- **Tesseract is expected to be weak on handwriting.** The app's own comments say so
  (`answerImages.js`). The poor score is reported as it came out. It is a score for
  Tesseract, which note uploads use, not for the vision model.
- **Only English was tested.** Nothing here says how any other language reads.
- **The vision test is small and partial.** It is 30 photos, one model, on one day. The
  app also passes the question text to the model, and no question exists here, so it
  was left empty. The rest of the Groq path is not measured here.

**About this data**

- **The copy of GNHK is unofficial.** The official download page now redirects to the
  Goodnotes home page, so the files could not be compared with the originals. The counts
  fit the paper (687 images, 25% of them set aside as test data).
- **Some labels are left out, which can only raise the error rate.** 407 of the 10,066
  label tokens are not real text (see [Method](#method)). If a reader writes something
  for those marks, it counts as an error.
- **Printed words on the photos are kept,** because the app reads the whole page. They
  flatter the handwriting score slightly, which is why the 121 photos with none are
  shown as well.
- **Reading order comes from the labels.** Tokens are sorted by the labelled line, then
  left to right. Where people could reasonably read a page in another order, CER and WER
  count that as error, and the word scores do not.

**About the numbers**

- **The intervals cover one thing only**: which pages happened to be sampled. They do
  not cover any limit above. With only 19 printed pages they are wide, and the same
  pages are resampled, not new ones.
- **Printed damage comes from one seed.** Which way a page tilts and which corner gets
  the shadow vary by page, and the [second seed](#running-it-again) shows how much this
  moves.
- **Times are from a laptop.** The live server has much less memory and may be much
  slower. Photo OCR has no time limit of its own, unlike document reading, so a page like
  the 155.7-second one would simply run for as long as it takes.
- **The flag was checked as if each photo became one note.** A photo with real headings
  is split into several notes, and each is then checked on its own text, so some results
  could differ.

## Method

**The path measured.** Each image goes through the size limit, `checkUploadContent` and
`extractTextFromImage`, all imported and not rewritten. The note's text is then chosen as
`routes/notes.js` chooses it: the page rebuilt by `blocksFromOcrLines`, or Tesseract's own
text if that gives nothing. Images are read one at a time.

**Printed pages.** `sample-notes/networks_unit2.pdf` (17 pages) and
`verify/fixtures/os_unit3.pdf` (2 pages). The correct text is each page's own text layer,
read with `pdfjs-dist`. Pages are rendered at 300 DPI as grey images with `pdfjs-dist` and
`@napi-rs/canvas` (which `pdfjs-dist` installs itself; no dependency was added), and saved
as JPEGs at quality 90, as a phone would. These PDFs do not embed their fonts, so the
fonts folder from `pdfjs-dist` must be passed, or the pages render blank. The tool refuses
a blank page.

**Damage**, done with code in `evaluation/lib/ocr.js`. The sizes were fixed by looking at
the pages, before any score was seen: a person can still read every level. The seed picks
each page's tilt direction, shadow corner and grain.

**Handwriting.** The 172 test photos of GNHK, sent as they are. Each has a list of labelled
tokens, and every label was inspected first.

| Step | Tokens |
| --- | --- |
| In the labels | 10,066 |
| Left out: `%NA%`, marked as text but is not text | 150 |
| Left out: `%SC%`, an illegible scribble | 131 |
| Left out: `%math%`, maths that ASCII cannot write | 126 |
| **Kept** | **9,659** (8,830 handwritten, 829 printed) |

The meanings are the GNHK paper's. Tokens such as `70%` are real text and stay. The labels
are not stored in reading order (94 of the 172 files are out of order), so they are sorted
by `line_idx`, then left to right by the middle of each word's box.

**Answer photos.** 30 photos picked with the seed, shrunk as `client/src/lib/answerImages.js`
does: the rotation tag obeyed, longest side 1,600 pixels, JPEG at quality 85. Each went
through `readAnswerImages` twice: with the model on, and with the app's own switch
`LLM_VISION_MODEL=off`, which gives the fallback. Calls were 25 seconds apart, and a failed
one was tried up to 3 times, 65 seconds apart. Scores are only on photos the model really
read.

**Intervals.** 1,000 resamples of the pages, drawn with repeats. A page drawn twice counts
twice. Each interval runs from the 2.5th to the 97.5th percentile. For printed pages, a
page's levels stay together when confidence is resampled. Differences compare two readers
in the same resample.

## Running it again

Run in `server/`:

```bash
npm run eval:ocr
```

| | |
| --- | --- |
| Commit | `153aeeb` (this report was added in the next commit) |
| Seed | 1 (the default; `--seed` changes it) |
| Resamples | 1,000 |
| Tesseract | `tesseract.js` 5.1.1, `eng.traineddata` 5,199,098 bytes, SHA-256 `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747` |
| Vision model | `qwen/qwen3.8-27b` on Groq, 2026-11-01 |
| `networks_unit2.pdf` | 26,156 bytes, SHA-256 `7c0add19eabc0849784c6a888ecd9f0b0af460affd0e91358030202021bcb353` |
| `os_unit3.pdf` | 5,960 bytes, SHA-256 `66c3fa391c6122504951571319c73fb7ff61340deca621035f1ead9c6749076c` |
| GNHK copy | [`aryaman27/goodnotes-handwritten-dataset`](https://huggingface.co/datasets/aryaman27/goodnotes-handwritten-dataset), revision `904297760a9fec813fdc1ecb5f8055cb1ca03550`, folder `test_data/test/`: 172 JPGs and 172 JSONs, 304,671,287 bytes |
| GNHK SHA-256 | `697e0ff3fc23b900bb7257874c6aad259e738661ebc989ec49591a7841a7d032`, over the list of each file's SHA-256 and name (`gnhkManifest` in `evaluation/ocr.mjs`) |
| Takes | About 38 minutes on an Apple M2 laptop with 8 GB of memory |

It reads the photos from `server/evaluation-output/datasets/gnhk/`, or from `--data <dir>`. It
needs `GROQ_API_KEY` in `server/.env` for the vision part (`--vision-images 0` skips it). It
writes `results.md`, `results.json` and `readings.jsonl` to a new folder in
`server/evaluation-output/` (git-ignored), or to `--out <dir>`. `results.md` and `results.json`
hold scores only. `readings.jsonl` holds every reading and the correct text, so it must stay
git-ignored and never be shared. The run behind this report passed
`--out evaluation-output/ocr-run1`; nothing else differs from the command above.

Checks on these numbers:

- **Sanity cases:** the same text scores 0% error, an empty reading scores 100%, and clean
  printed pages score near 0, with every remaining difference explained above.
- **Repeatable:** a second run, from the same commit, gave exactly the same text and confidence
  on every image the seed does not change: all 172 photos, the 9 turned ones, the 19 clean pages
  and the 12 rotation-test images.
- **A second seed agrees:** seed 2 (no vision calls) gives CER 5.4% for tilt, 38.7% [31.3%, 49.2%]
  for shadow and 71.6% [65.3%, 81.1%] for the combination, with 0 of 26 printed pages at 50% or
  more flagged. The levels with no randomness in their sizes (clean, low resolution, blur) are
  unchanged. The noise level again turns on the same nearly empty page: 19,131 characters of
  junk, and 2.8% CER without it. It took 323.8 seconds, with other work on the machine, and was
  not flagged.
- **Worked out a second way:** a separate Python script shares no code with the tool. It has
  its own Levenshtein and tidying, rebuilds the GNHK correct text from the label files, and
  reads the printed correct text from the PDF's bytes without `pdfjs-dist`. All 241 GNHK
  texts and 19 printed texts were the same, and all 712 saved scores matched exactly, as did
  the pooled scores and Spearman values. It cannot catch an error inside Tesseract or the
  model, only in what is done with their readings.
- **The one disagreement, and its cause:** that script's intervals agreed everywhere except
  the upper end of the noise level (205% against 241% for CER). Its cause is the single junk
  page: the score depends on how many copies of that page a resample holds. The saved run
  had 32 of 1,000 resamples with four or more copies, where about 16 are expected. The
  random helper was then tested and is sound: over 4,000 blocks its counts average 15.75
  and reach 33, and `Math.random` averages 15.78 and reaches 32. So 241% is an unlucky
  draw, and 400,000 resamples give about 199%. No other level was affected.
- **Against the real upload route:** all 172 photos and 6 printed images were uploaded through
  the real `POST /api/subjects/:id/notes` on a real server (a memory database, no AI key, its
  upload limit raised for this). The stored text and confidence matched the tool's, character
  for character, on all 178. The same 42 photos were refused as having no text, and the
  reliability matched on the 102 uploads that became a single note. Another 34 were split
  into several notes, which is the limit noted above.
- **Tested on made-up data:** `server/test/ocrEvaluation.test.mjs` is part of `npm test`. It
  checks the scores by hand-worked values, the labels, the damage, the rotation tags, the
  resampling and whole runs with stand-ins for Tesseract and the model. It needs no dataset,
  no network and no Tesseract model.

The two one-off runs in [The bugs this found](#the-bugs-this-found) (the other rotation tags
and the unreadable replies), the page-by-page notes and these check scripts are not in this
repository and are not part of `eval:ocr`.

The vision model got 35 calls in all: 1 small test image first, 32 in the run, and 2 more on
the photo with the unreadable reply. The 30 photos were sent to Groq.

## The data and its terms

**Credit.** This measurement uses GNHK, the GoodNotes Handwriting Kollection, by Alex W. C.
Lee, Jonathan Chung and Marco Lee. Its [official repository](https://github.com/GoodNotes/GNHK-dataset)
gives its licence as [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

**The copy we used is unofficial.** The official download page now redirects to the Goodnotes
home page, so the files came from a copy on Hugging Face, which has no licence tag of its own.
The link and exact revision are in the table above. The photos and labels themselves were not
changed. For scoring, the labels were sorted and some tokens left out, as [Method](#method)
says.

The files are not in this repository and must never be: not committed, and no label text copied
into docs or tests. The official repository says that anyone who finds their information in the
data can ask the authors to remove it.

> Lee, A. W. C., Chung, J., & Lee, M. (2021). GNHK: A Dataset for English Handwriting in the
> Wild. *International Conference of Document Analysis and Recognition (ICDAR)*.
