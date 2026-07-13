/* Map Shot server — drives a headless browser to type an address/ZIP into
 * each agency site's own search box and returns a PNG screenshot of the
 * result. Self-hosted (Render / Fly.io / Railway / your own VPS).
 *
 * Endpoints:
 *   GET  /healthz
 *   GET  /api/mapshot?factor=<id>&q=<zip-or-address>
 *        -> image/png (cached on disk for CACHE_TTL_MS)
 *
 * Run:
 *   npm install
 *   npx playwright install --with-deps chromium
 *   npm start
 */
import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SITES } from './sites.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const app = express();
app.use(cors());

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      // Low-memory container hardening: /dev/shm is tiny in Docker (crashes
      // Chromium), and sandbox/gpu aren't available or needed here.
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    }).then(browser => {
      // If Chromium dies (e.g. OOM), reset so the next request relaunches it
      // instead of erroring forever on a dead handle.
      browser.on('disconnected', () => { browserPromise = null; });
      return browser;
    });
  }
  return browserPromise;
}

function cacheFile(factorId, query) {
  const hash = crypto.createHash('sha1').update(`${factorId}::${query.toLowerCase()}`).digest('hex');
  return path.join(CACHE_DIR, `${factorId}_${hash}.png`);
}

async function findSearchInput(page, selectors, timeoutPerSelectorMs = 8000) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: timeoutPerSelectorMs });
      return loc;
    } catch (e) { /* try next candidate */ }
  }
  return null;
}

// Many agency maps show a disclaimer/splash modal that blocks the app until
// clicked. Some (e.g. CGS EQ Zapp) additionally require ticking an
// "I agree..." checkbox before their OK button activates. Handle both.
async function dismissSplash(page, site) {
  // Step 1: tick any visible "I agree" style consent checkbox
  const agreeTargets = [
    'text=/i agree to the above/i', 'text=/i agree to the terms/i',
    'label:has-text("I agree")', 'input[type="checkbox"]:visible',
  ];
  for (const sel of agreeTargets) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 })) {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(400);
        break; // one consent tick is enough
      }
    } catch (e) { /* not present — fine */ }
  }
  // Step 2: click the dismiss/confirm button
  const candidates = [
    ...(site.dismissSelectors || []),
    'button:has-text("OK")', 'button:has-text("Ok")', 'button:has-text("I Agree")',
    'button:has-text("Agree")', 'button:has-text("Accept")', 'button:has-text("Got It")',
    'button:has-text("Continue")', 'button:has-text("Close")', 'button:has-text("I Understand")',
    '[aria-label="Close" i]', '.jimu-widget-splash .jimu-btn',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 400 })) {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(700);
      }
    } catch (e) { /* not present — fine */ }
  }
}

// Some apps collapse the search widget into a magnifying-glass icon; the
// input only becomes visible after clicking it to expand.
async function expandSearch(page, site) {
  const candidates = [
    ...(site.expandSelectors || []),
    '.esri-icon-search', '[title="Search" i]', 'button[aria-label*="search" i]',
    'div[role="button"][title*="search" i]', '.esri-search__submit-button',
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 })) {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(600);
        return true;
      }
    } catch (e) { /* not present — fine */ }
  }
  return false;
}

async function captureShot(site, query, debug = false) {
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: site.viewport?.w || 1400, height: site.viewport?.h || 900 },
  });
  try {
    // 'domcontentloaded' instead of 'networkidle': map apps keep polling tiles,
    // so 'networkidle' can resolve before widgets finish mounting (or time out
    // waiting for network that never truly goes idle). We wait for the actual
    // search input to appear instead, which is the real readiness signal.
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);       // let any splash modal render
    await dismissSplash(page, site);

    let input = await findSearchInput(page, site.searchSelectors, 5000);
    if (!input) {
      // widget may be collapsed behind a search icon — expand and retry
      await expandSearch(page, site);
      input = await findSearchInput(page, site.searchSelectors, site.selectorTimeoutMs);
    }
    if (!input) {
      // splash may have appeared late — dismiss again, expand again, one last try
      await dismissSplash(page, site);
      await expandSearch(page, site);
      input = await findSearchInput(page, site.searchSelectors, 4000);
    }
    if (!input) {
      const title = await page.title().catch(() => '?');
      const err = new Error(`search input not found on "${title}" (tried: ${site.searchSelectors.join(', ')})`);
      if (debug) err.debugShot = await page.screenshot().catch(() => null);
      throw err;
    }

    await input.click({ timeout: 10000 });
    await input.fill('').catch(() => {});
    await input.type(query, { delay: 45 });
    await page.waitForTimeout(site.suggestDelayMs ?? 900);

    if (site.submit === 'firstSuggestion') {
      const sug = page.locator(site.suggestionSelector).first();
      if (await sug.count().catch(() => 0)) await sug.click();
      else await page.keyboard.press('Enter');
    } else if (site.submit === 'button') {
      await page.locator(site.submitButtonSelector).first().click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(site.settleDelayMs ?? 3500);

    // close floating "search result" style popups so they don't cover the map
    const closeSels = [...(site.closeSelectors || []), '.esri-popup__button--close', '[aria-label="Close" i]', '[title="Close" i]'];
    for (const sel of closeSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 300 })) { await btn.click({ timeout: 2000 }); await page.waitForTimeout(400); }
      } catch (e) { /* fine */ }
    }

    if (site.zoomOutClicks && site.zoomOutSelector) {
      for (let i = 0; i < site.zoomOutClicks; i++) {
        await page.locator(site.zoomOutSelector).first().click().catch(() => {});
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(2000); // let tiles finish rendering at the final zoom
    }

    return await page.screenshot({ clip: site.clip || undefined });
  } finally {
    await page.close().catch(() => {});
  }
}

