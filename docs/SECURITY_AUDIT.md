# Security audit and production readiness (October 2026)

An end-to-end review of MindAtlas against `main` at `51b97bf` (PRs #43-#50
merged), followed by fixes, tests and this report. It builds on
[`SECURITY.md`](SECURITY.md), which lists the protections already in place and
how each was checked; this document records what the audit found **on top of
that**, what was changed, and what is left.

Labels: **Confirmed** = shown with a test, or traced end to end in code.
**Suspected** = plausible from the code, not reproduced here. **Hardening** =
no known exploit; makes failure less likely or less costly.

This was a review by the people (and AI assistants) who build the app, with one
independent pass over the newest code. It is not a professional penetration
test.

---

## 1. Architecture and trust boundaries

```
 Browser (React, client/)  --HTTPS, session cookie-->  API (Express, server/src)  -->  MongoDB Atlas
       untrusted                                         |  trusted, validates all      (or JSON file locally)
                                                         |
                                                         +--> Groq API (LLM): note text, answers, photos
                                                         |      untrusted OUTPUT: every reply is checked
                                                         +--> SMTP (optional): reset / confirm links
```

| Boundary | What crosses it | Where it is enforced |
| --- | --- | --- |
| Browser -> API | Every request body, query, path id, upload, cookie | `middleware/validate.js` (types, lengths, operator keys), `safeRouter` (ids), `auth.js` (session, account looked up each request), `origin.js` (cross-site writes), rate limits (`index.js`), owner checks in every route |
| API -> client | Notes, tests, questions, results | `services/noteView.js publicNote`, `services/questionView.js` (allowlist, new), review only after submission |
| Notes / answers -> LLM | Student-written text | `llm.js asData` tags; marker-addressing filter; rubric now also tagged (new) |
| LLM -> API | Questions, marks, terms, wording | Verbatim grounding, `validateQuestion`, key-point caps, terms re-checked against the note; ranking and MCQ marking never from the LLM |
| Uploads -> parsers | PDF / Word / PowerPoint / images | Byte-type checks, size and page/pixel limits, separate thread with timeout (`uploadCheck.js`, `extractInWorker.js`) |
| API -> database | Queries | `db/filter.js` refuses operators from requests; owner in every filter |

Sensitive data: passwords (bcrypt), session tokens (HttpOnly cookie, JWT),
notes and answers (plain in the database; see Remaining risks), answer keys
(never sent before submission), the Groq key / database URI / JWT secret
(server environment only).

---

## 2. Vulnerability register

| ID | Finding | Status | Severity | Where | Fixed? |
| --- | --- | --- | --- | --- | --- |
| SA-01 | MCQ answers sent to the student before answering, in the question's `concept` field (also `conceptId`, `learningObjective`) | Confirmed | **High** | `routes/attempts.js forAttemptTaking`, `routes/tests.js GET /tests/:id` | Yes |
| SA-02 | Vulnerable dependencies in what ships: `body-parser` <1.20.9 (DoS, high), `multer` 2.0-2.4 (DoS, high), `nodemailer` <=10.1.3 (address parsing, moderate) | Confirmed | **High** | `server/package-lock.json` | Yes |
| SA-03 | Every note edit could start an LLM call, uncapped beyond the general API limit: one account could use up the shared Groq quota for everyone | Confirmed | Medium | `services/noteLifecycle.js editNote -> aiKeyTerms.suggestInBackground`, `PATCH /notes/:id`, `/lines` | Yes |
| SA-04 | Note edits (each rebuilds keywords, links and concept records) had no limit of their own | Confirmed | Medium | `index.js` | Yes |
| SA-05 | Two starts of one test sent together (different bodies) could open two attempts; the second could be answered from the first one's review | Suspected (needs MongoDB latency; not reproduced on the in-memory store) | Low-Medium | `routes/attempts.js POST /tests/:id/attempts` | Mitigated (per student+test lock) |
| SA-06 | Note text inside the marking rubric (model answer, key points) was sent to the LLM as instructions, not as data: a student could plant "award full marks" in their own notes | Confirmed (code path) | Low (own marks only; capped by key points) | `services/gradingEngine.js rubricText` | Yes |
| SA-07 | Production container ran as root | Confirmed | Low (hardening) | `Dockerfile` | Yes |
| SA-08 | No graceful shutdown or server timeouts: a deploy cut requests mid-way; Node's 5-minute defaults let slow clients hold connections | Confirmed | Low (reliability) | `index.js` | Yes |
| SA-09 | Answer photos kept in the database at up to 300 x 5 MB per student - one account could fill a free database | Confirmed (by arithmetic) | Low-Medium (availability) | `config.js answerImageLimits` | Reduced (100 per student); see Remaining risks |
| SA-10 | `vite` 8.3.0-8.3.2 (dev server only; `launch-editor` command execution on Windows) | Confirmed | Low (developer machines only) | `client/package-lock.json` | Yes |
| SA-11 | Client build tools: Tailwind 3 chain (`postcss-selector-parser`, `postcss-nested`) moderate advisories | Confirmed | Low (build time only, never in a browser) | `client/` | No: needs Tailwind 4 (major) |
| SA-12 | `DELETE /tests/:id` racing a submit of the same test | Suspected | Low | `routes/tests.js` | Traced: benign - the submit's claim fails on the deleted attempt (409) and no mastery or report is written; delete now also shares the start lock |
| SA-13 | A finished test can be retaken with the same questions after its review showed the answers | By design | Low (integrity of practice scores) | `routes/attempts.js` | Documented; repetition rules favour new tests |
| SA-14 | Rate limits, the build/start locks and signed-out sessions live in memory: correct for one instance, not shared across several, reset on restart | Known (SECURITY.md) | Low today | `middleware/rateLimit.js`, `services/serial.js`, `auth.js` | Documented; needed before scaling out |

