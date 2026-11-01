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

Checking this measurement found two bugs in the app. Both are now fixed, and the scores
below are from the fixed code: see [The bugs this found](#the-bugs-this-found). Those
two fixes are the only changes to how the app behaves.

## The result in short

- **Printed notes read very well when the page is clean or has one mild problem.**
  A clean page has a character error rate of 2.7%, and 80% of those errors are the
  dots on one contents page. On the other 18 pages it is 0.57%, most of it page numbers
  the app removes on purpose. Low resolution, blur and tilt stay at 3.8% to 6.2%.
- **Uneven light is the main weakness on print.** A soft shadow costs a third of the
  text (35.1% errors), though a person can still read the page. A mix of mild damage,
  the closest thing here to a real photo, gives 65.5% errors.
- **Tesseract cannot read handwriting.** It finds only 15.3% of the words, gives no
  text at all on 23.3% of photos, and invents so much junk that the character error
  rate passes 100% (113.0%). This was expected, and it is reported as it came out.
- **The vision model is far better on the same photos**: 75.7% against 16.3% on the
  word score that ignores reading order. A typical page has 7.1% character errors
  against 71.0%. It is used only for answer photos. A photo of notes is always read
  by Tesseract.
- **The app's `confidence` does not warn of a bad page.** A shadowed page losing a
  third of its text scores 0.95, against 0.96 for a clean one, because `confidence`
  only looks at the words Tesseract kept. The flag for badly read notes caught 0 of 24
  printed pages and 6 of 101 handwritten pages with at least 50% errors. These are not
  fixed: they are design limits, left for the team to decide on.
- **Two bugs were found and fixed.** A photo of notes could be read on its side because
  of how its rotation tag was written (91.7% errors, now 0.4%). And a vision reply holding
  `\%` was thrown away.
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
| Clean | 0.5% | 98.2% | 99.2% | 4.2 s | 7.4 s | 0.96 |
| Low resolution | 0.9% | 96.7% | 97.7% | 2.5 s | 4.1 s | 0.94 |
| Blur | 0.6% | 95.2% | 99.5% | 4.1 s | 7.1 s | 0.95 |
| Tilt | 3.2% | 90.1% | 91.3% | 4.0 s | 6.8 s | 0.93 |
| Shadow | 34.5% | 63.5% | 92.5% | 3.0 s | 6.0 s | 0.95 |
| Noise | 0.5% | 97.3% | 47.7% | 4.7 s | 264.8 s | 0.95 |
| Combination | 68.5% | 31.9% | 24.5% | 8.5 s | 9.9 s | 0.87 |

Times are for one image at a time on an Apple M2 laptop with 8 GB of memory. They
include starting a new Tesseract worker for each image, as the app does. They are not
the live server's times, and they are rough: an earlier run of the same images took 2.5 s
at the median for clean pages, where this one took 4.2 s.

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
  Tesseract read the grain as 15,167 characters of junk, in 264.8 seconds. That page
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
| All 172 | 40 (23.3% [16.9%, 29.7%]) | 113.0% [91.4%, 142.9%] | 208.5% [164.6%, 266.4%] | 115.0% [90.6%, 150.1%] | 225.1% [175.1%, 294.7%] |
| The 121 with no printed words | 32 (26.4% [19.0%, 33.9%]) | 120.9% [89.5%, 164.1%] | 225.5% [160.2%, 311.1%] | 125.1% [90.8%, 183.8%] | 250.3% [180.0%, 369.1%] |

| Photos | Words found [95%] | Words right [95%] | F1 [95%] | CER, median page | Time, median | Time, slowest |
| --- | --- | --- | --- | --- | --- | --- |
| All 172, all pages | 15.3% [13.2%, 17.9%] | 7.6% [5.8%, 10.0%] | 10.2% [8.2%, 12.6%] | 75.5% | 3.1 s | 185.7 s |
| All 172, no-text pages left out | 17.6% [15.3%, 20.3%] | 7.6% [5.7%, 10.1%] | 10.6% [8.4%, 13.2%] | | | |
| The 121, all pages | 12.3% [10.1%, 14.7%] | 5.8% [4.0%, 8.5%] | 7.9% [5.9%, 10.2%] | 82.9% | 2.9 s | 185.7 s |
| The 121, no-text pages left out | 14.7% [12.3%, 17.5%] | 5.8% [3.9%, 8.2%] | 8.3% [6.1%, 10.8%] | | | |

- **Reading order is not the problem.** Ignoring order, only 15.3% of the words on the
  page appear anywhere in the reading, and only 7.6% of the words read are real.
- **The error passes 100% because of invented junk.** 30 of the 172 pages are above
  100%, and the worst is 2,701%. The five worst pages hold 21% of all the character
  errors. Without them the CER is still 91.9%.
- **The slowest time is not a steady number.** That photo took 23.4 s in an earlier run
  and gave no text both times.

## Results: answer photos, vision model against Tesseract

30 of the same photos, picked with the seed and shrunk as the browser shrinks an answer
photo before sending it. Both readers go through the app's `readAnswerImages`. The
model is `qwen/qwen3.8-27b`, and it still works. It read 28 of the 30. Groq's rate limit
refused the other 2 on every try, so they are left out, and the scores are on the same 28
photos.

| Reader | No text | CER, all pages [95%] | WER, all pages [95%] | CER, no-text pages left out [95%] | WER, no-text pages left out [95%] |
| --- | --- | --- | --- | --- | --- |
| Vision model | 0 of 28 | 30.3% [11.8%, 55.2%] | 42.7% [25.6%, 61.9%] | 30.3% [12.8%, 54.5%] | 42.7% [26.4%, 62.5%] |
| Tesseract (the fallback) | 8 of 28 (28.6% [14.3%, 46.4%]) | 67.0% [59.1%, 74.4%] | 113.7% [103.1%, 125.7%] | 60.9% [53.7%, 67.0%] | 116.9% [103.6%, 131.0%] |

| Reader | CER, median page | Words found [95%] | Words right [95%] | F1 [95%] | Time, median | Time, slowest | Sent for a person to review |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vision model | 7.1% | 82.2% [75.7%, 88.1%] | 70.1% [59.5%, 81.4%] | 75.7% [67.7%, 83.6%] | 1.0 s | 2.2 s | 2 of 28 |
| Tesseract (the fallback) | 71.0% | 16.7% [11.2%, 22.0%] | 15.8% [11.5%, 20.6%] | 16.3% [11.7%, 20.8%] | 1.3 s | 3.0 s | 28 of 28 |

The difference on the same photos, over the same resamples. An interval that does not
cross zero means a real difference, for these photos.

| Vision model minus Tesseract | CER [95%] | WER [95%] | F1 [95%] |
| --- | --- | --- | --- |
| In percentage points | −36.7 [−54.9, −9.2] | −71.0 [−95.8, −45.4] | +59.4 [+49.4, +68.1] |

- **One photo pulls the vision score down.** The model wrote 1,398 characters for a
  page with 509 in its labels, and that page holds 36% of its errors. Without it the
  CER is 20.7% and the WER 35.6%. 18 of the 28 pages are under 10% CER.
- **Some of its "errors" are what the app asks for.** The app tells the model to write
  formulas in LaTeX and to describe diagrams in brackets, and the labels have neither.
  Those parts are 1,739 of the 9,947 characters it wrote (17%), on a few photos, and
  they can count as errors here.
- **"Clear" does not always mean right.** The model called 26 of the 28 pages "clear",
  and those skip review. Most are good (median 7.1% CER), but 6 of the 26 have at least
  20% CER.
- **Its replies are not exactly repeatable, but its scores are.** On the 27 photos it read
  in both runs, 21 replies were the same word for word and 6 differed, though the scores
  barely moved: CER 27.7% then 27.5%, and F1 77.1% then 77.2%.
- **Tesseract scores better here than on all 172 photos, for two reasons.** The five
  worst pages are not in this sample. And shrinking cuts its junk: on these same 28 photos
  at full size, its CER is 88.8% and its words right 9.9%, against 67.0% and 15.8% when
  shrunk. It finds the same share of words either way (16.6% and 16.7%). A photo of notes
  is not shrunk before reading.

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
| Handwriting | 132 | 0.63 to 0.96 | −0.35 [−0.49, −0.21] |

| Confidence | Printed pages | Printed CER (median page) | Handwritten pages | Handwriting CER (median page) |
| --- | --- | --- | --- | --- |
| Below 0.70 | 0 | - | 22 | 190.1% (75.1%) |
| 0.70 to 0.79 | 1 | 7,499% (the junk page above) | 69 | 102.3% (66.2%) |
| 0.80 to 0.89 | 16 | 64.3% (68.3%) | 34 | 98.2% (62.1%) |
| 0.90 and above | 113 | 9.5% (1.1%) | 7 | 55.9% (59.4%) |

So it does move the right way, but it cannot be relied on to say a page is bad:

- **It misses dropped text.** Clean pages average 0.96 and shadowed pages 0.95, with
  2.7% and 35.1% CER.
- **It stays high on handwriting.** Pages at 0.90 and above still have a median of 59.4%
  CER, and the mean over all handwriting is 0.77 with an F1 of 10.2%.

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
| 20% to 49% | 16 | 0 | 30 | 1 |
| 50% and above | 24 | **0** | 101 | **6** |

**So badly read pages mostly pass.** Their words can then become test questions. The
strongest protection is the 3-word rule, which stopped 40 of the 172 handwritten
photos outright. Of the 132 that got through, 101 have at least 50% errors and 95 of
those are not flagged. This has not been changed: how a page should be judged is a
decision for the team.

## The bugs this found

Both are fixed, each in its own commit. "Before" is commit `153aeeb` and "after" is
`9cc003a`.

### 1. A photo's rotation tag was ignored in one of its two byte orders

Phones often save a photo on its side, with a tag saying which way to turn it. The tag
can be written in two byte orders. `tesseract.js` looks for the tag using a byte
pattern that matches only one of them
(`node_modules/tesseract.js/src/worker-script/utils/setImage.js`, line 14). With the
other, the page was read on its side.

The same 3 printed pages, each saved on its side and tagged to be turned:

| Image | CER before | WER before | CER after | WER after |
| --- | --- | --- | --- | --- |
| Upright, no tag | 0.4% | 0.8% | 0.4% | 0.8% |
| On its side, tag in big-endian order | 0.4% | 0.8% | 0.4% | 0.8% |
| On its side, tag in little-endian order | **91.7%** | **296.1%** | **0.4%** | **0.8%** |
| On its side, no tag at all (nothing can turn this) | 91.7% | 296.1% | 91.7% | 296.1% |

**Who it reached.** Photos of notes, because they go to Tesseract as sent. Answer photos
were safe, because the browser turns them first. 37 of the 172 GNHK photos need turning,
and the library misses the tag on 9 of them. How often it happens with our students' phones
has not been checked.

**The fix.** When the library would miss the tag, its bytes now go in a JPEG comment at the
start of the file, in the order it looks for (`withRotationOcrCanSee` in `services/ocr.js`).
The picture is untouched, and on a printed page the reading came out exactly as a big-endian
tag's does, for all three turning tags. The library's own `rotateRadians` option was tried
first and is no use here: it cuts off the page at a quarter turn (11.4% CER).

**What it changed.** On printed notes, a lot. On handwriting, little, because Tesseract reads
handwriting so poorly anyway.

| | Before | After |
| --- | --- | --- |
| Printed page, little-endian tag: CER | 91.7% | 0.4% |
| The 9 photos: no-text pages | 5 | 3 |
| The 9 photos: words found | 1.8% | 8.4% |
| The 9 photos: F1 | 0.8% | 3.7% |
| All 172 photos: no-text pages | 42 | 40 |
| All 172 photos: CER [95%] | 113.3% [92.0%, 142.3%] | 113.0% [91.4%, 142.9%] |
| All 172 photos: F1 [95%] | 10.1% [8.1%, 12.4%] | 10.2% [8.2%, 12.6%] |

The fix changed only what it should. All 133 printed readings and 165 of the 172 photos read
word for word as before, and the other 7 are among those 9. The 9 now read about as well as
when turned upright first: their F1 as sent minus turned first is +0.5 points [−1.3, +1.7].

### 2. A vision reply holding `\%` was thrown away

The app tells the vision model to write symbols in LaTeX, and to reply in JSON.
`escapeLatexBackslashes` in `services/llm.js` repaired LaTeX backslashes only when a
letter followed, as in `\frac`. Anything else broke the JSON, and the whole reply was
lost.

| The reply holds | Read before? | Read after? |
| --- | --- | --- |
| `\frac`, `\alpha` | Yes | Yes |
| `\%`, `\{`, `\,`, `\_`, `\&`, `\$` | **No, the whole reply was lost** | **Yes** |

The table is from made-up replies through the real `parseJsonLoose`. It happened for real
on 1 of the 30 photos: all 3 tries in the first run gave a reply the app could not use, so it
fell back to Tesseract. Two more calls on that photo showed why. The model's reply was
complete, it held `\%`, and the JSON reader stopped exactly there.

**The fix.** JSON allows only a few escapes, so any other backslash is now doubled before
parsing. A `\u` that is not a real escape, as in `\unknown`, had the same problem and is
fixed too. Real escapes keep their meaning.

**What it changed.** That photo now gets the model's reading, on the first try. Tesseract gave
no text on it. The reading finds 43.8% of its words but has 178.0% CER, because the model wrote
393 characters for a page with 150 in its labels. The photos read both before and after barely
moved, as shown above, so the fall in the vision model's overall F1 from 77.7% (29 photos) to
75.7% (28 photos) comes from which photos are in the sample, not from the fix.

Question writing, marking and key terms read their replies through the same function
(`testEngine.js`, `gradingEngine.js`, `aiKeyTerms.js`), so they gain the same repair. How often
they were losing replies this way has not been measured.

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
- **The vision test is small and partial.** It is 28 photos, one model, on one day. The
  app also passes the question text to the model, and no question exists here, so it
  was left empty. The rest of the Groq path is not measured here.
- **Groq's rate limit is part of the real path.** The first run had no refusals, and the
  run on the fixed code had many, even with calls 60 and 120 seconds apart. In the app a
  refused answer photo falls back to Tesseract and is sent for review. How often that happens
  on the live site has not been measured.

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
- **Times are from a laptop, and they move.** The same images took 2.5 s at the median in one
  run and 4.2 s in another, and one photo took 23.4 s then 185.7 s, so read them as rough. The
  live server has much less memory and may be much slower. Photo OCR has no time limit of its
  own, unlike document reading, so a page like the noisy near-empty one simply runs for as long
  as it takes: 155.7 s to 323.8 s across three runs.
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
read. Because of the rate limit, the run was picked up twice on the same commit to try the
refused photos again, 60 and then 120 seconds apart, and that is how the last 2 of the 28
were read.

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
| Commit | `9cc003a` (this version of the report was added in the next commit) |
| Seed | 1 (the default; `--seed` changes it) |
| Resamples | 1,000 |
| Tesseract | `tesseract.js` 5.1.1, `eng.traineddata` 5,199,098 bytes, SHA-256 `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747` |
| Vision model | `qwen/qwen3.8-27b` on Groq, 2026-11-01 |
| `networks_unit2.pdf` | 26,156 bytes, SHA-256 `7c0add19eabc0849784c6a888ecd9f0b0af460affd0e91358030202021bcb353` |
| `os_unit3.pdf` | 5,960 bytes, SHA-256 `66c3fa391c6122504951571319c73fb7ff61340deca621035f1ead9c6749076c` |
| GNHK copy | [`aryaman27/goodnotes-handwritten-dataset`](https://huggingface.co/datasets/aryaman27/goodnotes-handwritten-dataset), revision `904297760a9fec813fdc1ecb5f8055cb1ca03550`, folder `test_data/test/`: 172 JPGs and 172 JSONs, 304,671,287 bytes |
| GNHK SHA-256 | `697e0ff3fc23b900bb7257874c6aad259e738661ebc989ec49591a7841a7d032`, over the list of each file's SHA-256 and name (`gnhkManifest` in `evaluation/ocr.mjs`) |
| Takes | About 40 to 60 minutes on an Apple M2 laptop with 8 GB of memory |

It reads the photos from `server/evaluation-output/datasets/gnhk/`, or from `--data <dir>`. It
needs `GROQ_API_KEY` in `server/.env` for the vision part (`--vision-images 0` skips it). It
writes `results.md`, `results.json` and `readings.jsonl` to a new folder in
`server/evaluation-output/` (git-ignored), or to `--out <dir>`. `results.md` and `results.json`
hold scores only. `readings.jsonl` holds every reading and the correct text, so it must stay
git-ignored and never be shared. A stopped run is picked up again from `readings.jsonl`, but
only on the same commit, and photos the model did not read are tried again. The run behind
this report passed `--out evaluation-output/ocr-run3-fixed`, and `--vision-gap` on its two
pick-ups; nothing else differs from the command above.

Checks on these numbers:

- **Sanity cases:** the same text scores 0% error, an empty reading scores 100%, and clean
  printed pages score near 0, with every remaining difference explained above.
- **Repeatable:** two runs on the code before the fixes gave exactly the same text and
  confidence on every image the seed does not change: all 172 photos, the 9 turned ones, the
  19 clean pages and the 12 rotation-test images.
- **A second seed agrees:** seed 2 (commit `153aeeb`, no vision calls) gives CER 5.4% for tilt,
  38.7% [31.3%, 49.2%] for shadow and 71.6% [65.3%, 81.1%] for the combination, with 0 of 26
  printed pages at 50% or more flagged. The levels with no randomness in their sizes (clean, low
  resolution, blur) are unchanged. The noise level again turns on the same nearly empty page:
  19,131 characters of junk, and 2.8% CER without it. It took 323.8 seconds, with other work on
  the machine, and was not flagged. The fixes do not touch these pages: all 133 printed readings
  are the same before and after them.
- **Worked out a second way:** a separate Python script shares no code with the tool. It has
  its own Levenshtein and tidying, rebuilds the GNHK correct text from the label files, and
  reads the printed correct text from the PDF's bytes without `pdfjs-dist`. On the run behind
  this report, all 241 GNHK texts and 19 printed texts were the same, and all 712 saved scores
  matched exactly, as did the pooled scores and Spearman values. It cannot catch an error
  inside Tesseract or the model, only in what is done with their readings.
- **The one disagreement, and its cause:** that script's intervals agreed everywhere except
  the upper end of the noise level (205% against 241% for CER). Its cause is the single junk
  page: the score depends on how many copies of that page a resample holds. The saved run
  had 32 of 1,000 resamples with four or more copies, where about 16 are expected. The
  random helper was then tested and is sound: over 4,000 blocks its counts average 15.75
  and reach 33, and `Math.random` averages 15.78 and reaches 32. So 241% is an unlucky
  draw, and 400,000 resamples give about 199%. No other level was affected.
- **Against the real upload route:** on the fixed code, all 172 photos and 6 printed images were
  uploaded through the real `POST /api/subjects/:id/notes` on a real server (a memory database,
  no AI key, its upload limit raised for this). The stored text and confidence matched the
  tool's, character for character, on all 178. The same 40 photos were refused as having no
  text, and the reliability matched on the 105 uploads that became a single note. Another 33
  were split into several notes, which is the limit noted above.
- **Tested on made-up data:** `server/test/ocrEvaluation.test.mjs` and
  `server/test/ocrRotation.test.mjs` are part of `npm test`, along with new cases for the second
  fix in `contentSuitability.test.mjs` and `answerImages.test.mjs`. They check the scores by
  hand-worked values, the labels, the damage, the rotation tags, the JSON repair, the resampling
  and whole runs with stand-ins for Tesseract and the model. The measurement's test needs no
  dataset, no network and no Tesseract model. The rotation test reads one fixture photo with the
  real model, and skips that part if the model is not available.

The one-off runs behind [The bugs this found](#the-bugs-this-found) (trying each fix, and looking
at the unreadable replies), the page-by-page notes and these check scripts are not in this
repository and are not part of `eval:ocr`.

Calls to the vision model: 35 before the fixes (1 small test image, 32 in the run, and 2 more on
the photo with the unreadable reply). On the fixed code, 28 photos were read and Groq refused 56
further requests. The 30 photos were sent to Groq.

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
