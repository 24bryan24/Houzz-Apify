# Houzz Project Uploader (Apify actor)

Adds your previous work — photos plus titles, locations, and descriptions — to the **Projects** section of your Houzz professional profile, in bulk. Built to be driven from **Make.com**: you feed it a batch of projects as JSON, it logs in once, uploads everything, and reports per-project results back to the run's dataset.

## How it works

1. **One run = one batch.** The actor opens a single browser, authenticates once, then loops over every project in the input: downloads its photos, opens your Houzz "Add Project" page, attaches the photos, fills in title/location/description, and publishes.
2. **Results go to the dataset.** Each project produces one dataset item: `{ title, status: "ok" | "failed" | "dry-run", photosUploaded, projectUrl, error }`. Make.com reads these back with the *Get Dataset Items* module.
3. **Auth without password pain.** The recommended mode injects session cookies you export once from your own logged-in browser — no password stored, and Houzz's login screen is skipped entirely. A fallback email+password mode exists (credentials live as secret actor env vars, never in Make).

## Deploy to Apify (one time)

**Option A — Apify CLI (fastest):**

```bash
npm install -g apify-cli
cd houzz-project-uploader
apify login        # opens a browser to connect your Apify account
apify push         # uploads the actor; name comes from .actor/actor.json
```

**Option B — GitHub:** push this folder to a repo, then in Apify Console go to *Actors → Create new → Link Git repository*. Apify builds it with the included Dockerfile.

After deploy, open the actor in Apify Console → **Settings → Integrations → Environment variables** and add secrets (values are encrypted; reference them with the `@` syntax already wired in `.actor/actor.json`):

| Variable | Required when | How to get it |
|---|---|---|
| `HOUZZ_COOKIES_JSON` | `authMode: "cookies"` (recommended) | See "Exporting your Houzz cookies" below |
| `HOUZZ_EMAIL` | `authMode: "login"` | Your Houzz login email |
| `HOUZZ_PASSWORD` | `authMode: "login"` | Your Houzz password |

### Exporting your Houzz cookies (2 minutes, do it once)

1. In Chrome/Edge, log into houzz.com normally (complete any verification yourself).
2. Install a cookie-export extension (e.g. "EditThisCookie" or "Cookie-Editor").
3. With houzz.com open, use the extension to **export all cookies as JSON** (array format).
4. In Apify Console, save that JSON array as the secret `houzzCookiesJson`. The actor reads it via the `HOUZZ_COOKIES_JSON` env var — it never appears in run inputs, logs, or the dataset.

After the first successful run the actor also stores the working session itself, so later runs can reuse it without you exporting again (`reuseStoredCookies`, on by default).

### Get your "Add Project" URL (1 minute, do it once)

In your own browser, logged into Houzz: open your professional profile → **Projects** → click **Add Project** (or *Add a project*). Copy the URL of that page and paste it into the actor input as `addProjectUrl`. The actor starts every upload from that page.

## Make.com setup

### What you need

- The Apify app in Make (search "Apify" when adding a module). Connect it with your Apify API token (Apify Console → *Settings → API & Integrations*).
- Your projects data: an array of `{ title, city, state, description, photoUrls[] }`. Source it however you like — a Google Sheet, Airtable, Data Store, or a hardcoded JSON block.
- Photo URLs must be **directly downloadable** (the actor fetches them server-side). For Google Drive files, convert a share link to: `https://drive.google.com/uc?export=download&id=FILE_ID` (the file must be shared as "Anyone with the link").

### Recommended scenario (async — handles large batches)

Apify caps synchronous runs at ~300s and Make has its own per-module timeout, so for more than a handful of projects use the async pattern:

**Scenario 1 — "Upload Houzz projects":**
1. Your data source (Sheets/Airtable/…) → **Array Aggregator** → builds the `projects` array.
2. **Apify → Run an Actor**: select `houzz-project-uploader`, turn **Run synchronously OFF**, paste the input JSON (see below). This returns immediately with a run ID.

**Scenario 2 — "Collect Houzz upload results":**
1. **Apify → Watch Actor Runs** (instant trigger): select the actor; fires when each run finishes.
2. **Apify → Get Dataset Items**: feed it the `defaultDatasetId` from the trigger. You now have one item per project with `status`, `projectUrl`, and any `error` — route failures to a notification or a retry queue.

### Small-batch alternative (sync)