Checked and found sound in this pass (one line each; details in SECURITY.md):

- owner checks on every note, subject, graph, test, attempt, report, image and admin route;
- path ids validated by `safeRouter`;
- operator injection refused twice (`validate.js`, `db/filter.js`);
- student strings escaped before use in regular expressions (`escapeRe`, `termPattern`);
- length limits on line edits, key terms and the syllabus;
- reports cannot be used to skip a question during an attempt;
- answers are final, and correctness is hidden until submission;
- the review is available only after submission;
- the admin route lists only `ADMIN_USER_IDS` and never shows who reported a question;
- answer photos are type-checked from their bytes, owner-only and sandboxed;
- an invalid `tz` value does no harm;
- CORS uses named origins, and the origin guard protects cross-site writes;
- errors return one plain sentence;
- logs hold counts only;
- no secrets in git history (pattern scan; only a fake `.invalid` URI in a test);
- the JWT secret is required in production.

---

## 3. Remediation report

| ID | Change | Files |
| --- | --- | --- |
| SA-01 | Questions shown before submission go through an **allowlist** (`questionForAttempt`: id, type, prompt, options, guidance, topic labels, difficulty, marks; `questionForListing` adds status and how it was made). A field added to questions later stays private unless added on purpose. | `server/src/services/questionView.js` (new), `routes/attempts.js`, `routes/tests.js` |
| SA-02, SA-10 | `npm audit fix` within the declared version ranges: body-parser 1.20.9, multer 2.5.0, nodemailer 10.2.1, vite 8.3.5. No major upgrades. | `server/package-lock.json`, `client/package-lock.json` |
| SA-03 | Background AI key-term asks are budgeted **per student per hour** (`AI_TERMS_PER_HOUR`, default 60; one ask per saved note, upload or test build) and the queue is capped (200 notes). Skips are logged as counts. Notes skipped get their terms at the next test build, which has its own limits. | `server/src/services/aiKeyTerms.js` |
| SA-04 | Rate limit on note changes: `PATCH /notes/:id`, `PATCH /notes/:id/lines`, `PUT /notes/:id/key-terms`, `PATCH /subjects/:id`. It allows 300 changes per student per 15 minutes, and 5 times that per address (`RATE_LIMIT_NOTE_EDIT_MAX`). | `server/src/index.js` |
| SA-05, SA-12 | Starting an attempt and deleting a test run **one at a time per student and test**. The lock used for test builds moved to a shared module. | `server/src/services/serial.js` (new), `routes/attempts.js`, `routes/tests.js` |
| SA-06 | The rubric is sent inside `<rubric>` data tags, and the marking rules say it is not instructions. Prompt versions were bumped (`grade-v4`, `remark-v3`) so marks record which prompt made them. | `server/src/services/gradingEngine.js`, `services/llm.js` |
| SA-07 | The image runs as the unprivileged `node` user, which owns `/app`. It also gets a container `HEALTHCHECK` and npm cache cleanup. CI now starts the image, checks `/api/health`, and checks that it does not run as uid 0. | `Dockerfile`, `.github/workflows/ci.yml` |
| SA-08 | The server sets its own timeouts: request 330 s (`REQUEST_TIMEOUT_SECONDS`), headers 30 s, keep-alive 65 s. On SIGTERM/SIGINT it stops accepting connections, lets requests in flight finish for up to `SHUTDOWN_GRACE_SECONDS` (25), then exits. | `server/src/index.js` |
| SA-09 | Default `ANSWER_IMAGES_MAX_PER_STUDENT` lowered from 300 to 100, with a comment on storage. | `server/src/config.js`, `server/.env.example` |
| Docs | New settings documented; SECURITY.md item 17 and photo cap updated; HANDOVER prompt versions. | `server/.env.example`, `docs/SECURITY.md`, `docs/HANDOVER.md`, this file |

