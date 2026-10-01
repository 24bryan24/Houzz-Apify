/**
 * Houzz Project Uploader — Apify actor
 * ------------------------------------
 * Adds projects (photos + details) to the Projects section of a Houzz Pro
 * profile. Designed to be called from Make.com ("Run an Actor" module) with
 * a batch of projects in a single run: one login, many uploads.
 *
 * AUTH
 *   "cookies" (recommended): paste a JSON array of houzz.com cookies exported
 *     from your logged-in browser into the `cookiesJson` secret input (or set
 *     the HOUZZ_COOKIES_JSON secret env var once in Apify Console). No
 *     password is stored anywhere and Houzz's login screen is skipped.
 *   "login": signs in with the HOUZZ_EMAIL / HOUZZ_PASSWORD secret
 *     environment variables configured on the actor in Apify Console.
 *
 * CALIBRATION
 *   Houzz changes its pages over time, so the form interactions below use
 *   resilient text/role-based locators rather than brittle CSS selectors.
 *   Run once with "dryRun": true first: the actor fills everything, saves a
 *   screenshot of each project form to the run's key-value store, and
 *   publishes nothing. If a step can't find its field, the error message and
 *   the screenshot tell you exactly what to adjust.
 *
 * SAFETY
 *   If Houzz shows a CAPTCHA / "verify you are human" challenge at any point,
 *   the actor stops with a clear error instead of trying to defeat it.
 *   Complete the challenge manually in a browser, re-export cookies, and
 *   re-run in "cookies" mode.
 */

import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOUZZ_BASE_URL = 'https://www.houzz.com';
const STORED_COOKIES_KEY = 'HOUZZ_COOKIES';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * 1500);

function extensionFor(contentType) {
    const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'image/heic': '.heic',
        'image/heif': '.heif',
        'image/avif': '.avif',
    };
    return map[(contentType || '').split(';')[0].trim().toLowerCase()] || '';
}

/** Download one photo URL to a local file. Throws on any problem. */
async function downloadImage(url, destDir, index) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'https:') {
        throw new Error(`Only https photo URLs are supported: ${url}`);
    }
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`Photo download failed (HTTP ${res.status}): ${url}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
        throw new Error(
            `URL did not return an image (content-type: ${contentType || 'unknown'}): ${url}`,
        );
    }
    const ext = extensionFor(contentType) || path.extname(parsed.pathname) || '.jpg';
    const filePath = path.join(destDir, `photo-${String(index).padStart(2, '0')}${ext}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) {
        throw new Error(`Downloaded file is suspiciously small (${buf.length} bytes): ${url}`);
    }
    await fs.writeFile(filePath, buf);
    return filePath;
}

async function saveDebugScreenshot(page, name) {
    try {
        const buf = await page.screenshot({ fullPage: false });
        const store = await Actor.openKeyValueStore();
        await store.setValue(name, buf, { contentType: 'image/png' });
        log.warning(`Saved debug screenshot to the run's key-value store as "${name}".`);
    } catch (e) {
        log.warning(`Could not save debug screenshot: ${e.message}`);
    }
}

const CHALLENGE_MARKERS = [
    'captcha',
    'verify you are human',
    'are you a robot',
    'unusual traffic',
    'please verify',
    'security check',
];

/** Returns true when the page looks like a bot/verification challenge. */
async function detectChallenge(page) {
    try {
        const [title, bodyText] = await Promise.all([
            page.title().catch(() => ''),
            page.locator('body').innerText({ timeout: 8000 }).catch(() => ''),
        ]);
        const haystack = `${title}\n${bodyText}`.toLowerCase();
        return CHALLENGE_MARKERS.some((marker) => haystack.includes(marker));
    } catch {
        return false;
    }
}

function challengeError(where) {
    return new Error(
        `Houzz showed a verification challenge ${where}. This actor never attempts to ` +
        `defeat CAPTCHAs. Please complete the challenge manually in your browser, ` +
        `re-export fresh session cookies, and re-run in "cookies" auth mode.`,
    );
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Load cookies: explicit input > secret env var > cookies saved by a prior run. */
async function loadCookies(input) {
    const raw = input.cookiesJson || process.env.HOUZZ_COOKIES_JSON || '';
    if (raw) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error(
                'cookiesJson is not valid JSON. Export an array of cookie objects from your browser.',
            );
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('cookiesJson must be a non-empty JSON array of cookie objects.');
        }
        return { cookies: parsed, source: 'provided' };
    }
    if (input.reuseStoredCookies !== false) {
        const store = await Actor.openKeyValueStore();
        const saved = await store.getValue(STORED_COOKIES_KEY);
        if (Array.isArray(saved) && saved.length > 0) {
            return { cookies: saved, source: 'previous run' };
        }
    }
    return { cookies: [], source: 'none' };
}