If you're uploading ~1–5 projects at a time, you can keep **Run synchronously ON** in a single scenario and read the dataset right after with *Get Dataset Items*. If runs start timing out, switch to the async pattern above.

### Input JSON example

Map your variables into this shape in the *Run an Actor* module:

```json
{
  "authMode": "cookies",
  "addProjectUrl": "https://www.houzz.com/.../add-project",
  "dryRun": true,
  "maxPhotosPerProject": 10,
  "projects": [
    {
      "title": "CATHY TAYLOR — Window Treatment Install",
      "location": "18966",
      "year": "2026",
      "keywords": "cellular shades, cordless, blackout",
      "description": "Install completed September 30, 2026 (1h 5m). Job 86e3f83vm.",
      "photoUrls": [
        "https://drive.google.com/uc?export=download&id=1AbC2dEfGh...",
        "https://drive.google.com/uc?export=download&id=3IjK4lMnOp..."
      ]
    }
  ]
}
```

If you're feeding this from an existing scenario (e.g. the Blinds To Go job pipeline), map its output bundle straight in:

- `title` ← `{{task_name}} — Window Treatment Install` (or include `{{appointment_type}}`)
- `location` ← `{{zip}}` (free text — a zip code works fine; `city`/`state` are the fallback)
- `year` ← `{{formatDate(appointment_date; "YYYY")}}` (fills Houzz's Project Year dropdown)
- `keywords` ← optional comma-separated keywords (300 chars max)
- `description` ← compose from `{{appointment_type}}`, `{{appointment_date}}`, `{{duration}}`, `{{task_id}}`, and `{{products}}`
- `photoUrls` ← `{{job_photos}}` **directly** — each item is already a plain URL string (Sanity CDN), so no `map()` needed. Use the full `job_photos` array for backfills (not `new_job_photos`, which is only the delta since the last run).

Recommended filter before the *Run an Actor* module so only real completed installs go to Houzz: `appointment_type = Install` AND `status = completed` AND `has_new_photos = true` (adjust to taste — e.g. drop the last condition if you're backfilling jobs whose photos were already seen).

> **First run:** keep `"dryRun": true`. The actor logs in, uploads the photos, fills every form, saves a screenshot of each project form to the run's key-value store — and publishes nothing. Check the screenshots in Apify Console (*Storage → Key-value store*), then flip `dryRun` to `false` for the real run.

## Calibration notes

Houzz changes its pages over time. The actor deliberately uses resilient text/role-based locators (e.g. "the button labeled Publish", "the field labeled Project name") instead of brittle CSS selectors, but if a step fails:

1. Open the failed run's log — the error names the exact step.
2. Open the `failed-project-N.png` screenshot in the run's key-value store to see what the page looked like.
3. Most fixes are one line in `src/main.js` (`fillProjectDetails` / `createProject`) — e.g. adjusting a label regex. Re-push with `apify push`.

## Cost & limits (good to know)

- A run is billed by memory × time; browser + photo uploads for a batch of ~10 projects typically takes a few minutes.
- Apify's synchronous-run API caps at ~300s — another reason to use the async Make pattern for big batches.
- Keep `delayBetweenProjectsMs` at 4000+ ms; uploading too fast can get the session throttled by Houzz.
- `maxPhotosPerProject` caps at 20 to keep runs fast.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Session cookies are expired or invalid` | Cookies older than Houzz's session lifetime | Re-export fresh cookies from your browser |
| `verification challenge` error | Houzz showed a CAPTCHA / human check | The actor never defeats these by design — complete it manually in your browser, re-export cookies, re-run |
| `Login did not succeed` | Wrong credentials or extra login step | Verify login manually; prefer `cookies` mode |
| `None of the photo URLs could be downloaded` | Links need login or aren't direct files | Use public/direct links (`uc?export=download&id=…` for Drive) and open one in an incognito window to test |
| A field wasn't found (`waiting for…` timeout) | Houzz changed the form | See "Calibration notes" — dry-run + screenshot, then adjust the locator |
| Make module times out | Batch too large for sync mode | Use the async pattern (Run synchronously OFF + Watch Actor Runs) |

## Files

- `src/main.js` — the actor: auth, photo download, upload loop, dataset reporting
- `.actor/actor.json` — actor metadata + secret env var wiring
- `.actor/input_schema.json` — input definition (also renders the form in Apify Console)
- `Dockerfile` / `package.json` — pinned Playwright + Apify SDK v3 build
