/* Per-factor site definitions for the dynamic Map Shot server.
 *
 * IMPORTANT: I could not live-verify these against the actual sites (no
 * browser access when this was written). searchSelectors are ordered,
 * best-guess candidates based on common ArcGIS Experience Builder / Instant
 * Apps / custom search-widget patterns. Before relying on this in
 * production, run:
 *
 *     node calibrate.js <factorId> "94582"
 *
 * for each factor below. It opens a real (headed) Chromium window, drives
 * the same steps the server will use, and pauses at the end so you can see
 * whether the right thing got typed/zoomed. Fix the selectors here and
 * re-run until it looks right, then it'll work headless in production.
 *
 * Fields:
 *   url               - page to open (must NOT already have a location, this
 *                        is the class of factor with no URL param)
 *   searchSelectors    - array of CSS selectors tried in order for the
 *                        search input box
 *   submit             - 'enter' | 'firstSuggestion' | 'button'
 *   suggestionSelector - used when submit === 'firstSuggestion'
 *   submitButtonSelector - used when submit === 'button'
 *   suggestDelayMs     - wait after typing, before submit (let autosuggest load)
 *   settleDelayMs      - wait after submit, before the screenshot (let map pan/zoom)
 *   zoomOutClicks       - optional: click a zoom-out control N times after settling
 *                        (useful if the site zooms in too tight on a ZIP)
 *   viewport           - screenshot size
 *   clip               - optional {x,y,width,height} to crop out chrome/toolbars;
 *                        null = full viewport
 */

export const SITES = {
  6: { // Soil Liquefaction Zones (CGS EQ Zapp) — confirmed via devtools 7/4/26:
       // <input class="esri-input esri-search__input" placeholder="Find address or place" ...>
    url: 'https://maps.conservation.ca.gov/cgs/informationwarehouse/eqzapp/',
    searchSelectors: ['.esri-search__input', 'input[placeholder*="address" i]', 'input[type="search"]'],
    selectorTimeoutMs: 12000,
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li, [role="option"]',
    suggestDelayMs: 1000, settleDelayMs: 8000,
    zoomOutClicks: 3, zoomOutSelector: '[title="Zoom out" i]',
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  9: { // Dams & Inundation
    url: 'https://fmds.water.ca.gov/webgis/?appid=dam_prototype_v2',
    searchSelectors: ['.esri-search__input', 'input[type="search"]', 'input[placeholder*="search" i]'],
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li',
    suggestDelayMs: 900, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  11: { // Fire Hazard Severity Zone
    url: 'https://experience.arcgis.com/experience/03beab8511814e79a0e4eabf0d3e7247/',
    searchSelectors: ['.esri-search__input', 'input[placeholder*="address" i]'],
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li',
    suggestDelayMs: 1000, settleDelayMs: 4000,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  13: { // Pipelines (PHMSA)
    url: 'https://pvnpms.phmsa.dot.gov/PublicViewer/',
    searchSelectors: ['input[id*="search" i]', 'input[placeholder*="address" i]', 'input[type="text"]'],
    submit: 'enter',
    suggestDelayMs: 600, settleDelayMs: 4000,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  14: { // Oil & Gas Wells (CalGEM WellFinder)
    url: 'https://maps.conservation.ca.gov/doggr/wellfinder/',
    searchSelectors: ['input[placeholder*="address" i]', '.esri-search__input'],
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li',
    suggestDelayMs: 900, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  15: { // Superfund (NPL) - EPA map viewer
    url: 'https://epa.maps.arcgis.com/apps/mapviewer/index.html',
    searchSelectors: ['.esri-search__input', 'input[placeholder*="Find address" i]'],
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li',
    suggestDelayMs: 1000, settleDelayMs: 4000,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  16: { // EPA / CalEPA regulated sites
    url: 'https://siteportal.calepa.ca.gov/nsite/map/help',
    searchSelectors: ['input[placeholder*="search" i]', 'input[type="text"]'],
    submit: 'enter',
    suggestDelayMs: 700, settleDelayMs: 4000,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  17: { // Mines
    url: 'https://maps.conservation.ca.gov/mol/index.html',
    searchSelectors: ['input[placeholder*="address" i]', '.esri-search__input'],
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li',
    suggestDelayMs: 900, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  18: { // Mines & fault overlap (same app as #17)
    url: 'https://maps.conservation.ca.gov/mol/index.html',
    searchSelectors: ['input[placeholder*="address" i]', '.esri-search__input'],
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li',
    suggestDelayMs: 900, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  19: { // Waste / Dump sites (OEHHA instant app)
    url: 'https://oehha.maps.arcgis.com/apps/instant/sidebar/index.html?appid=32262911130441d68d0521ec10b429a5',
    searchSelectors: ['.esri-search__input', 'input[placeholder*="address" i]'],
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li',
    suggestDelayMs: 1000, settleDelayMs: 4000,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  21: { // Drinking Water Standard (DWR Water Data Library)
    url: 'https://wdl.water.ca.gov/waterdatalibrary/Map.aspx',
    searchSelectors: ['input[type="text"]', 'input[placeholder*="search" i]'],
    submit: 'enter',
    suggestDelayMs: 600, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  22: { // Groundwater (same app as #21)
    url: 'https://wdl.water.ca.gov/waterdatalibrary/Map.aspx',
    searchSelectors: ['input[type="text"]', 'input[placeholder*="search" i]'],
    submit: 'enter',
    suggestDelayMs: 600, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  23: { // Pesticide Use
    url: 'https://pesticideinfo.org/pesticide-maps/ca-pesticide-map',
    searchSelectors: ['input[placeholder*="search" i]', 'input[type="text"]'],
    submit: 'enter',
    suggestDelayMs: 600, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  27: { // Air Pollution (PurpleAir)
    url: 'https://map.purpleair.com/',
    searchSelectors: ['input[placeholder*="search" i]', 'input[type="text"]'],
    submit: 'enter',
    suggestDelayMs: 700, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  28: { // CalEnviroScreen
    url: 'https://experience.arcgis.com/experience/ed5953d89038431dbf4f22ab9abfe40d/',
    searchSelectors: ['.esri-search__input', 'input[placeholder*="address" i]'],
    submit: 'firstSuggestion',
    suggestionSelector: '.esri-search__suggestions-list li',
    suggestDelayMs: 1000, settleDelayMs: 4000,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  29: { // Highway Traffic Pollution (DOT Noise Map, also used for #32)
    url: 'https://maps.dot.gov/BTS/NationalTransportationNoiseMap/',
    searchSelectors: ['input[placeholder*="search" i]', 'input[type="text"]'],
    submit: 'enter',
    suggestDelayMs: 700, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
  32: { // Noise Level (same app as #29)
    url: 'https://maps.dot.gov/BTS/NationalTransportationNoiseMap/',
    searchSelectors: ['input[placeholder*="search" i]', 'input[type="text"]'],
    submit: 'enter',
    suggestDelayMs: 700, settleDelayMs: 3500,
    viewport: { w: 1400, h: 900 }, clip: null,
  },
};