function normalizeSameSite(value) {
    const v = String(value || '').toLowerCase();
    if (v === 'strict') return 'Strict';
    if (v === 'lax') return 'Lax';
    if (v === 'none' || v === 'no_restriction') return 'None';
    return undefined; // "unspecified" and anything else: let the browser decide
}

function normalizeCookies(cookies) {
    return cookies
        .filter((c) => c && c.name && typeof c.value !== 'undefined')
        .map((c) => ({
            name: String(c.name),
            value: String(c.value),
            domain: c.domain || '.houzz.com',
            path: c.path || '/',
            ...(Number(c.expires) > 0 ? { expires: Math.floor(Number(c.expires)) } : {}),
            ...(typeof c.httpOnly !== 'undefined' ? { httpOnly: Boolean(c.httpOnly) } : {}),
            ...(typeof c.secure !== 'undefined' ? { secure: Boolean(c.secure) } : {}),
            ...(normalizeSameSite(c.sameSite) ? { sameSite: normalizeSameSite(c.sameSite) } : {}),
        }));
}

async function loginWithCredentials(page) {
    const email = process.env.HOUZZ_EMAIL;
    const password = process.env.HOUZZ_PASSWORD;
    if (!email || !password) {
        throw new Error(
            'authMode is "login" but HOUZZ_EMAIL / HOUZZ_PASSWORD are not set. ' +
            'Add them as secret environment variables on the actor in Apify Console ' +
            '(Settings → Integrations → Environment variables), never in the input JSON.',
        );
    }
    log.info('Logging in with email + password…');
    await page.goto(`${HOUZZ_BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await detectChallenge(page)) throw challengeError('on the login page');

    const emailField = page
        .getByLabel(/email/i)
        .or(page.locator('input[type="email"], input[name*="email" i], input[id*="email" i]'))
        .first();
    await emailField.waitFor({ timeout: 20000 });
    await emailField.fill(email);

    const passwordField = page.locator('input[type="password"]').first();
    await passwordField.waitFor({ timeout: 15000 });
    await passwordField.fill(password);

    await page.getByRole('button', { name: /log in|sign in/i }).first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await sleep(2500);

    if (await detectChallenge(page)) throw challengeError('during login');
    const stillOnLogin =
        page.url().includes('/login') || (await page.locator('input[type="password"]').count()) > 0;
    if (stillOnLogin) {
        throw new Error(
            'Login did not succeed (still on the login page). Check the credentials, ' +
            'or switch to "cookies" auth mode for a more reliable session.',
        );
    }
    log.info('Login succeeded.');
}

/** Ensure we have an authenticated session before uploading anything. */
async function ensureLoggedIn(page, context, input) {
    if (input.authMode === 'cookies') {
        const { cookies, source } = await loadCookies(input);
        if (cookies.length === 0) {
            throw new Error(
                'authMode is "cookies" but no cookies were found. Paste a JSON cookie array ' +
                'into the cookiesJson secret input (or set HOUZZ_COOKIES_JSON), or enable ' +
                '"reuseStoredCookies" after one successful run.',
            );
        }
        await context.addCookies(normalizeCookies(cookies));
        log.info(`Injected ${cookies.length} session cookies (source: ${source}).`);
    } else if (input.authMode === 'login') {
        await loginWithCredentials(page);
    } else {
        throw new Error(`Unknown authMode "${input.authMode}". Use "cookies" or "login".`);
    }

    // Verify the session by opening the Add Project page.
    await page.goto(input.addProjectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await detectChallenge(page)) throw challengeError('while verifying the session');
    const bouncedToLogin =
        page.url().includes('/login') || (await page.locator('input[type="password"]').count()) > 0;
    if (bouncedToLogin) {
        if (input.authMode === 'cookies') {
            throw new Error(
                'The session cookies are expired or invalid (Houzz redirected to login). ' +
                'Re-export fresh cookies from your logged-in browser and try again.',
            );
        }
        throw new Error('Login session was lost immediately after signing in. Try "cookies" mode.');
    }

    // Persist the working session so future runs can reuse it.
    if (input.reuseStoredCookies !== false) {
        try {
            const store = await Actor.openKeyValueStore();
            await store.setValue(STORED_COOKIES_KEY, await context.cookies());
            log.info('Saved session cookies for future runs.');
        } catch (e) {
            log.warning(`Could not persist cookies: ${e.message}`);
        }
    }
    log.info('Authenticated session verified.');
}

// ---------------------------------------------------------------------------
// Project creation
// ---------------------------------------------------------------------------

async function fillProjectDetails(page, project) {
    // Project title / name
    const titleField = page
        .getByLabel(/project name|project title|^title$/i)
        .or(page.locator('input[name*="title" i], input[placeholder*="project name" i]'))
        .first();
    await titleField.waitFor({ timeout: 20000 });
    await titleField.fill(project.title);
    log.info('Filled project title.');

    // Location: free-text `location` wins (e.g. a zip code); otherwise join city + state.
    const locationText = (project.location && String(project.location).trim())
        || [project.city, project.state].filter(Boolean).join(', ');
    if (locationText) {
        const locationField = page
            .getByLabel(/project address|location|city/i)
            .or(page.locator('input[placeholder*="Project Address" i], input[name*="city" i], input[name*="location" i], input[name*="zip" i]'))
            .first();
        if ((await locationField.count()) > 0) {
            await locationField.fill(locationText);
            log.info(`Filled location: ${locationText}.`);
        } else {
            log.warning('No location field found; skipping location.');
        }
    }

    // Description
    if (project.description) {
        const descriptionField = page
            .getByLabel(/description|about this project|project details/i)
            .or(page.locator('textarea[name*="descript" i], textarea'))
            .first();
        if ((await descriptionField.count()) > 0) {
            await descriptionField.fill(project.description);
            log.info('Filled project description.');
        } else {
            log.warning('No description field found; skipping description.');
        }
    }

    // Project Year (Houzz "Upload Content to a Project" form has a Year dropdown)
    if (project.year) {
        const yearStr = String(project.year).trim();
        const yearField = page.getByLabel(/project year/i).first();
        if ((await yearField.count()) > 0 && /^\d{4}$/.test(yearStr)) {
            let set = false;
            for (const option of [{ label: yearStr }, yearStr]) {
                try {
                    await yearField.selectOption(option);
                    set = true;
                    break;
                } catch {
                    /* try the next form */
                }
            }
            if (set) log.info(`Set project year: ${yearStr}.`);
            else log.warning(`Could not set project year to ${yearStr}; leaving default.`);
        }
    }

    // Keywords (comma-separated, 300 chars max on Houzz)
    if (project.keywords) {
        const keywordsField = page
            .getByLabel(/keywords/i)
            .or(page.locator('textarea[placeholder*="keyword" i]'))
            .first();
        if ((await keywordsField.count()) > 0) {
            await keywordsField.fill(String(project.keywords).slice(0, 300));
            log.info('Filled keywords.');
        }
    }

    // Optional per-photo captions, matched by upload order.
    if (Array.isArray(project.photoCaptions) && project.photoCaptions.length > 0) {
        const captionFields = page.locator(
            'input[placeholder*="caption" i], textarea[placeholder*="caption" i]',
        );
        const count = await captionFields.count();
        const n = Math.min(count, project.photoCaptions.length);
        for (let i = 0; i < n; i++) {
            const caption = project.photoCaptions[i];
            if (caption) await captionFields.nth(i).fill(String(caption));
        }
        if (n > 0) log.info(`Filled ${n} photo caption(s).`);
    }
}

async function createProject(page, project, input, runTmpDir, index) {
    const label = project.title || `project #${index + 1}`;
    const result = {
        title: project.title || '',
        status: 'failed',
        photosUploaded: 0,
        projectUrl: null,
        error: null,
    };

    try {
        // 1. Download the photos to local files (Playwright uploads local paths).
        const photoUrls = (project.photoUrls || []).slice(0, input.maxPhotosPerProject || 10);
        if (photoUrls.length === 0) throw new Error('Project has no photoUrls.');
        const photoDir = path.join(runTmpDir, `project-${index}`);
        await fs.mkdir(photoDir, { recursive: true });
        const localPaths = [];
        for (let i = 0; i < photoUrls.length; i++) {
            try {
                localPaths.push(await downloadImage(photoUrls[i], photoDir, i));
            } catch (e) {
                log.warning(`"${label}": skipping photo ${i + 1}: ${e.message}`);
            }
        }
        if (localPaths.length === 0) {
            throw new Error('None of the photo URLs could be downloaded as images.');
        }
        log.info(`"${label}": downloaded ${localPaths.length}/${photoUrls.length} photo(s).`);

        // 2. Open the Add Project page.
        await page.goto(input.addProjectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (await detectChallenge(page)) throw challengeError('while opening the Add Project page');
        if (page.url().includes('/login')) {
            throw new Error('Lost the login session while creating the project. Re-run with fresh cookies.');
        }

        // 3. Attach the photos to the upload control.
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ timeout: 30000 });
        await fileInput.setInputFiles(localPaths);
        result.photosUploaded = localPaths.length;
        log.info(`"${label}": attached ${localPaths.length} photo(s), waiting for upload…`);
        // Give Houzz time to process the uploads; the details form is usually
        // below/after the uploader, so wait for the title field as the signal.
        await sleep(5000);

        // 4. Fill in the project details.
        await fillProjectDetails(page, project);

        // 5. Publish — or stop before publishing in dry-run mode.
        if (input.dryRun) {
            log.info(`[dryRun] "${label}": form filled, photos attached — NOT publishing.`);
            await saveDebugScreenshot(page, `dryrun-project-${index}.png`);
            result.status = 'dry-run';
        } else {
            const publishButton = page
                .getByRole('button', { name: /publish|save|add project|done|create/i })
                .last();
            await publishButton.waitFor({ timeout: 20000 });
            await publishButton.click();
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
            await sleep(3000);
            if (await detectChallenge(page)) throw challengeError('after submitting the project');
            result.projectUrl = page.url();
            result.status = 'ok';
            log.info(`"${label}": published → ${result.projectUrl}`);
        }
    } catch (e) {
        result.error = e.message;
        log.error(`"${label}" failed: ${e.message}`);
        await saveDebugScreenshot(page, `failed-project-${index}.png`);
    }

    await Actor.pushData(result);
    return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await Actor.init();

const input = (await Actor.getInput()) || {};

// Validate the essentials up front so a bad run fails fast with a clear message.
if (!input.addProjectUrl || typeof input.addProjectUrl !== 'string') {
    throw new Error(
        'Missing "addProjectUrl". In your browser (logged into Houzz), open your ' +
        'professional profile\u2019s Projects section, click "Add Project", and paste that page\u2019s URL into the input.',
    );
}
input.addProjectUrl = input.addProjectUrl.trim();
if (!Array.isArray(input.projects) || input.projects.length === 0) {
    throw new Error('Missing "projects": provide a non-empty array of projects to add.');
}
for (const [i, p] of input.projects.entries()) {
    if (!p || typeof p.title !== 'string' || !p.title.trim()) {
        throw new Error(`projects[${i}] is missing a title.`);
    }
    if (!Array.isArray(p.photoUrls) || p.photoUrls.length === 0) {
        throw new Error(`projects[${i}] ("${p.title}") has no photoUrls.`);
    }
}

log.info(
    `Starting: ${input.projects.length} project(s), authMode=${input.authMode || 'cookies'}, ` +
    `dryRun=${Boolean(input.dryRun)}.`,
);

const browser = await chromium.launch({ headless: input.headless !== false });
const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await context.newPage();
const runTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'houzz-upload-'));

try {
    await ensureLoggedIn(page, context, input);

    let ok = 0;
    let failed = 0;
    for (let i = 0; i < input.projects.length; i++) {
        const res = await createProject(page, input.projects[i], input, runTmpDir, i);
        if (res.status === 'ok' || res.status === 'dry-run') ok += 1;
        else failed += 1;
        if (i < input.projects.length - 1) {
            const pause = jitter(input.delayBetweenProjectsMs ?? 4000);
            log.info(`Pausing ${pause}ms before the next project…`);
            await sleep(pause);
        }
    }
    log.info(`Finished: ${ok} succeeded, ${failed} failed, out of ${input.projects.length}.`);
} finally {
    await browser.close().catch(() => {});
    await fs.rm(runTmpDir, { recursive: true, force: true }).catch(() => {});
}

await Actor.exit();
