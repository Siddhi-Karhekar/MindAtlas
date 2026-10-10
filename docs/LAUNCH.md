# Before real students: what was done, what was decided, what is open

Worked through against a pre-launch checklist (product, content, technical,
team, operations). Each line says what the app does now, or why an item does
not apply. The five the checklist ranks highest before launch come first.

## The five that matter most

| Item | State |
| --- | --- |
| Sanitise rendered content | **Done and checked in a browser.** React escapes all text; the app inserts HTML in exactly one place, formulas rendered by KaTeX with `trust: false`, which escapes its input and refuses link and HTML commands. A note containing `<img src=x onerror=…>` shows it as text; a `\href{javascript:…}` in a formula is refused. The content security policy blocks any injected script on top of that. Downloads (PDF / Word) are built from text, not HTML. |
| Hosting timeouts | **Checked.** Render allows a request up to 100 minutes ([Render](https://community.render.com/t/need-to-increase-requests-timeout-of-5-minutes/4001)); it is not a serverless platform with a short cut-off. Each AI call gives up after 20 s and is tried once more, then the rules take over, so the slowest request (marking a 20-question theory paper) stays at a few minutes. The web app now waits a set time for every request (45 s; uploads 2 min, test building 2.5 min, submitting 5 min) instead of hanging; a submit that runs out of waiting sends the student to the results page, which waits for the marks. |
| Prompt versioning | **Done.** Every question, AI mark and AI-written feedback stores `promptVersion` and `model` (`services/llm.js PROMPT_VERSIONS`; bump the version when a prompt's wording changes). The admin page shows them on reported questions. |
| Delete and merge behaviour | **Defined and tested.** Editing a note recomputes its key terms and links; deleting one removes its links and mastery, and a split document's subtopics with it. Deleting a subject removes it with its notes, links, tests, attempts, results and reports. Tests and past results are snapshots: never changed by an edit or a delete. A renamed note keeps its progress history under its new name. Merging topics is not a feature, so there is nothing to break. (`services/noteLifecycle.js`, `test/noteLifecycle.test.mjs`, `test/assessment.test.mjs`.) |
| AI provider terms (under-18 users) | **Read; action needed by the team.** Groq's Services Agreement (last modified 22 June 2026): the account holder must be 18 or over; if an app is "likely to be accessed by individuals under the age of majority", the customer is **solely responsible** for following the law on minors using it and on their personal data (§6.3), and must have the consents and notices required (§6.2). Groq does not train on inputs or outputs (§4.2). ([Groq Services Agreement](https://console.groq.com/docs/legal/services-agreement)) The app sends Groq only note text and written answers, never email addresses, and tells students so (Settings → Account; the "not used for training" line appears only when the provider is Groq). **Open:** India's DPDP Act asks for verifiable parental consent for under-18s; the app has no age check or consent step yet. Decide before opening to school students: either 18+ only (a check at sign-up and in the terms), or a parental-consent flow. |

## Product

| Item | State |
| --- | --- |
| "Students only" | **A team decision, not built.** School email (accurate, excludes many colleges), student ID (manual review), or self-declaration (no friction, no proof). Whatever is chosen is a sign-up step. |
| Edge over ChatGPT / NotebookLM | Topic-tagged tests and progress over time: questions quote the notes, every question is tagged to a topic, mastery is tracked per topic across attempts, and the next test leans to weak topics. |
| Exam patterns | **Done.** Marks per MCQ and per theory question, negative marking (with "Leave blank" offered), sections (MCQs first, then theory), and three starting patterns in the test builder: quick quiz, university unit test, entrance-exam style. |
| Subject organisation | **Done.** Many subjects per student, each in an optional folder (a semester, a year), grouped on the home page. |
| Cold start | **Done.** A new student is offered a sample subject (the team's Computer Networks notes), split into topics and linked, ready for a test. |
| Retention | **Done in the app:** a streak of days with a finished test, and "worth revising next" (topics below 60 % on enough answers, or not practised for a week) on the home page. **Not done:** reminders by email - they need email turned on first (`DEPLOY.md`). |
| Feedback tone | **Done.** No "weak" labels; "the best place to focus next", "room to grow", early signs on fewer than three answers. The AI is told the same. |

## Content

| Item | State |
| --- | --- |
| Maths and science | **Formulas:** written as `$…$` / `$$…$$` they are typeset in the note view. **Not solved:** formulas, diagrams and chemical equations inside PDFs and photos still come out as plain text when read; downloads show formulas as written. |
| Photo of a handwritten answer | **Not built.** The free OCR (Tesseract) does not read handwriting reliably; marking a misread answer would be unfair. Needs a paid handwriting OCR. |
| Wrong notes | **Decided: notes are treated as the truth** - questions quote them. The app does not fact-check them; "Report this question → not from my notes / wrong answer" catches what slips through. |
| Very long uploads | **Done.** A long document becomes one note per subtopic; at most 24,000 characters of notes go to the AI per request, shared across the chosen topics (more for weak ones), every topic represented. |
| Mixed Hindi-English answers | **Done.** The AI marker is told never to mark down language; an answer mostly in another script is marked on meaning (the English word checks are skipped), bounded by the key points the AI says it covers; Hindi and Marathi requests for marks are caught like English ones. Without an AI, such an answer is marked by key-word match and can lose marks - a known limit. |

## Technical

| Item | State |
| --- | --- |
| One AI layer | `services/llm.js` only; provider and model are settings (`LLM_API_URL`, `LLM_MODEL`). |
| Double submissions | A repeated "create", "build test" or "start" still running, or finished under two seconds ago, gets the first one's answer; two submits of one attempt mark it once. |
| Indexes and pagination | Indexes for every query (`db/mongoStore.js`). Lists are per student and small; the admin lists are capped. No paging added. |
| Type checking and linting | Lint on server and client (`npm run lint`), warnings fail the build. No TypeScript: converting is a project of its own. |
| Secrets in Git history | Searched before; nothing found. `gitleaks` scans every push. |
| Logs | Error logs carry no note text, answers or email addresses (`services/log.js`); checked by a test. |
| Exam-season spikes | `npm run load-test` (server). Run on one laptop core: 50 students taking tests nonstop for 40 s → 280 requests a second, no errors, answers in 150 ms median / 270 ms at the 95th percentile. **Finding:** 50 sign-ups at once took 4.5 s each, because password hashing (bcryptjs, pure JavaScript) shares the single core. On Render's free plan (a fraction of a core) a sign-in burst before an exam will be slow. Options: a paid instance, or a native bcrypt in a worker thread. |

## Team and code

| Item | State |
| --- | --- |
| Branches and reviews | Already the way of working (`CONTRIBUTING.md`); CI must be green to merge. |
| Refactor | Dead code found by the linter removed; more is a scheduled job for the team. |
| Documentation | `README.md`, [`ARCHITECTURE.md`](ARCHITECTURE.md), [`ASSESSMENT.md`](ASSESSMENT.md), [`SECURITY.md`](SECURITY.md), [`EVALUATION.md`](EVALUATION.md). |
| Rollback | Two-minute steps in [`DEPLOY.md`](../DEPLOY.md#rolling-back-a-bad-deploy-2-minutes). |

## Operations

| Item | State |
| --- | --- |
| Admin panel | **Done, minimal:** `/admin` for accounts in `ADMIN_USER_IDS` - reported questions (with answer key, the passage they came from, prompt and model, and reporters' comments - never who reported), suspend / restore an account (logged with a reason), sign-up numbers. No other notes or answers. |
| Abuse | Rate limits per student and per address; sign-up limits; suspension. The app has no free-form chat, so it cannot be used as a free chatbot. |
| Payments | Does not apply: the app takes no payments. |
| Storage per student | Only note text is stored (never files), capped at 2,000 notes / 30 million characters per student. |
| Support channel | `SUPPORT_EMAIL`, shown on the sign-in and Settings pages. **Open:** name the address, and a grievance officer in the privacy policy. |
| Accessibility | Strong / weak never by colour alone: every score has its number, trends say "up 12 points", rings are labelled for screen readers. |
| Product metrics | Admin page: of students who joined in the last 90 days, how many added a note and finished a test in week 1, and came back in week 2. Only dates and a flag are stored for this. |

## Still open (decisions, not code)

1. Age: 18+ only, or a parental-consent flow (DPDP Act; Groq §6.3).
2. A privacy policy and terms (what is stored, the AI service, copyright of uploads, a grievance contact).
3. "Students only": which check, if any.
4. Email (for reminders, confirmation and password reset): set the `SMTP_*` settings.
5. A closed beta with 20-30 real students before opening up.
