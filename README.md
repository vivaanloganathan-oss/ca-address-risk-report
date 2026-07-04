# California Address Risk & Livability Report

A **hosted-ready static web app**. Enter any California home address and it:

1. **Geocodes** the address (CA-only — rejects out-of-state) and pins it on an interactive map.
2. **Recenters all 36 hazard/livability maps on that address** — FEMA flood, earthquake faults, liquefaction, landslide, CAL FIRE hazard zones, pipelines, wells, Superfund/CalEPA, mines, pesticide, air/pollution, rail, power lines, noise, transit, cemeteries, and more.
3. **Auto-assesses** the factors that have a public point-query API (e.g. **FEMA flood zone** live; **Census demographics** when a key is set) and color-codes them No / Low / Moderate / High.
4. **Exports a downloadable PDF** report for the address.

No build step, no framework — just static files. Deploy anywhere (Netlify, Vercel, GitHub Pages, S3, Cloudflare Pages).

## Run locally
```bash
cd webapp
python3 -m http.server 8765
# open http://localhost:8765
```
(Any static server works; opening `index.html` via `file://` also works for everything except some browsers' fetch rules — a local server is recommended.)

## Deploy (hosted)
It's pure static, so any of these work with **no configuration**:

- **Netlify / Cloudflare Pages:** drag-and-drop the `webapp/` folder, or connect the repo and set the publish directory to `webapp`.
- **Vercel:** `vercel` in the `webapp/` folder (Framework preset: *Other*).
- **GitHub Pages:** push `webapp/` to a repo and enable Pages on that folder.

## Optional: live demographics (Census key)
Population / median income / median home value auto-load when a **free** U.S. Census API key is present.
1. Get a key (instant): https://api.census.gov/data/key_signup.html
2. Put it in `config.js`:
   ```js
   window.APP_CONFIG = { CENSUS_KEY: 'your-key-here', ACS_YEAR: '2023' };
   ```
Without a key the app still works — the demographics panel shows a link to the ZIP profile instead.

## Optional: dynamic Map Shots (live, address-searched screenshots)
About a third of the 36 factors link to agency maps that have **no URL
parameter for a location** — you have to type into their own search box.
The `server/` folder is a small, separately-hosted Playwright service that
does exactly that: opens the site, types the address's ZIP into its search
box, waits for it to zoom/pan, and returns a screenshot. The frontend calls
it for a new **"Map Shots"** section (shown after the at-a-glance summary).

This can't run inside the static frontend itself — browsers block a page's
JavaScript from reaching into another site to read or screenshot it — so it
needs its own small backend. See `server/README.md` for calibration and
deployment (Render / Fly.io / Railway). Point `MAPSHOT_API_BASE` in
`config.js` at it once deployed; leave it blank to keep the app fully
static (the section then just explains how to enable it, and the affected
factors keep working via their existing "Open live map" links).

## How risk is determined
- **Scoring:** 0 = No · 1–4 = Low · 5–7 = Moderate · 8–10 = High.
- **Live / automatic:** factors with a public REST API are queried at the exact point and rated automatically (currently **FEMA NFHL flood zone**; **Census** demographics with a key). The architecture makes it easy to add more (see `factors.js` `live` keys and `app.js` lookups).
- **Map-based:** every other factor opens its authoritative live map **recentered on the address** (or, for maps with no location parameter, opens the map so you can type the address in its own search bar — noted on each card). The three headline dimensions (Health / Property Value / Insurance) are shown as **indicative**, refined by the live lookups.

> Informational screening from public data only. Not a substitute for a professional inspection, geotechnical study, title report, or insurance underwriting.

## Files
| File | Purpose |
|------|---------|
| `index.html` | Page shell + CDN libs (Leaflet, jsPDF) |
| `styles.css` | Styling |
| `factors.js` | The 36 factors + recenterable map-link templates |
| `app.js` | Geocoding, live lookups, rendering, PDF export |
| `config.js` | Optional Census API key |

## Data sources
OpenStreetMap/Nominatim (geocoding) · U.S. Census ACS (demographics) · FEMA NFHL (flood) · Esri (basemap thumbnails) · plus each factor's authoritative agency map (CA Geological Survey, CAL FIRE, PHMSA, EPA/CalEPA, CalGEM, DWR, DOT, and others).

## Extending the automatic lookups
To make another factor auto-rate, add a `live:'key'` to it in `factors.js`, write an async lookup in `app.js` that returns `{label, score, desc}`, and call it in the `Promise.all` block inside `analyze()`. Good candidates with public point-query services: CAL FIRE FHSZ, USGS faults, CalGEM wells.