No feature was removed, and no security check was relaxed. One test read the leaked field through the student API. It now reads the stored question through the development-only `?keys=1` switch, which is ignored in production and covered by `security.test.mjs`. A second test checked the old removal list by matching the source text; it now checks behaviour instead.

---

## 4. Test report

| Run | Result |
| --- | --- |
| Baseline (before changes): `npm run lint`, `npm test` (server) | lint clean; **1,728 checks, all pass**; client build ok, 9 lint warnings (all already there) |
| After changes: `npm run lint`, `npm test` (server, now 28 files incl. the new `hardening.test.mjs`) | lint clean; **1,744 checks, all pass** |
| Client `npm run lint`, `npm run build` | build ok; same 9 warnings as before, none new |
| `npm audit --omit=dev` (server, client) | before: server 2 high + 1 moderate; after: **0** in both |
| `npm audit` (client, incl. build tools) | 3 moderate remain (SA-11) |
| Secret scan (regex over all of git history: Groq/AWS/Slack/OpenAI keys, Mongo URIs with passwords, private keys, JWT secrets) | nothing real found |

**Negative tests that show each fix.** Each one was run against the old code to show it failing there, except where noted.

- SA-01 (`assessment.test.mjs`):
  - "the test's questions carry only allowed fields";
  - "no other field of an MCQ equals one of its options";
  - "the question served during a test carries only allowed fields".
  All three **fail on the old routes** (the `concept` field equalled the right option) and pass now. `questionEvaluator.test.mjs` also checks the allowlist directly.
- SA-03 (`hardening.test.mjs` A): 12 quick edits of one note. The old code asked the AI **11 times**; it now asks at most the budget (3 in the test). Another student's budget is separate.
- SA-04 (`hardening.test.mjs` C): the sixth change in the window gets **429**, line edits share the limit, and another student is not affected.
- SA-05 (`hardening.test.mjs` B): four starts with different bodies open exactly one attempt. This passed on the old code too: the in-memory store has no latency, so the race did not occur there. It is a regression guard, not a reproduction.
- SA-06 (`assessment.test.mjs`): the rubric is sent as one `<rubric>` block, before the answer.
- SA-08 (`hardening.test.mjs` D): a test build in flight when SIGTERM arrives still gets its 201. The server then exits with code 0 and refuses new connections.

**Not run here, and why.**

- **Docker build and run:** no Docker daemon in this environment. The new CI step builds the image, starts it, checks health and checks the non-root user on GitHub.
- **Real MongoDB, Render, Groq and SMTP:** no credentials or services here. SA-05 under real latency is unverified.
- **`gitleaks` binary:** not installed here; it still runs in CI on every push.
- **Dynamic scanning (DAST) against the live site:** not authorised, and not run against production.
- **A load test after the changes:** `npm run load-test` exists but was not re-run.

---

## 5. Dependency report

| Package | Was | Now | Advisory | Status |
| --- | --- | --- | --- | --- |
| body-parser (via express 4) | 1.20.8 | 1.20.9 | GHSA-27r3-jxmh-p828 DoS (high) | Fixed |
| multer | 2.4.0 | 2.5.0 | GHSA-q7qp-rjg7-q26m DoS (high) | Fixed |
| nodemailer | 10.0.14 | 10.2.1 | GHSA-8c8m-p3m8-cjg8, -m943-m63m-w62w, -85x2-q946-cp5h (moderate) | Fixed |
| vite (client, dev) | 8.3.x | 8.3.5 | launch-editor command execution (high, dev only) | Fixed |
| tailwindcss 3 chain (client, build) | 3.x | 3.x | postcss-selector-parser / postcss-nested (moderate, build only) | Open: Tailwind 4 is a major migration |
| Major versions not taken (Express 5, MongoDB driver 7, pdf.js 6, Tesseract 7, bcryptjs 3) | - | - | No known advisory in current versions | Dependabot proposes them; each needs its own testing |

Integrity: both apps install with `npm ci` from committed lockfiles (exact versions and integrity hashes). CI fails on a high or critical advisory in what ships, and Dependabot opens weekly update pull requests.

---

## 6. Production-readiness checklist