const SERVER_VERSION = 'v13-amenity-mirrors'; // bump when editing; check at GET /

function emptyAmenityCounts() {
  return { uni: 0, eat: 0, shop: 0, park: 0, health: 0, hosp: 0, transit: 0, station: 0, junction: 0, constr: 0, community: 0 };
}

function amenityQuery(lat, lon) {
  return `[out:json][timeout:25];(
    nwr(around:2500,${lat},${lon})[amenity~"^(university|college)$"];
    nwr(around:1500,${lat},${lon})[amenity~"^(restaurant|cafe|fast_food)$"];
    nwr(around:1500,${lat},${lon})[shop];
    nwr(around:1500,${lat},${lon})[leisure~"^(park|playground|pitch|garden)$"];
    nwr(around:2000,${lat},${lon})[amenity~"^(hospital|clinic|doctors|pharmacy)$"];
    nwr(around:1200,${lat},${lon})[highway=bus_stop];
    nwr(around:1200,${lat},${lon})[public_transport=platform];
    nwr(around:3000,${lat},${lon})[railway=station];
    nwr(around:4000,${lat},${lon})[highway=motorway_junction];
    nwr(around:1500,${lat},${lon})[landuse=construction];
    nwr(around:1500,${lat},${lon})[building=construction];
    nwr(around:1500,${lat},${lon})[amenity~"^(library|community_centre|place_of_worship)$"];
  );out tags qt 600;`;
}

function countAmenityElements(elements = []) {
  const c = emptyAmenityCounts();
  elements.forEach(e => {
    const t = e.tags || {};
    if (/^(university|college)$/.test(t.amenity || '')) c.uni++;
    else if (/^(restaurant|cafe|fast_food)$/.test(t.amenity || '')) c.eat++;
    else if (t.shop) c.shop++;
    else if (/^(park|playground|pitch|garden)$/.test(t.leisure || '')) c.park++;
    else if ((t.amenity || '') === 'hospital') { c.hosp++; c.health++; }
    else if (/^(clinic|doctors|pharmacy)$/.test(t.amenity || '')) c.health++;
    else if (t.highway === 'bus_stop' || t.public_transport === 'platform') c.transit++;
    else if (t.railway === 'station') c.station++;
    else if (t.highway === 'motorway_junction') c.junction++;
    else if (t.landuse === 'construction' || t.building === 'construction') c.constr++;
    else if (/^(library|community_centre|place_of_worship)$/.test(t.amenity || '')) c.community++;
  });
  return c;
}

async function amenityCounts(lat, lon) {
  const q = amenityQuery(lat, lon);
  const body = new URLSearchParams({ data: q });
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
  ];
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': `ca-address-risk-report/${SERVER_VERSION}`,
        },
        body,
      });
      if (!res.ok) throw new Error(`${endpoint} ${res.status}`);
      const json = await res.json();
      return countAmenityElements(json?.elements || []);
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  throw new Error(errors.join(' | '));
}

// A single unhandled rejection kills modern Node outright — which shows up in
// Render as a silent "Instance restarted" with no error output. Log instead.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

app.get('/', (req, res) => res.send(
  `CA Map Shot server ${SERVER_VERSION} — OK.\n` +
  `Endpoints: /healthz | /api/amenities?lat=<lat>&lon=<lon> | /api/mapshot?factor=<id>&q=<zip-or-address>[&debug=1]`
));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/amenities', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=900');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'missing_or_invalid_lat_lon' });
  }
  if (lat < 32 || lat > 43 || lon < -125 || lon > -113) {
    return res.status(400).json({ error: 'coordinates_outside_california_bounds' });
  }
  try {
    const counts = await amenityCounts(lat.toFixed(6), lon.toFixed(6));
    res.json({ counts, source: 'OpenStreetMap Overpass', server: SERVER_VERSION });
  } catch (e) {
    res.status(502).json({ error: 'amenity_counts_failed', detail: String(e.message || e) });
  }
});

// Concurrency guard: each capture runs a Chromium page. Unlimited parallel
// requests (e.g. a page load requesting all 17 factors) would exhaust memory.
const MAX_CONCURRENT = 2;
let activeJobs = 0;
const jobWaiters = [];
async function withSlot(fn) {
  if (activeJobs >= MAX_CONCURRENT) await new Promise(r => jobWaiters.push(r));
  activeJobs++;
  try { return await fn(); }
  finally { activeJobs--; const next = jobWaiters.shift(); if (next) next(); }
}

app.get('/api/mapshot', async (req, res) => {
  res.set('Cache-Control', 'no-store'); // errors & images always fresh from server; server has its own disk cache
  const factorId = Number(req.query.factor);
  const query = String(req.query.q || req.query.zip || req.query.address || '').trim();
  const site = SITES[factorId];

  if (!site) return res.status(404).json({ error: 'no_dynamic_map_for_factor', factorId });
  if (!query) return res.status(400).json({ error: 'missing_query' });

  const file = cacheFile(factorId, query);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL_MS) {
    res.type('png');
    return res.send(fs.readFileSync(file));
  }

  try {
    const debug = req.query.debug === '1';
    const buf = await withSlot(() => captureShot(site, query, debug));
    fs.writeFileSync(file, buf);
    res.type('png').send(buf);
  } catch (e) {
    if (e.debugShot) {
      // debug=1: show what headless Chromium actually saw when it gave up
      res.status(200).set('X-Mapshot-Error', String(e.message || e).slice(0, 500));
      return res.type('png').send(e.debugShot);
    }
    res.status(502).json({ error: 'mapshot_failed', detail: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Map Shot server listening on :${PORT}`));

process.on('SIGTERM', async () => { if (browserPromise) (await browserPromise).close(); process.exit(0); });
