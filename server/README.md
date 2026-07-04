# Map Shot server

Self-hosted Playwright service that opens each agency's map site, types the
user's ZIP/address into **that site's own search box**, waits for it to
zoom/pan, and returns a PNG. The static frontend calls this over HTTP so
"Map Shots" can be generated dynamically for any address — the frontend
itself never talks to the agency sites directly (browsers block that
cross-origin).

## 1. Calibrate the selectors first (important)

I wrote `sites.config.js` without being able to load the live sites, so the
CSS selectors are best-guess. Before deploying, run each one locally and
watch it work:

```bash
cd server
npm install
npx playwright install --with-deps chromium
node calibrate.js 6 "94582"      # Soil Liquefaction
node calibrate.js 11 "94582"     # Fire Hazard Severity Zone
node calibrate.js 28 "94582"     # CalEnviroScreen
# ...repeat for each factor id in sites.config.js
```

A real Chromium window opens and shows you what happened. If the search box
wasn't found, open devtools in that window, find the real input element,
and update `searchSelectors` for that factor in `sites.config.js`. Same for
`suggestionSelector` if it's not clicking the right autosuggest item.

## 2. Run locally

```bash
npm start
# http://localhost:8787/api/mapshot?factor=6&q=94582
```

## 3. Deploy (pick one)

**Render** (easiest, has a free tier with cold starts):
- New → Web Service → connect this `server/` folder
- Runtime: Docker (uses the included `Dockerfile`)
- Health check path: `/healthz`

**Fly.io**:
```bash
fly launch          # from inside server/, picks up the Dockerfile
fly deploy
```

**Railway**:
- New Project → Deploy from repo → set root directory to `server/`
- Railway auto-detects the Dockerfile

All three give you a public URL like `https://your-app.onrender.com`.

## 4. Point the frontend at it

In `config.js` at the project root:
```js
window.APP_CONFIG = {
  ...
  MAPSHOT_API_BASE: 'https://your-app.onrender.com'
};
```
Leave it `''` to disable the Map Shots section (the app falls back to the
existing "open live map" links, same pattern as the optional Census key).

## Notes / limits

- **Cold starts**: free tiers spin down when idle; the first request after a
  while can take 10-30s while the container wakes up. The frontend shows a
  loading spinner per shot, so this is tolerable but not instant.
- **Caching**: results are cached to disk per `factor+query` for 7 days
  (`CACHE_DIR` in `server.js`) so repeat visits to the same ZIP are instant
  and you don't hammer the agency sites.
- **Fragility**: these are other people's websites with no public API for
  this — if an agency redesigns their site, that factor's selector will need
  recalibrating. That's inherent to this approach, not a bug.
- **Concurrency**: this starts simple (one shared browser instance, pages
  opened per-request). If you get real traffic, consider a small queue/pool
  so you don't launch dozens of pages at once.