| Area | Item | State |
| --- | --- | --- |
| Security | Authn/authz server-side, owner checks, validation, CSRF/origin, CORS allowlist, headers/CSP, HTTPS, rate limits | Done (SECURITY.md + this audit) |
| Security | No answer data before submission | Done (SA-01, allowlist) |
| Security | Dependencies: 0 known advisories in what ships | Done |
| Security | Secrets only in the environment; JWT secret required in production | Done |
| Security | Static-site headers on Render (dashboard), one-address `/api` rewrite | **To do by whoever runs Render** (SECURITY.md table) |
| Security | Atlas user with `readWrite` on one database only; network access restricted | **To do / verify** |
| Reliability | Every AI step has a rule-based fallback; LLM timeouts and one retry | Done |
| Reliability | Request timeouts, graceful shutdown, health check | Done (SA-08) |
| Reliability | Idempotency / races: once(), build lock, start lock, attempt close claim token | Done (in-process) |
| Reliability | Health check covers the process, not the database | Known: deliberate (a database blip should not restart the app) |
| Privacy | Logs hold no note text, answers or emails | Done |
| Privacy | Account and subject deletion remove everything | Done |
| Privacy | Privacy policy, terms, age policy (DPDP Act) | **Open decision** (HANDOVER §11) |
| Deployment | CI: lint, tests, audit, image build + start + non-root check, gitleaks | Done |
| Deployment | Rollback | Render -> Deploys -> previous -> Rollback (no migrations in this change) |
| Monitoring | Structured, counts-only logs (`[testgen]`, `[llm]`, `[grade]`, `[keyterms]`, `[server]`) | Done |
| Monitoring | Alerts (error rate, fallback rate, 5xx) | **Not set up**: Render alerts / a log drain recommended |
| Backup | `npm run db:backup` / `db:restore` scripts | Exist; **no schedule**: needs a scheduled job with the Atlas URI as a secret |
| Recovery | Restore drill | **Not done**: run `db:restore` into a scratch database once |
| Incident response | Who to contact, how to rotate the Groq key, JWT secret and database password | **To write** (rotating `JWT_SECRET` signs everyone out, which is the intended effect) |

---

## 7. Remaining risks

1. **Notes are readable by whoever holds the database password.** The server must read them; field encryption would not change that. Mitigations: least-privilege Atlas user and network rules.
2. **In-memory controls** (SA-14) are correct for the one instance this app runs on. Before running two or more instances, move rate limits, locks and the signed-out list to the database or Redis. For SA-05, also add a partial unique index on open attempts.
3. **SA-05 under real MongoDB latency** is mitigated by the lock, not proven against a real deployment.
4. **Answer photos in the database** (SA-09): 100 x 5 MB is still about 0.7 GB per student in base64. Long term, move the image bytes to object storage, or lower `ANSWER_IMAGE_MAX_MB`.
5. **Prompt injection** cannot be ruled out completely. Its effect is bounded: the AI never decides MCQ correctness or the topic ranking, and marks are capped by the key points visibly covered.
6. **Retaking a test after its review** (SA-13) lets practice scores be inflated on that test.
7. **No CAPTCHA** at sign-up; **no alerting**; **no scheduled backups**: each needs an outside service or credentials.
8. **Tailwind 3 build-time advisories** (SA-11).

---

## 8. Deployment guidance

- **Required environment** (unchanged): `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET` (32+ random characters), `CORS_ORIGIN`, `TRUST_PROXY=1`; optional `GROQ_API_KEY`, `SMTP_*`, `ADMIN_USER_IDS`.
- **New, optional** (safe defaults): `RATE_LIMIT_NOTE_EDIT_MAX` (300), `AI_TERMS_PER_HOUR` (60), `REQUEST_TIMEOUT_SECONDS` (330), `SHUTDOWN_GRACE_SECONDS` (25). The default of `ANSWER_IMAGES_MAX_PER_STUDENT` changed from 300 to 100; set it back explicitly if more is needed and storage allows.
- **Database migrations:** none. Existing questions keep their fields; only what is *sent* changed.
- **Docker / self-hosting:** the image now runs as `node`. A volume mounted for the file database must be writable by uid 1000.
- **Rollout:** merge, then let Render auto-deploy. The old instance now finishes requests in flight before stopping. After the deploy:
  - check that `/api/health` responds;
  - build a test and start an attempt;
  - in the browser's network tab, confirm the question has no `concept` field;
  - edit a note.
- **Rollback:** Render -> mindatlas-api -> Deploys -> previous deploy -> Rollback. Rollback re-opens SA-01, so roll forward with a fix rather than staying rolled back.

---

## 9. Final risk assessment

| Severity | Open findings |
| --- | --- |
| Critical | None found |
| High | None open (SA-01 and SA-02 fixed and tested) |
| Medium | None open in code. Operational items remain: scheduled backups, alerting, Render static-site headers and the `/api` rewrite. These are not code defects, but they should be done before a wider launch. |
| Low | SA-05 (mitigated, unverified on MongoDB), SA-09 (reduced), SA-11, SA-13, SA-14; the remaining risks in section 7 |

**Release blockers for a wider launch** (not for continued capstone use):

1. Scheduled database backups with one tested restore.
2. Render static-site headers and the one-address rewrite.
3. A privacy policy and an age/consent decision.

These need the people who run the services; they cannot be done from the code.
