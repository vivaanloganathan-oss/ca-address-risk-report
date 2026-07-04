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
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
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

async function captureShot(site, query) {
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

    const input = await findSearchInput(page, site.searchSelectors, site.selectorTimeoutMs);
    if (!input) throw new Error(`search input not found (tried: ${site.searchSelectors.join(', ')})`);

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

    if (site.zoomOutClicks && site.zoomOutSelector) {
      for (let i = 0; i < site.zoomOutClicks; i++) {
        await page.locator(site.zoomOutSelector).first().click().catch(() => {});
        await page.waitForTimeout(400);
      }
    }

    return await page.screenshot({ clip: site.clip || undefined });
  } finally {
    await page.close().catch(() => {});
  }
}

app.get('/healthz', (req, res) => res.send('ok'));

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
    const buf = await captureShot(site, query);
    fs.writeFileSync(file, buf);
    res.type('png').send(buf);
  } catch (e) {
    res.status(502).json({ error: 'mapshot_failed', detail: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Map Shot server listening on :${PORT}`));

process.on('SIGTERM', async () => { if (browserPromise) (await browserPromise).close(); process.exit(0); });
