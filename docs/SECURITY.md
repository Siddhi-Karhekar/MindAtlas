# Security

What protects a student's account and notes, where each protection lives in
the code, what is checked by a test, and what is **not** covered. Written
against two checklists the team was given: 20 things to do before launch and
20 ways apps get broken into.

Checks: `server/test/security.test.mjs` (part of `npm test`).

## What still needs someone to do something

Nothing here breaks the app if left undone. Each item makes something better.

| Who | What | Why |
| --- | --- | --- |
| Whoever runs the Render services | **Turn on email**: on `mindatlas-api` set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` and `APP_URL=https://mindatlas.onrender.com`. A Gmail account with an "app password" (smtp.gmail.com, port 465) or a free Brevo account works. | Until then there is no email confirmation and no "Forgot password?". The code is in place and switches itself on. |
| Same | **Put the client and the API on one address**: on the `mindatlas` static site add a rewrite `/api/*` -> `https://mindatlas-api.onrender.com/api/*` **above** the existing `/*` -> `/index.html` rule, change `VITE_API_BASE` to `/api`, redeploy. Then check that signing in still works and that `/api/health` loads from `mindatlas.onrender.com`. | The session cookie then belongs to the page's own site, which every browser accepts. As deployed today (two addresses) Chrome, Edge and Firefox accept it; a browser that refuses it (Safari may) keeps the student signed in only until the page is reloaded. **Not tested by us**: it needs the real Render services. After the change, confirm rate limits still see each visitor's own address (`TRUST_PROXY`). |
| Same | **Headers on the static site** (Render dashboard -> Headers, path `/*`): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=31536000`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. | The API sends these itself. A static host only sends what it is told to. The content security policy is already inside the built page. |
| Same | **MongoDB Atlas**: the database user in `MONGODB_URI` should have "readWrite" on the `mindatlas` database only, not an admin role; restrict Network Access as far as Render allows. | If the connection string ever leaks, it limits what can be done with it. |
| Everyone | Run `npm install` in `server/` and `client/` after pulling. | New package: `nodemailer`. Updated: `express`, `multer`, others within their ranges. |

## Checklist 1: things to have before launch

| # | Item | State | Where / how |
| --- | --- | --- | --- |
| 1 | Hide API keys | Was already so | The Groq key, the database address and the signing secret exist only in the server's environment. The client is built with one setting, the API's address. |
| 2 | Purge Git secrets | Nothing to purge | Every commit on every branch was searched for keys, connection strings and `.env` files: only placeholders. `gitleaks` runs in CI on every push. |
| 3 | Use public DB key | Does not apply | That is advice for apps whose browser code talks to the database directly. Here only the server does. See the Atlas row above for the equivalent. |
| 4 | Row-level security | Done in server code | MongoDB has no such feature. Every route looks records up by id **and** owner (or checks the owner of what it loaded). Tested: a second student tries 19 actions on the first one's subject, notes, links, test and attempt; every one answers "not found". |
| 5 | Encrypt sensitive data | Partly, by design | Passwords: bcrypt hashes. Emailed links: only their SHA-256 hash is stored. In transit: HTTPS only (item 19). At rest: Atlas encrypts its storage. **Not done**: notes are not encrypted by the app itself, because the server has to read them to split, link and question them. Anyone with the database password can read notes. |
| 6 | Enforce server-side auth | Done | Every route except sign-in/sign-up and the health page requires a session, and the account is looked up on every request (`middleware/auth.js`): a deleted account, or one whose password changed, is refused at once. |
| 7 | Lock record access | Done | Same as 4. |
| 8 | Block field tampering | Done | Each route takes named fields from a request, each checked for type and range; nothing else reaches the database. Tested: `ownerId`, `_id`, `role`, `emailVerified`, `score`, `isCorrect` and `targetQuestionCount` sent by a client are ignored. |
| 9 | Secure session cookies | Done | `HttpOnly`, `Secure` and `__Host-` over HTTPS, `SameSite=Lax` (or `None; Partitioned` to a client on another address). Signing out retires the session. Changing or resetting the password ends every other session. |
| 10 | Hash passwords | Was already so | bcrypt. The cost is now a setting (`BCRYPT_ROUNDS`, default 10, the accepted minimum; the free hosting CPU is slow) and old hashes are upgraded at the next sign-in. |
| 11 | Rate limit login | Done | Per address: 60 password-taking requests per 15 minutes. Per account: 5 wrong passwords from one address locks that pair for 15 minutes; 100 from anywhere locks the account for 15 minutes (`services/loginThrottle.js`). |
| 12 | Bot protection | Partly | A hidden form field, a signed single-use challenge that must be at least 2 seconds old, 40 sign-ups per address per hour, and email confirmation once email is on (`services/signupChallenge.js`). **Not done**: a CAPTCHA. It needs an outside service (Cloudflare Turnstile is free); say if you want it. |
| 13 | Parameterize queries | Done | There is no SQL. The MongoDB equivalent is an operator smuggled into a query (`{"email": {"$ne": null}}`). Refused twice: in the request (`middleware/validate.js`) and again where queries are built (`db/filter.js`). |
| 14 | Validate all input | Done | Type, length and range on every field of every route; ids must be ids; one JSON object per request. Before this, a password sent as an object **crashed the server** for everyone, with no account needed. |
| 15 | Escape user content | Was already so | React escapes everything it shows; the code has no raw-HTML insertion. New: a content security policy that refuses any injected script. Tested in a browser. |
| 16 | Restrict file uploads | Done | The file's bytes must match its name; one file; 10 MB; Word/PowerPoint files are unpacked and counted (150 MB limit) before being read; pictures over 50 megapixels or with no readable size are refused; PDFs over 400 pages are refused; reading happens on a separate thread stopped after 25 seconds (`services/uploadCheck.js`, `services/extractInWorker.js`). |
| 16b | Prompt injection (not on the list) | Done, with a limit | Notes and answers are student text sent to the LLM. Instructions go in the system message and the text goes in as tagged data; an answer written to the marker is not sent to the LLM; an LLM mark is capped by the key points the answer actually mentions; the LLM never decides correctness of an MCQ or the topic ranking. Details and the limit: [`docs/ASSESSMENT.md`](ASSESSMENT.md). |
| 16c | Admin panel (not on the list) | Done, locked down | `/admin` only for account ids in `ADMIN_USER_IDS` (ids, not email addresses: an address can be signed up by someone else first). Everyone else gets "not found". A reported question is shown with its answer key and the passage of notes it came from, never who reported it; no other notes or answers; suspensions are logged with a reason (`admin_log`); a suspended account's sessions end at once and it cannot sign in. |
| 16d | Logs (not on the list) | Done | Error logs carry no note text, answers or email addresses (`services/log.js`); a test checks the server's log. |
| 17 | Trim API responses | Done | No password hash, owner id or internal vector in any answer. A test's questions are sent without their answers; before this, a student could fetch the answer keys of their own test before sitting it. |
| 18 | Security headers | Done on the API | `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Cache-Control: no-store` (`middleware/securityHeaders.js`). The static site needs the dashboard step above. |
| 19 | Force HTTPS | Done | In production a page asked for over HTTP is redirected and anything else is refused; HSTS for a year. Render also redirects at its edge. |
| 20 | Scan dependencies | Done | CI fails on a high or critical advisory in what ships (was already so). New: Dependabot opens update pull requests weekly (`.github/dependabot.yml`). Today: 0 known vulnerabilities in what ships. The client's build tools (Tailwind 3 and what it uses) carry 5 "high" advisories with no fix short of moving to Tailwind 4; they run only when building, never in a visitor's browser. |

## Checklist 2: ways to get hacked

| # | Item | State |
| --- | --- | --- |
| 1 | `.env` file in GitHub | Not there, never was; git-ignored. |
| 2 | API keys in frontend | None. |
| 3 | No row-level security | See 4 above. |
| 4 | Permissions decided in the frontend | The server decides everything; the client only hides what would be refused anyway. Tested by calling the API directly as another student. |
| 5 | No rate limiting | Limits on the whole API (per student), on passwords (per address and per account), sign-ups, reset emails, test builds, downloads and uploads. |
| 6 | SQL string concatenation | No SQL; see 13 above. |
| 7 | No input validation | See 14 above. |
| 8 | User content as raw HTML | Never; see 15 above. |
| 9 | Plain-text passwords | bcrypt hashes. |
| 10 | Auth in localStorage | Removed. The session is in an `HttpOnly` cookie. A session from before the change is moved into the cookie once and deleted from localStorage. |
| 11 | Unauthenticated admin panel | There is no admin panel and no debug route. The health page says what is on and off and nothing else. The one development switch (`TEST_REVEAL_KEYS`) is ignored in production. |
| 12 | CORS set to `*` | Named addresses only (`CORS_ORIGIN`); nobody in production if unset. |
| 13 | No email verification | Built; off until the server can send email (first row of the first table). Accounts made before it was on are left alone. |
| 14 | Predictable ids | Record ids are 96 random bits; emailed tokens 256. |
| 15 | Saving the whole request body | Never; see 8 above. |
| 16 | No signature check on webhooks | The app receives no webhooks. |
| 17 | Stack traces in production | Every error is answered with one plain sentence; details go to the server log only. |
| 18 | Outdated dependencies | Updated within their version ranges. **Not done**: the major jumps (Express 5, MongoDB driver 7, pdf.js 6, Tesseract 7, Tailwind 4, bcryptjs 3), which change behaviour and need their own testing. Dependabot will propose them. |
| 19 | No password strength rule | At least 10 characters; not a common password however dressed up ("Password@123"); not only digits; not the email name; at most 72 characters. Applies to new passwords; existing accounts sign in as before. |
| 20 | No file upload validation | See 16 above. |

## How it was checked

- `npm test`: 920 checks, 180 of them in `security.test.mjs`. That file runs
  the real server twice, once as in development and once as in production with
  a stand-in mail server.
- The tests were confirmed to fail with the protections removed (the origin
  check, the async error handling).
- A browser run of sign-up, the confirmation link, password reset, password
  change, sign-out, the fallback when a cookie is refused, and every page under
  the content security policy.
- A second, independent review of the changes, whose findings (three ways a
  crafted upload could stall or exhaust the server, and smaller ones) were
  fixed and are covered by tests.

## What is not covered

- **Never run against the real services.** Render, a real mail provider, a
  real MongoDB and Safari were not available to test with. The MongoDB-only
  parts are the unique index on email addresses and the same code under real
  network delay.
- **Limits live in memory.** Rate limits, wrong-password counts and the list
  of signed-out sessions are per server process: a restart clears them, and
  they would not be shared between two instances.
- **The account-wide lock can be used against a student**: 100 wrong passwords
  from many addresses lock their sign-in for 15 minutes. It is the price of
  stopping a spread-out guessing attack.
- **Sign-up says whether an address already has an account.** "Forgot
  password" does not.
- **The slide reader is slow on a hostile file.** It is contained (separate
  thread, 25 seconds, two at a time) rather than rewritten.
- **Notes are readable by whoever holds the database password** (item 5).
- **No CAPTCHA** (item 12). **The Docker image runs as root.**
- This was a review by the people who wrote the code, plus one independent
  pass. It is not a professional penetration test.

## Settings

All optional; the defaults are the safe ones. See `server/.env.example`.

`SMTP_*`, `MAIL_FROM`, `APP_URL`, `EMAIL_MODE=log` (development) ·
`BCRYPT_ROUNDS` · `SIGNUP_CHALLENGE` · `FORCE_HTTPS` · `LOGIN_MAX_FAILURES`,
`LOGIN_MAX_FAILURES_ACCOUNT` · `RATE_LIMIT_*` · `EXTRACT_TIMEOUT_SECONDS`,
`EXTRACT_MAX_HEAP_MB` · `TRUST_PROXY` · `CORS_ORIGIN` · `TEST_REVEAL_KEYS`
(development) · `ATTEMPT_GRACE_SECONDS` · `LLM_TIMEOUT_MS`.
