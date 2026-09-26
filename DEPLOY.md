# Deploying Mind Atlas

**Setup:** one **Render** web service (free) + a **MongoDB Atlas** database (free M0).

The Express API also serves the built React app, so everything lives on one
URL such as `https://mindatlas.onrender.com`. Because the browser only ever
calls its own site, no CORS setup is needed.

Why this setup:

- **Render** builds straight from the GitHub repo and redeploys on every push to `main`.
  It gives free HTTPS and a public URL, and it runs a normal long-lived Node server.
  That matters here: OCR (tesseract.js), PDF parsing and the in-memory rate
  limiter all need a real server. Serverless hosts like Vercel or Netlify
  functions are not a good fit for them.
- **MongoDB Atlas** is required in production. Without `MONGODB_URI` the app uses
  its local file database (`server/data/mindatlas-db.json`). That is fine on
  your own laptop, but Render's disk is temporary, so every account and note
  would be wiped on each redeploy.

Total cost: ₹0.

---

## 1. Create the database (MongoDB Atlas, ~5 min)

1. Sign up at https://www.mongodb.com/cloud/atlas/register.
2. **Create** a cluster, choose **M0 Free**, pick provider AWS and region **Mumbai (ap-south-1)**, then click Create.
3. **Database Access** → Add New Database User. Choose a username and password.
   Use letters and digits only in the password, so it needs no URL-escaping.
4. **Network Access** → Add IP Address → **Allow access from anywhere** (`0.0.0.0/0`).
   Render's free tier has no fixed outgoing IP, so this is required.
5. **Database** → Connect → Drivers. Copy the connection string, which looks like:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   Replace `<password>` with your real password.
   The app always uses a database named `mindatlas`, so you don't need to add a name to the string.

## 2. Push the deploy files to GitHub

This adds the new `render.yaml`, `package.json`, `Dockerfile` and `DEPLOY.md`,
plus the edits to `server/src/index.js` and `client/src/lib/api.js`:

```bash
cd D:\fy\capstone\MindAtlas
git add -A
git commit -m "Add single-service production deploy (Render + Atlas)"
git push
```

## 3. Deploy on Render (~5 min, then about 5 min of building)

1. Sign up at https://render.com using **Sign in with GitHub**.
2. **New +** → **Blueprint** → choose the `Siddhi-Karhekar/MindAtlas` repo.
3. Render reads `render.yaml` and asks for two values:
   - `MONGODB_URI`: the Atlas string from step 1.
   - `GROQ_API_KEY`: optional. Get a free key at https://console.groq.com/keys
     to turn on LLM-written questions and grading. If you leave it blank, the
     app uses its rule-based fallback.
4. Click **Apply**. `JWT_SECRET` is generated for you automatically.
5. When the status shows **Live**, open the URL Render gives you. Then sign up,
   create a subject, add notes and build a test.

You can confirm the service is up at `https://<your-app>.onrender.com/api/health`,
which should return `{"ok":true}`.

From now on, every `git push` to `main` redeploys automatically.

## Things to know

- **Cold starts (free plan):** the service sleeps after 15 minutes with no traffic.
  The next visitor then waits about 30–60 seconds while it wakes up.
  Before a demo or viva, open the site a minute early. You can also point a free
  uptime pinger such as https://uptimerobot.com at `/api/health` every 10
  minutes, or upgrade to Render's Starter plan (~$7/month) to stop it sleeping.
- **OCR:** the first image upload after each wake-up is slower, because
  tesseract downloads its English language model first.
- **Memory:** the free plan has 512 MB of RAM. That covers normal use, but very
  large PDFs or many simultaneous OCR uploads could run out.
- **Custom domain:** in Render go to Settings → Custom Domains. HTTPS is set up automatically.
- **Groq limits:** the Groq free tier is rate-limited. If it is exceeded, the app
  falls back to rule-based questions and grading on its own.

## Other hosts

The included `Dockerfile` builds the same single container. It runs on
Railway, Fly.io, Koyeb, Google Cloud Run or any VPS. Set the same environment
variables there: `NODE_ENV=production`, `JWT_SECRET` (32+ characters),
`MONGODB_URI`, `TRUST_PROXY=1`, and optionally `GROQ_API_KEY`.

If you'd rather host the frontend separately, for example on Vercel, build
the client with `VITE_API_BASE=https://<api-host>/api` and set `CORS_ORIGIN`
on the API to the frontend's URL.
