/* California Address Risk & Livability Report — front-end logic.
   Pure static: geocoding (Nominatim/OSM), live lookups (Census ACS, FEMA NFHL),
   address-centered map thumbnails, recentered map links, jsPDF export. */

const RC = {no:'#5b7c99', low:'#2e8b57', mod:'#e08a00', high:'#c41e3a', pending:'#8593a6'};
const $ = s => document.querySelector(s);
const withTimeout = (promise, ms, label='Request') => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
]);
async function fetchWithAbort(url, opts={}, ms=8000){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), ms);
  try{ return await fetch(url, {...opts, signal:ctrl.signal}); }
  finally{ clearTimeout(timer); }
}

let STATE = null; // {addr, lat, lon, zip, city, display}
let map, marker;
let ANALYZE_RUN = 0;
let RESUME_PDF_AFTER_DONATION = false;
const DONATION_RETURN_KEY = 'homeRiskRadarPendingPdf';
const DISCLAIMER_ACK_STATEMENT = 'Acknowledgement: Before downloading this PDF report, the user confirmed that they read and agree to the Disclaimer and Terms of Use, understand the data is for informational purposes only and not for decision-making, and will consult a licensed professional before making any real estate decision.';

function setStatus(html, cls=''){ const s=$('#status'); s.className='status '+cls; s.innerHTML=html; }
function setPageLoading(show, text='Loading report data...'){
  const el = $('#pageLoading');
  if(!el) return;
  const msg = $('#pageLoadingText');
  if(msg) msg.textContent = text;
  el.classList.toggle('hidden', !show);
  el.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function statsBaseUrl(){
  return String((window.APP_CONFIG||{}).MAPSHOT_API_BASE || '').replace(/\/+$/, '');
}
function formatStat(n){
  return Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—';
}
function renderStats(stats){
  const views = $('#siteViews');
  const downloads = $('#pdfDownloads');
  if(views) views.textContent = formatStat(stats?.views);
  if(downloads) downloads.textContent = formatStat(stats?.downloads);
}
async function refreshStats(){
  const base = statsBaseUrl();
  if(!base) return;
  try{
    const res = await fetchWithAbort(`${base}/api/stats`, {}, 5000);
    if(res.ok) renderStats(await res.json());
  }catch(e){ /* keep placeholders if stats are unavailable */ }
}
async function recordStat(kind){
  const base = statsBaseUrl();
  if(!base) return;
  try{
    const res = await fetchWithAbort(`${base}/api/stats/${kind}`, { method:'POST' }, 5000);
    if(res.ok) renderStats(await res.json());
  }catch(e){ /* stats should never block analysis or downloads */ }
}
async function recordSiteView(){
  await refreshStats();
  recordStat('view');
}

function saveDonationReturnState(){
  const addr = ($('#addr')?.value || STATE?.display || '').trim();
  if(!addr) return;
  try{
    localStorage.setItem(DONATION_RETURN_KEY, JSON.stringify({ address: addr, ts: Date.now() }));
  }catch(e){ /* returning from Stripe should not block download */ }
}

function loadDonationReturnState(){
  try{
    const raw = localStorage.getItem(DONATION_RETURN_KEY);
    if(!raw) return null;
    const data = JSON.parse(raw);
    if(!data || !data.address || Date.now() - Number(data.ts || 0) > 1000 * 60 * 60 * 6) return null;
    return data;
  }catch(e){ return null; }
}

function clearDonationReturnState(){
  try{ localStorage.removeItem(DONATION_RETURN_KEY); }catch(e){}
}

function fill(tmpl, st){
  return tmpl
    .replaceAll('{ADDR}', encodeURIComponent(st.display))
    .replaceAll('{LAT}', st.lat.toFixed(6))
    .replaceAll('{LON}', st.lon.toFixed(6))
    .replaceAll('{LONABS}', Math.abs(st.lon).toFixed(6))
    .replaceAll('{ZIP}', st.zip||'')
    .replaceAll('{CITY}', encodeURIComponent(st.city||''))
    .replaceAll('{COUNTY}', encodeURIComponent(st.county||''));
}

/* ---------- Geocoding (CA-only) ---------- */
function tidyAddressQuery(q){
  return q
    .replace(/\bmountainview\b/ig, 'Mountain View')
    .replace(/\bfederick\b/ig, 'Frederick')
    .replace(/\s+/g, ' ')
    .trim();
}
function typedHouseNumber(q){
  const m = String(q || '').trim().match(/^(\d+[A-Za-z]?)/);
  return m ? m[1].toLowerCase() : '';
}
function titleCase(s){
  return String(s || '').toLowerCase().replace(/\b[a-z]/g, c=>c.toUpperCase());
}
function hasTypedHouseNumber(q, found){
  const typed = typedHouseNumber(q);
  if(!typed) return true;
  const got = String(found || '').trim().match(/^(\d+[A-Za-z]?)/);
  return !!got && got[1].toLowerCase() === typed;
}
async function censusGeocode(q){
  const query = tidyAddressQuery(q);
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress`
    + `?address=${encodeURIComponent(query)}&benchmark=Public_AR_Current&format=json`;
  const res = await fetch(url, {headers:{'Accept':'application/json'}});
  if(!res.ok) throw new Error('Census geocoder returned '+res.status);
  const j = await res.json();
  const match = ((j.result||{}).addressMatches||[])[0];
  if(!match) throw new Error('Address not found. Try a fuller street address with ZIP.');
  const c = match.addressComponents || {};
  if((c.state || '').toUpperCase() !== 'CA') throw new Error(`That address resolves to ${c.state||'outside California'}. This tool is California-only.`);
  const city = titleCase(c.city);
  const street = titleCase(match.matchedAddress.split(',')[0] || '');
  return {
    lat:+match.coordinates.y, lon:+match.coordinates.x,
    zip:c.zip || '',
    city,
    county:'',
    display:[street, city, 'California', c.zip].filter(Boolean).join(', ')
  };
}
async function nominatimGeocode(q){
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1`
            + `&countrycodes=us&limit=5&q=${encodeURIComponent(tidyAddressQuery(q))}`;
  let data;
  try{
    const res = await fetch(url, {headers:{'Accept':'application/json'}});
    if(!res.ok) throw new Error('Geocoder returned '+res.status);
    data = await res.json();
  }catch(e){ throw new Error('Network error contacting geocoder. '+(e.message||'')); }
  if(!data || !data.length) throw new Error('Address not found. Try a fuller street address.');
  const typed = typedHouseNumber(q);
  const r = typed
    ? (data.find(x=>hasTypedHouseNumber(q, [(x.address||{}).house_number, (x.address||{}).road].filter(Boolean).join(' '))) || data[0])
    : data[0];
  const a = r.address||{};
  const state = a.state || '';
  if(state !== 'California') throw new Error(`That address resolves to ${state||'outside California'}. This tool is California-only.`);
  return {
    lat:+r.lat, lon:+r.lon,
    zip:a.postcode || '',
    city:a.city || a.town || a.village || a.hamlet || a.county || '',
    county:a.county||'',
    display:r.display_name.replace(', United States','')
  };
}
async function photonGeocode(q){
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(tidyAddressQuery(q))}&limit=6&lang=en`);
  if(!r.ok) throw new Error('Geocoder returned '+r.status);
  const j = await r.json();
  const typed = typedHouseNumber(q);
  const f = typed
    ? ((j.features||[]).find(x=>hasTypedHouseNumber(q, [(x.properties||{}).housenumber, (x.properties||{}).street].filter(Boolean).join(' '))) || (j.features||[])[0])
    : (j.features||[])[0];
  if(!f) throw new Error('Address not found. Try a fuller street address.');
  const p=f.properties||{};
  if(p.state!=='California') throw new Error(`That address resolves to ${p.state||'outside California'}. This tool is California-only.`);
  const line1=[p.housenumber,p.street].filter(Boolean).join(' ')||p.name||'';
  return { lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0],
    zip:p.postcode||'', city:p.city||p.town||p.village||p.county||'', county:p.county||'',
    display:[line1, p.city||p.town||p.village, 'California', p.postcode].filter(Boolean).join(', ') };
}

/* Census first for U.S. addresses, then OSM-based fallbacks.
   House-number matches are preferred, but street/place/city inputs still work. */
async function geocode(q){
  try{ return await censusGeocode(q); }
  catch(e){
    try{ return await nominatimGeocode(q); }
    catch(e2){
      try{ return await photonGeocode(q); }
      catch(e3){
        throw (e3.message && e3.message.includes('California-only')) ? e3 : e;
      }
    }
  }
}

/* ---------- Live lookups ---------- */
async function censusByZip(zip){
  if(!zip) return null;
  const cfg=window.APP_CONFIG||{};
  if(!cfg.CENSUS_KEY) return null;            // no key -> graceful fallback (link only)
  const yr=cfg.ACS_YEAR||'2023';
  const profileVars='NAME,DP05_0001E,DP03_0062E,DP04_0089E,DP02_0068PE';
  const detailVars = [
    'B15003_001E','B15003_002E','B15003_003E','B15003_004E','B15003_005E','B15003_006E','B15003_007E','B15003_008E','B15003_009E','B15003_010E','B15003_011E','B15003_012E','B15003_013E','B15003_014E','B15003_015E','B15003_016E','B15003_017E','B15003_018E','B15003_019E','B15003_020E','B15003_021E','B15003_022E','B15003_023E','B15003_024E','B15003_025E',
    'B01001_001E','B01001_002E','B01001_003E','B01001_004E','B01001_005E','B01001_006E','B01001_007E','B01001_008E','B01001_009E','B01001_010E','B01001_011E','B01001_012E','B01001_013E','B01001_014E','B01001_015E','B01001_016E','B01001_017E','B01001_018E','B01001_019E','B01001_020E','B01001_021E','B01001_022E','B01001_023E','B01001_024E','B01001_025E','B01001_026E','B01001_027E','B01001_028E','B01001_029E','B01001_030E','B01001_031E','B01001_032E','B01001_033E','B01001_034E','B01001_035E','B01001_036E','B01001_037E','B01001_038E','B01001_039E','B01001_040E','B01001_041E','B01001_042E','B01001_043E','B01001_044E','B01001_045E','B01001_046E','B01001_047E','B01001_048E','B01001_049E',
    'B03002_001E','B03002_003E','B03002_004E','B03002_005E','B03002_006E','B03002_007E','B03002_008E','B03002_009E','B03002_012E'
  ];
  const fetchTable = async (dataset, vars) => {
    const url=`https://api.census.gov/data/${yr}/${dataset}?get=${vars}&for=zip%20code%20tabulation%20area:${zip}&key=${cfg.CENSUS_KEY}`;
    const res=await fetch(url); if(!res.ok) return null;
    const j=await res.json(); if(!j||j.length<2) return null;
    const [h,row]=j; const o={}; h.forEach((k,i)=>o[k]=row[i]);
    return o;
  };
  const n = (o,k) => Number(o && o[k]) || 0;
  const pct = (num, den) => den > 0 ? Math.round((num / den) * 100) : null;
  try{
    const detailChunks = [];
    for(let i=0; i<detailVars.length; i+=45) detailChunks.push(detailVars.slice(i, i+45).join(','));
    const [p, ...detailRows] = await Promise.all([
      fetchTable('acs/acs5/profile', profileVars),
      ...detailChunks.map(vars => fetchTable('acs/acs5', vars))
    ]);
    const d = Object.assign({}, ...detailRows.filter(Boolean));
    if(!p) return null;
    const eduTotal = n(d,'B15003_001E');
    const lessHs = pct(['B15003_002E','B15003_003E','B15003_004E','B15003_005E','B15003_006E','B15003_007E','B15003_008E','B15003_009E','B15003_010E','B15003_011E','B15003_012E','B15003_013E','B15003_014E','B15003_015E','B15003_016E'].reduce((s,k)=>s+n(d,k),0), eduTotal);
    const highSchool = pct(n(d,'B15003_017E') + n(d,'B15003_018E'), eduTotal);
    const someCollege = pct(n(d,'B15003_019E') + n(d,'B15003_020E') + n(d,'B15003_021E'), eduTotal);
    const bachelor = pct(n(d,'B15003_022E'), eduTotal);
    const masters = pct(n(d,'B15003_023E') + n(d,'B15003_024E') + n(d,'B15003_025E'), eduTotal);
    const ageTotal = n(d,'B01001_001E');
    const sum = keys => keys.reduce((acc,k)=>acc+n(d,k),0);
    const ages = [
      ['<10 years', pct(sum(['B01001_003E','B01001_004E','B01001_027E','B01001_028E']), ageTotal)],
      ['10-17 years', pct(sum(['B01001_005E','B01001_006E','B01001_029E','B01001_030E']), ageTotal)],
      ['18-24 years', pct(sum(['B01001_007E','B01001_008E','B01001_009E','B01001_010E','B01001_031E','B01001_032E','B01001_033E','B01001_034E']), ageTotal)],
      ['25-34 years', pct(sum(['B01001_011E','B01001_012E','B01001_035E','B01001_036E']), ageTotal)],
      ['35-44 years', pct(sum(['B01001_013E','B01001_014E','B01001_037E','B01001_038E']), ageTotal)],
      ['45-54 years', pct(sum(['B01001_015E','B01001_016E','B01001_039E','B01001_040E']), ageTotal)],
      ['55-64 years', pct(sum(['B01001_017E','B01001_018E','B01001_019E','B01001_041E','B01001_042E','B01001_043E']), ageTotal)],
      ['65+ years', pct(sum(['B01001_020E','B01001_021E','B01001_022E','B01001_023E','B01001_024E','B01001_025E','B01001_044E','B01001_045E','B01001_046E','B01001_047E','B01001_048E','B01001_049E']), ageTotal)]
    ];
    const raceTotal = n(d,'B03002_001E');
    const races = [
      ['White', pct(n(d,'B03002_003E'), raceTotal)],
      ['Asian', pct(n(d,'B03002_006E'), raceTotal)],
      ['Hispanic', pct(n(d,'B03002_012E'), raceTotal)],
      ['Black', pct(n(d,'B03002_004E'), raceTotal)],
      ['Two or more races', pct(n(d,'B03002_009E'), raceTotal)],
      ['Other', pct(n(d,'B03002_005E') + n(d,'B03002_007E') + n(d,'B03002_008E'), raceTotal)]
    ].filter(([,v]) => v !== null && v > 0);
    const gender = [
      ['Female', pct(n(d,'B01001_026E'), ageTotal)],
      ['Male', pct(n(d,'B01001_002E'), ageTotal)]
    ];
    const bachelorsPlus = eduTotal ? (bachelor + masters) : (p.DP02_0068PE > 0 ? +p.DP02_0068PE : null);
    return {
      pop:(+p.DP05_0001E).toLocaleString(),
      income: p.DP03_0062E>0 ? '$'+(+p.DP03_0062E).toLocaleString() : 'n/a',
      home: p.DP04_0089E>0 ? '$'+(+p.DP04_0089E).toLocaleString() : 'n/a',
      bachelors: bachelorsPlus != null ? `${bachelorsPlus}%` : 'n/a',
      demographics:{
        education:[["Master's degree or higher", masters], ["Bachelor's degree", bachelor], ["Some college or associate's degree", someCollege], ['High school diploma or equivalent', highSchool], ['Less than high school diploma', lessHs]],
        gender,
        age:ages,
        race:races
      }
    };
  }catch(e){ return null; }
}
async function femaFloodZone(lat, lon){
  const url=`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query`
    +`?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326`
    +`&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY&returnGeometry=false&f=json`;
  try{
    const res=await fetch(url); if(!res.ok) return null;
    const j=await res.json(); const f=(j.features||[])[0];
    if(!f) return {zone:'X', label:'No Risk', score:0, desc:'Outside mapped Special Flood Hazard Area (Zone X / minimal).'};
    const z=f.attributes.FLD_ZONE||'X'; const sub=f.attributes.ZONE_SUBTY||'';
    const high=/^(A|AE|AH|AO|A99|V|VE)/.test(z);
    return high
      ? {zone:z, label:'High Risk', score:8, desc:`Within FEMA Special Flood Hazard Area (Zone ${z}${sub?' — '+sub:''}). Flood insurance typically required.`}
      : {zone:z, label:'Low Risk', score:2, desc:`FEMA Zone ${z}${sub?' — '+sub:''} (minimal/moderate). No mandatory flood insurance.`};
  }catch(e){ return null; }
}

/* ---------- Live hazard point-queries (CGS / CAL FIRE) ---------- */
/* Uses esri-leaflet's query engine: it falls back to JSONP when a server
   (like gis.conservation.ca.gov) doesn't send CORS headers, so these work
   in the browser where plain fetch() would be blocked. */
function esriQuery(url, build){
  return new Promise(resolve=>{
    if(!(window.L && window.L.esri)) return resolve(null);
    try{
      build(L.esri.query({url})).returnGeometry(false).run((err,fc)=>{
        resolve(err ? null : ((fc && fc.features) || []));
      });
    }catch(e){ resolve(null); }
  });
}
const IMP=(level,why)=>({level,why});
const SUPERFUND_NPL_URL = 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/ArcGIS/rest/services/FAC_Superfund_Site_Boundaries_EPA_Public/FeatureServer/0';

async function cgsLiquefaction(lat,lon){
  const f=await esriQuery('https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Liquefaction_Zones/MapServer/0',
                          q=>q.intersects(L.latLng(lat,lon)));
  if(f===null) return null;
  return f.length
    ? {label:'High Risk',score:7,desc:'Inside a CGS liquefaction Zone of Required Investigation at this point.',
       impacts:{property:IMP('High','Mapped liquefaction zone \u2014 site investigation required for development.'),insurance:IMP('Moderate','Adds to earthquake / structural coverage cost.')}}
    : {label:'Low Risk',score:1,desc:'Outside mapped CGS liquefaction zones at this point.',
       impacts:{property:IMP('Low','Not in a mapped liquefaction zone.'),insurance:IMP('Low','No liquefaction-zone surcharge context.')}};
}
async function cgsLandslide(lat,lon){
  const f=await esriQuery('https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Landslide_Zones/MapServer/0',
                          q=>q.intersects(L.latLng(lat,lon)));
  if(f===null) return null;
  return f.length
    ? {label:'High Risk',score:7,desc:'Inside a CGS earthquake-induced landslide zone at this point.',
       impacts:{property:IMP('High','Mapped landslide zone \u2014 slope-stability investigation applies.')}}
    : {label:'Low Risk',score:1,desc:'Outside mapped CGS landslide zones at this point.',
       impacts:{property:IMP('Low','Not in a mapped landslide zone.')}};
}
async function cgsFault(lat,lon){
  const local = await localFaultRisk(lat, lon).catch(()=>null);
  if(local) return local;

  const f=await esriQuery('https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Fault_Zones/FeatureServer/0',
                          q=>q.nearby(L.latLng(lat,lon), 500));
  if(f===null) return null;
  return f.length
    ? {label:'High Risk',score:8,desc:'Within ~500 m of an Alquist-Priolo earthquake fault zone.',
       impacts:{property:IMP('High','Fault-zone proximity - disclosure required, surface-rupture exposure.'),insurance:IMP('High','Earthquake coverage priced for near-fault exposure.')}}
    : {label:'Low Risk',score:2,desc:'No Alquist-Priolo fault zone within ~500 m of this point.',
       impacts:{property:IMP('Low','No mapped fault zone in the immediate vicinity.'),insurance:IMP('Moderate','Regional earthquake exposure still applies (statewide).')}};
}
async function cgsTsunami(lat, lon){
  const fc = await loadTsunamiData().catch(()=>null);
  if(!fc) return null;
  const inside = geojsonContainsPoint(fc, lon, lat);
  return inside
    ? {label:'High Risk',score:8,desc:'Inside the CGS Tsunami Hazard Area for Emergency Planning screening layer at this point.',
       impacts:{health:IMP('High','Mapped tsunami hazard areas are life-safety evacuation zones during rare coastal events.'),property:IMP('Moderate','Coastal inundation planning context should be reviewed during due diligence.'),insurance:IMP('Moderate','Flood / coastal hazard coverage may need closer review.')}}
    : {label:'Low Risk',score:1,desc:'Outside the CGS Tsunami Hazard Area for Emergency Planning screening layer at this point.',
       impacts:{health:IMP('Low','No mapped tsunami evacuation exposure at this point.'),property:IMP('Low','Not in the local CGS tsunami hazard screening area.'),insurance:IMP('Low','No mapped tsunami hazard context for this point.')}};
}
function nplSiteName(feature){
  const p = (feature && (feature.properties || feature.attributes)) || {};
  return p.SITE_NAME || p.SITE_FEATURE_NAME || p.EPA_ID || 'EPA NPL Superfund boundary';
}

async function epaSuperfundNpl(lat, lon){
  const point = L.latLng(lat, lon);
  const query = (meters) => esriQuery(SUPERFUND_NPL_URL, q => {
    const next = meters ? q.nearby(point, meters) : q.intersects(point);
    return next.where("STATE_CODE = 'CA'");
  });
  const inside = await query(0);
  if(inside === null) return null;
  if(inside.length){
    const name = nplSiteName(inside[0]);
    return {label:'High Risk',score:9,desc:`Inside or directly touching an EPA National Priorities List Superfund boundary (${name}).`,
      impacts:{health:IMP('High','NPL boundary overlap needs careful contamination and exposure due diligence.'),property:IMP('High','Direct Superfund boundary context can materially affect buyer perception and value.'),insurance:IMP('NA','Not a standard property-insurance pricing factor.')}};
  }
  const within1 = await query(1609.34);
  if(within1 === null) return null;
  if(within1.length){
    const name = nplSiteName(within1[0]);
    return {label:'High Risk',score:8,desc:`EPA NPL Superfund boundary within 1 mile (${name}).`,
      impacts:{health:IMP('High','Nearby NPL contamination warrants review of EPA site documents and exposure pathways.'),property:IMP('High','Very close Superfund proximity can affect demand and due diligence.'),insurance:IMP('NA','Not a standard property-insurance pricing factor.')}};
  }
  const within5 = await query(8046.72);
  if(within5 === null) return null;
  if(within5.length){
    const name = nplSiteName(within5[0]);
    return {label:'Moderate Risk',score:6,desc:`EPA NPL Superfund boundary within 5 miles (${name}).`,
      impacts:{health:IMP('Moderate','Regional Superfund proximity should be reviewed, especially groundwater or air pathways.'),property:IMP('Moderate','Nearby NPL context may affect buyer questions and local perception.'),insurance:IMP('NA','Not a standard property-insurance pricing factor.')}};
  }
  const within10 = await query(16093.4);
  if(within10 === null) return null;
  if(within10.length){
    const name = nplSiteName(within10[0]);
    return {label:'Low Risk',score:3,desc:`EPA NPL Superfund boundary within 10 miles (${name}).`,
      impacts:{health:IMP('Low','Distant NPL proximity is context only unless pathways extend toward the address.'),property:IMP('Low','Distant Superfund context is typically a due-diligence note.'),insurance:IMP('NA','Not a standard property-insurance pricing factor.')}};
  }
  return {label:'Low Risk',score:1,desc:'No EPA NPL Superfund boundary found within 10 miles of this address.',
    impacts:{health:IMP('Low','No nearby NPL boundary found in the live 10-mile check.'),property:IMP('Low','No nearby NPL boundary found in the live 10-mile check.'),insurance:IMP('NA','Not a standard property-insurance pricing factor.')}};
}

async function calfireFHSZ(lat,lon){
  const f=await esriQuery('https://services.gis.ca.gov/arcgis/rest/services/Environment/Fire_Severity_Zones/MapServer/0',
                          q=>q.intersects(L.latLng(lat,lon)));
  if(f===null) return null;
  if(!f.length) return {label:'Low Risk',score:2,desc:'Not in a designated Fire Hazard Severity Zone at this point.',
    impacts:{insurance:IMP('Low','No FHSZ designation here.'),property:IMP('Low','Outside designated hazard zones.')}};
  const txt=JSON.stringify(f[0].properties||f[0].attributes||{}).toLowerCase();
  if(txt.includes('very high')) return {label:'High Risk',score:9,desc:'CAL FIRE Very High Fire Hazard Severity Zone at this point.',
    impacts:{insurance:IMP('High','VHFHSZ drives costly or non-renewed coverage.'),property:IMP('Moderate','Wildfire-loss exposure weighs on value.'),health:IMP('Low','Smoke episodes affect respiratory health.')}};
  if(txt.includes('high')) return {label:'High Risk',score:8,desc:'CAL FIRE High Fire Hazard Severity Zone at this point.',
    impacts:{insurance:IMP('High','High FHSZ raises premiums and renewal risk.'),property:IMP('Moderate','Wildfire exposure weighs on value.')}};
  if(txt.includes('moderate')) return {label:'Moderate Risk',score:5,desc:'CAL FIRE Moderate Fire Hazard Severity Zone at this point.',
    impacts:{insurance:IMP('Moderate','Moderate FHSZ affects pricing.')}};
  return {label:'Low Risk',score:3,desc:'In a Fire Hazard Severity Zone with an unclassified designation here.'};
}

/* ---------- Live livability lookups (OpenStreetMap Overpass) ---------- */
function emptyAmenityCounts(){
  return {uni:0,eat:0,shop:0,park:0,health:0,hosp:0,transit:0,station:0,junction:0,constr:0,community:0,_fallback:true};
}

const AMENITY_BASELINES = {
  // Baseline counts keep the report useful when OpenStreetMap/Overpass is slow.
  // Live counts replace these whenever the Render/OSM lookup succeeds.
  '94583': {eat:82, shop:55, park:47, transit:23, station:0, health:12, community:9, constr:0},
  '94582': {eat:42, shop:31, park:38, transit:12, station:0, health:8, community:6, constr:1},
  '94526': {eat:92, shop:64, park:33, transit:16, station:0, health:14, community:8, constr:0},
  '94506': {eat:34, shop:22, park:29, transit:8, station:0, health:5, community:5, constr:0},
  '94102': {eat:260, shop:190, park:24, transit:180, station:18, health:45, community:22, constr:6},
  '94041': {eat:138, shop:104, park:19, transit:50, station:2, health:24, community:11, constr:2},
  '95814': {eat:150, shop:95, park:21, transit:85, station:4, health:28, community:14, constr:5},
};
function baselineAmenityCounts(st){
  const base = AMENITY_BASELINES[String(st?.zip || '')];
  if(!base) return null;
  return {...emptyAmenityCounts(), ...base, _fallback:true};
}
function amenityTotal(c){
  return c ? ['eat','shop','park','health','transit','station','community','constr'].reduce((sum,k)=>sum+(+c[k]||0),0) : 0;
}
function amenityQuery(lat,lon){
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
function countAmenityElements(elements){
  const c = emptyAmenityCounts();
  delete c._fallback;
  (elements||[]).forEach(e=>{const t=e.tags||{};
    if(/^(university|college)$/.test(t.amenity||'')) c.uni++;
    else if(/^(restaurant|cafe|fast_food)$/.test(t.amenity||'')) c.eat++;
    else if(t.shop) c.shop++;
    else if(/^(park|playground|pitch|garden)$/.test(t.leisure||'')) c.park++;
    else if((t.amenity||'')==='hospital'){c.hosp++;c.health++;}
    else if(/^(clinic|doctors|pharmacy)$/.test(t.amenity||'')) c.health++;
    else if(t.highway==='bus_stop'||t.public_transport==='platform') c.transit++;
    else if(t.railway==='station') c.station++;
    else if(t.highway==='motorway_junction') c.junction++;
    else if(t.landuse==='construction'||t.building==='construction') c.constr++;
    else if(/^(library|community_centre|place_of_worship)$/.test(t.amenity||'')) c.community++;
  });
  return c;
}
async function overpassAmenitiesBackend(lat,lon){
  const base = ((window.APP_CONFIG||{}).MAPSHOT_API_BASE || '').replace(/\/+$/,'');
  if(!base) return null;
  try{
    const cacheBust = `${ANALYZE_RUN}-${Date.now()}`;
    const res = await fetchWithAbort(`${base}/api/amenities?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&_=${encodeURIComponent(cacheBust)}`, {
      headers:{'Accept':'application/json','Cache-Control':'no-cache'},
      cache:'no-store'
    }, 6500);
    if(!res.ok) return null;
    const j = await res.json();
    return j && j.counts ? j.counts : null;
  }catch(e){ return null; }
}
async function overpassAmenitiesDirect(lat,lon){
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  const body = new URLSearchParams({data:amenityQuery(lat,lon)});
  for(const endpoint of endpoints){
    try{
      const res = await fetchWithAbort(endpoint, {method:'POST', body}, 18000);
      if(!res.ok) continue;
      const j = await res.json();
      const counts = countAmenityElements(j.elements || []);
      if(amenityTotal(counts) > 0) return counts;
    }catch(e){}
  }
  return null;
}
async function overpassAmenities(st){
  const lat = st.lat, lon = st.lon;
  const live = await overpassAmenitiesBackend(lat,lon);
  if(amenityTotal(live) > 0) return live;
  const baseline = baselineAmenityCounts(st);
  if(baseline) return baseline;
  const direct = await overpassAmenitiesDirect(lat,lon);
  return amenityTotal(direct) > 0 ? direct : null;
}

function schoolAccessQuery(lat, lon){
  return `[out:json][timeout:20];(
    nwr(around:3219,${lat},${lon})[amenity=school];
    nwr(around:3219,${lat},${lon})[amenity=kindergarten];
  );out center tags qt 300;`;
}

function schoolElementPoint(e){
  if(typeof e.lat === 'number' && typeof e.lon === 'number') return {lat:e.lat, lon:e.lon};
  if(e.center && typeof e.center.lat === 'number' && typeof e.center.lon === 'number') return {lat:e.center.lat, lon:e.center.lon};
  return null;
}

function distanceMiles(aLat, aLon, bLat, bLon){
  const R = 3958.8;
  const dLat = (bLat-aLat) * Math.PI / 180;
  const dLon = (bLon-aLon) * Math.PI / 180;
  const lat1 = aLat * Math.PI / 180;
  const lat2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function schoolAccessResult(st, elements){
  const seen = new Set();
  const schools = [];
  (elements || []).forEach(e => {
    const p = schoolElementPoint(e);
    if(!p) return;
    const tags = e.tags || {};
    const name = tags.name || tags.operator || 'Mapped school';
    const key = `${e.type || 'n'}-${e.id || name}`;
    if(seen.has(key)) return;
    seen.add(key);
    schools.push({name, dist: distanceMiles(st.lat, st.lon, p.lat, p.lon)});
  });
  schools.sort((a,b)=>a.dist-b.dist);
  const count = schools.length;
  const nearest = schools[0] || null;
  const distText = nearest ? `${nearest.dist.toFixed(nearest.dist < 1 ? 2 : 1)} miles` : 'not found within 2 miles';
  const nameText = nearest ? `; nearest: ${nearest.name} (${distText})` : '';
  const desc = `Live OpenStreetMap school-access check: ${count} mapped school site(s) within 2 miles${nameText}. This is an access proxy, not an official school-quality rating.`;
  if(count >= 3 || (nearest && nearest.dist <= 0.75)){
    return {label:'Low Risk',score:2,desc,
      impacts:{health:IMP('NA','No direct health effect.'),property:IMP('Low','Multiple nearby mapped schools support location convenience; verify assigned schools and ratings separately.'),insurance:IMP('NA','Not used in insurance pricing.')}};
  }
  if(count >= 1 || (nearest && nearest.dist <= 2)){
    return {label:'Moderate Risk',score:5,desc,
      impacts:{health:IMP('NA','No direct health effect.'),property:IMP('Moderate','Some school access is nearby, but school assignment and ratings still need review.'),insurance:IMP('NA','Not used in insurance pricing.')}};
  }
  return {label:'High Risk',score:8,desc,
    impacts:{health:IMP('NA','No direct health effect.'),property:IMP('High','No mapped schools found within 2 miles in the live access check; verify with district boundaries and school-rating sources.'),insurance:IMP('NA','Not used in insurance pricing.')}};
}

async function schoolAccess(st){
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  const body = new URLSearchParams({data:schoolAccessQuery(st.lat, st.lon)});
  for(const endpoint of endpoints){
    try{
      const res = await fetchWithAbort(endpoint, {method:'POST', body}, 14000);
      if(!res.ok) continue;
      const j = await res.json();
      return schoolAccessResult(st, j.elements || []);
    }catch(e){}
  }
  return null;
}

function crimeSafetyQuery(lat, lon){
  return `[out:json][timeout:20];(
    nwr(around:4828,${lat},${lon})[amenity=police];
    nwr(around:4828,${lat},${lon})[amenity=fire_station];
    nwr(around:4828,${lat},${lon})[amenity=hospital];
    nwr(around:4828,${lat},${lon})[emergency=ambulance_station];
  );out center tags qt 400;`;
}

function crimeFacilityType(tags){
  if(!tags) return null;
  if(tags.amenity === 'police') return 'police';
  if(tags.amenity === 'fire_station') return 'fire';
  if(tags.amenity === 'hospital') return 'hospital';
  if(tags.emergency === 'ambulance_station') return 'ambulance';
  return null;
}

function crimeFacilityLabel(type){
  return ({police:'Police', fire:'Fire station', hospital:'Hospital', ambulance:'Ambulance station'}[type]) || 'Public safety';
}

function crimeSafetyFacilities(st, elements){
  const seen = new Set();
  const facilities = [];
  (elements || []).forEach(e => {
    const p = schoolElementPoint(e);
    if(!p) return;
    const tags = e.tags || {};
    const type = crimeFacilityType(tags);
    if(!type) return;
    const name = tags.name || tags.operator || crimeFacilityLabel(type);
    const key = `${e.type || 'n'}-${e.id || name}-${type}`;
    if(seen.has(key)) return;
    seen.add(key);
    facilities.push({type, name, lat:p.lat, lon:p.lon, dist:distanceMiles(st.lat, st.lon, p.lat, p.lon)});
  });
  return facilities.sort((a,b)=>a.dist-b.dist);
}

function crimeSafetyResult(st, elements){
  const facilities = crimeSafetyFacilities(st, elements);
  const counts = facilities.reduce((acc, f) => { acc[f.type] = (acc[f.type] || 0) + 1; return acc; }, {});
  const police = counts.police || 0;
  const fire = counts.fire || 0;
  const hospital = counts.hospital || 0;
  const ambulance = counts.ambulance || 0;
  const nearestPolice = facilities.find(f => f.type === 'police');
  const nearestText = nearestPolice
    ? `${nearestPolice.name} (${nearestPolice.dist.toFixed(nearestPolice.dist < 1 ? 2 : 1)} miles)`
    : 'no mapped police station within 3 miles';
  const desc = `Live safety-access proxy from OpenStreetMap: ${police} police, ${fire} fire, ${hospital} hospital, ${ambulance} ambulance station(s) within 3 miles; nearest police: ${nearestText}. Open CrimeMapping for participating-agency incident maps.`;
  if(police >= 1 && nearestPolice && nearestPolice.dist <= 2){
    return {label:'Low Risk',score:3,desc,
      impacts:{health:IMP('Low','Mapped public-safety access is nearby; verify reported incidents in CrimeMapping or local police data.'),property:IMP('Low','Nearby public-safety services support location confidence, but incident rates still need review.'),insurance:IMP('Low','Safety-service access is context only; insurers use broader claims and crime data.')}};
  }
  if(police >= 1 || fire + hospital + ambulance >= 2){
    return {label:'Moderate Risk',score:5,desc,
      impacts:{health:IMP('Low','Some public-safety or emergency access is mapped nearby; verify reported incidents separately.'),property:IMP('Moderate','Public-safety access is mixed; review reported incidents before relying on this score.'),insurance:IMP('Low','Context only; insurance impact depends on broader claims and crime data.')}};
  }
  return {label:'High Risk',score:8,desc,
    impacts:{health:IMP('Moderate','No nearby mapped public-safety facility was found in this proxy check.'),property:IMP('Moderate','Sparse mapped safety access may raise due-diligence questions; verify with local agencies.'),insurance:IMP('Low','Context only; insurance impact depends on broader claims and crime data.')}};
}

async function fetchCrimeSafetyElements(st){
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  const data = crimeSafetyQuery(st.lat, st.lon);
  for(const endpoint of endpoints){
    try{
      const res = await fetchWithAbort(endpoint, {method:'POST', body:new URLSearchParams({data})}, 14000);
      if(!res.ok) continue;
      const j = await res.json();
      return j.elements || [];
    }catch(e){}
  }
  return null;
}

async function crimeSafety(st){
  const elements = await fetchCrimeSafetyElements(st);
  if(!elements) return null;
  return crimeSafetyResult(st, elements);
}

async function localEnvironment(lat, lon){
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
  const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}`
    + `&current=us_aqi,pm2_5,ozone&timezone=auto`;
  try{
    const [weatherRes, airRes] = await Promise.allSettled([
      fetch(weatherUrl).then(r=>r.ok?r.json():null),
      fetch(airUrl).then(r=>r.ok?r.json():null)
    ]);
    return {
      weather: weatherRes.status === 'fulfilled' ? weatherRes.value : null,
      air: airRes.status === 'fulfilled' ? airRes.value : null
    };
  }catch(e){ return null; }
}

function livabilityResults(c, census){
  const out={};
  if(c){
    out[37] = c.uni>0
      ? {label:'No Risk',score:0,desc:`${c.uni} college/university campus feature(s) within ~1.5 mi.`,impacts:{property:IMP('No','Campus proximity supports rental demand.')}}
      : {label:'Low Risk',score:2,desc:'No college/university mapped within ~1.5 mi (context, not a hazard).'};
    const retail=c.eat+c.shop;
    out[38] = retail>=40 ? {label:'No Risk',score:0,desc:`${c.eat} eateries and ${c.shop} shops within ~1 mi — amenity-rich.`,impacts:{property:IMP('No','Strong retail/dining density supports value.')}}
      : retail>=10 ? {label:'Low Risk',score:2,desc:`${c.eat} eateries and ${c.shop} shops within ~1 mi.`}
      : {label:'Moderate Risk',score:5,desc:`Only ${retail} dining/retail places mapped within ~1 mi — car-dependent for errands.`,impacts:{property:IMP('Moderate','Thin local amenities can soften demand.')}};
    out[39] = c.park>=5 ? {label:'No Risk',score:0,desc:`${c.park} parks/playgrounds/green spaces within ~1 mi.`,impacts:{health:IMP('No','Good green-space access.')}}
      : c.park>=1 ? {label:'Low Risk',score:2,desc:`${c.park} park feature(s) within ~1 mi.`}
      : {label:'Moderate Risk',score:5,desc:'No parks mapped within ~1 mi.',impacts:{health:IMP('Moderate','Limited nearby green space.')}};
    const walk=c.transit+c.station;
    out[40] = walk>=15 ? {label:'No Risk',score:0,desc:`${c.transit} transit stops${c.station?` + ${c.station} rail station(s)`:''} within walking range.`,impacts:{property:IMP('No','Transit-rich, walkable location.')}}
      : walk>=5 ? {label:'Low Risk',score:2,desc:`${walk} transit stop(s) within walking range.`}
      : walk>=1 ? {label:'Moderate Risk',score:5,desc:`Only ${walk} transit stop(s) within walking range — mostly car-dependent.`}
      : {label:'Moderate Risk',score:6,desc:'No transit stops mapped within walking range — car-dependent.',impacts:{property:IMP('Moderate','Car-dependence narrows the buyer pool.'),health:IMP('Low','Less walkable daily environment.')}};
    out[41] = (c.junction>0 && c.station>0) ? {label:'No Risk',score:0,desc:'Freeway access (~2.5 mi) and a rail station (~2 mi) both within reach.'}
      : c.junction>0 ? {label:'Low Risk',score:2,desc:'Freeway on-ramp within ~2.5 mi; no rail station within ~2 mi.'}
      : {label:'Moderate Risk',score:5,desc:'No freeway ramp within ~2.5 mi — longer surface-street commutes.',impacts:{property:IMP('Moderate','Weak regional access can weigh on resale.')}};
    out[42] = c.hosp>0 ? {label:'No Risk',score:0,desc:`Hospital within ~1.2 mi (${c.health} healthcare features nearby overall).`,impacts:{health:IMP('No','Emergency care is close.')}}
      : c.health>0 ? {label:'Low Risk',score:2,desc:`${c.health} clinic/pharmacy feature(s) within ~1.2 mi; nearest hospital is farther.`}
      : {label:'High Risk',score:8,desc:'No healthcare facilities mapped within ~1.2 mi.',impacts:{health:IMP('High','Distance to care matters in emergencies.')}};
    out[44] = c.community>=5 ? {label:'No Risk',score:0,desc:`${c.community} community places (libraries, centers, congregations) within ~1 mi.`}
      : c.community>=1 ? {label:'Low Risk',score:2,desc:`${c.community} community place(s) within ~1 mi.`}
      : {label:'Moderate Risk',score:5,desc:'No community infrastructure mapped within ~1 mi.'};
    out[45] = c.constr>=4 ? {label:'Moderate Risk',score:5,desc:`${c.constr} active construction sites mapped within ~1 mi — growth, but expect change/noise.`,impacts:{property:IMP('Moderate','Heavy nearby construction: short-term nuisance, uncertain end-state.')}}
      : c.constr>=1 ? {label:'Low Risk',score:2,desc:`${c.constr} construction site(s) mapped within ~1 mi.`}
      : {label:'No Risk',score:0,desc:'No active construction mapped within ~1 mi.'};
  }
  if(census && census.home && census.home!=='n/a'){
    out[43] = {label:'No Risk',score:0,desc:`ZIP median home value ${census.home} (Census ACS). Open the Zillow link for market trends.`,
               impacts:{insurance:IMP('Low','Replacement cost scales with local values.')}};
  }
  return out;
}

/* ---------- Render ---------- */
function badge(label, score){
  const k = !label ? 'pending' : label.toLowerCase().includes('high') ? 'high'
    : label.toLowerCase().includes('moderate') ? 'mod'
    : label.toLowerCase().includes('low') ? 'low' : 'no';
  const txt = label ? `${label}${score!=null?' · '+score+'/10':''}` : 'Open map to assess';
  return `<span class="bdg ${k==='pending'?'pending':''}" style="${k!=='pending'?`background:${RC[k]}`:''}">${txt}</span>`;
}

function demoBar([label, value]){
  const v = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const text = Number.isFinite(value) ? `${Math.round(value)}%` : 'n/a';
  return `<div class="demo-bar"><div class="demo-fill" style="width:${v}%"></div><span>${label}</span><b>${text}</b></div>`;
}

function demoPanel(title, rows){
  return `<div class="demo-panel"><h4>${title}</h4>${(rows||[]).map(demoBar).join('')}</div>`;
}

function renderProfile(c, st){
  if(c){
    const d = c.demographics || {};
    const summary=[['Population (ZIP)',c.pop],['Median Household Income',c.income],['Median Home Value',c.home],["Bachelor's+ Degree",c.bachelors]];
    $('#profile').innerHTML = `<div class="demo-card">
      <div class="demo-head"><div><span>ZIP ${st?.zip||''}</span><h3>Demographics</h3></div><p>U.S. Census ACS ${((window.APP_CONFIG||{}).ACS_YEAR||'2023')} ZIP/ZCTA data</p></div>
      <div class="demo-summary">${summary.map(([k,v])=>`<div class="prof"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
      <div class="demo-grid">
        ${demoPanel('Education Levels', d.education)}
        ${demoPanel('Gender', d.gender)}
        ${demoPanel('Age', d.age)}
        ${demoPanel('Racial Diversity', d.race)}
      </div>
    </div>`;
  } else if(st){
    const zlink=`https://www.zipdatamaps.com/${st.zip||''}`;
    $('#profile').innerHTML = `<div class="prof demo-empty"><div class="k">ZIP ${st.zip||''} demographics</div>`
      +`<div class="v" style="font-weight:500;font-size:12px">Add a free <a href="https://api.census.gov/data/key_signup.html" target="_blank" rel="noopener">Census API key</a> in <code>config.js</code> to auto-load Census demographics — or <a href="${zlink}" target="_blank" rel="noopener">view the ZIP profile ↗</a>.</div></div>`;
  } else {
    $('#profile').innerHTML = `<div class="prof"><div class="k">Demographics</div><div class="v">Loading…</div></div>`;
  }
}

function renderLegend(){
  const L=[['no','No'],['low','Low'],['mod','Moderate'],['high','High']];
  $('#legend').innerHTML = L.map(([k,t])=>`<span class="pill" style="background:${RC[k]}">${t} Risk</span>`).join('')
    + `<span class="pill" style="background:${RC.pending}">Open map to assess</span>`;
}

function renderScoring(){
  $('#scoring').innerHTML = `<b>How to read this.</b> Each factor is scored 0–10 and grouped:
    <span class="sw" style="background:${RC.no}"></span><b>0 = No</b>,
    <span class="sw" style="background:${RC.low}"></span><b>1–4 = Low</b>,
    <span class="sw" style="background:${RC.mod}"></span><b>5–7 = Moderate</b>,
    <span class="sw" style="background:${RC.high}"></span><b>8–10 = High</b>.
    Ratings use live public-agency data (FEMA flood, U.S. Census, and more) where an API exists; every other factor
    shows its typical impact and a live agency map recentered on your address. Informational screening only.`;
}

let SUMMARY_ITEMS = {};
let SELECTED_FACTOR = null;

function renderSummaryTable(st, liveResults){
  const gz=$('#glanceZip'); if(gz) gz.textContent = st.zip ? `\u2014 ZIP ${st.zip} \u00b7 ${ZIP_CITY[st.zip]||st.city||''}` : '';
  const NOTES = localNotesFor(st);
  const cell = o => `<td class="impcell">${lvlPill(o.level)}<span class="w">${o.why}</span></td>`;
  const whatCell = (f, what) => {
    const imgs = (window.FACTOR_EXPLAIN||{})[f.n]||[];
    if(!imgs.length) return what;
    return `${what}
      <button class="impact-link" type="button" data-n="${f.n}" aria-expanded="false" aria-controls="explain-${f.n}">Read more</button>
      <div class="inline-explain hidden" id="explain-${f.n}" data-name="${f.name}" data-srcs="${imgs.join('|')}"></div>`;
  };
  SUMMARY_ITEMS = {};
  const rows = FACTORS.map(f=>{
    const cat = f.cat || 'Other';
    const live=liveResults[f.n]; const rk=riskKey(live&&live.label);
    const localNote = NOTES[f.n] ? `<div class="localnote">\ud83d\udccd ${NOTES[f.n]}</div>` : '';
    const what=((live&&live.desc)?live.desc:f.detail) + localNote;
    const im=effImpact(f,live);
    const mapUrl=fill(f.map, st);
    const detailBtn = `<button class="detail-arrow" type="button" data-detail="${f.n}" aria-label="Open details for ${f.name}">➜</button>`;
    const mapAction = f.n === 3
      ? `<button class="rk-link map-open crime-map-open" type="button" data-crime-map="3">Open map</button>`
      : f.n === 5
        ? `<button class="rk-link map-open map-embed-open" type="button" data-fault-map="5">Open map</button>`
        : f.n === 6
          ? `<button class="rk-link map-open liquefaction-map-open" type="button" data-liquefaction-map="6">Open map</button>`
          : f.n === 15
            ? `<button class="rk-link map-open npl-map-open" type="button" data-npl-map="15">Open map</button>`
            : f.n === 46
              ? `<button class="rk-link map-open tsunami-map-open" type="button" data-tsunami-map="46">Open map</button>`
              : `<a class="rk-link map-open" href="${mapUrl}" target="_blank" rel="noopener">Open map</a>`;
    const links = `<span class="link-actions">${mapAction}${detailBtn}</span>`;
    const rowRisk = live ? live.score
      : Math.max(0, ...['health','property','insurance'].map(k=>LVLNUM[im[k].level] ?? 0));
    const imgs = (window.FACTOR_EXPLAIN||{})[f.n]||[];
    SUMMARY_ITEMS[f.n] = {f, live, rk, what, im, mapUrl, links, rowRisk, imgs};
    return `<tr id="sumrow-${f.n}" class="summary-row" data-cat="${cat}" data-name="${(f.name+' '+cat).toLowerCase()}" data-risk="${rowRisk}">
      <td class="num">${f.n}</td>
      <td><div class="fname">${f.name}${live?' <span class="livechip">LIVE</span>':''}</div><div class="fcat">${cat}</div></td>
      <td class="what">${whatCell(f, what)}</td>
      ${cell(im.health)}${cell(im.property)}${cell(im.insurance)}
      <td class="rk rk-${rk}">${links}</td>
    </tr>`;
  }).join('');
  $('#summaryTable').innerHTML =
    `<colgroup><col class="c-num"><col class="c-fac"><col class="c-what">
       <col class="c-imp"><col class="c-imp"><col class="c-imp"><col class="c-rk"></colgroup>
     <thead><tr>
       <th>#</th><th>Factor</th><th>What it is</th>
       <th>Health impact</th><th>Property&nbsp;Value impact</th><th>Insurance impact</th><th>Links</th>
     </tr></thead><tbody>${rows}</tbody>`;
  buildGlanceControls();
  wireImpactLinks();
  wireSummaryRows();
}

/* Impact-summary mapping embedded directly (fallback if explanations.js fails to load) */
window.FACTOR_EXPLAIN = window.FACTOR_EXPLAIN || {
  5: ["explanations/f5_1.jpg"],
  6: ["explanations/f6_1.jpg"],
  7: ["explanations/f7_1.jpg", "explanations/f7_2.jpg"],
  8: ["explanations/f8_1.jpg", "explanations/f8_2.jpg"],
  9: ["explanations/f9_1.jpg", "explanations/f9_2.jpg"],
  10: ["explanations/f10_1.jpg", "explanations/f10_2.jpg"],
  11: ["explanations/f11_1.jpg", "explanations/f11_2.jpg"],
  13: ["explanations/f13_1.jpg", "explanations/f13_2.jpg"],
  14: ["explanations/f14_1.jpg", "explanations/f14_2.jpg", "explanations/f14_3.jpg"],
  15: ["explanations/f15_1.jpg", "explanations/f15_2.jpg", "explanations/f15_3.jpg", "explanations/f15_4.jpg", "explanations/f15_5.jpg", "explanations/f15_6.jpg"],
  16: ["explanations/f16_1.jpg", "explanations/f16_2.jpg", "explanations/f16_3.jpg", "explanations/f16_4.jpg"],
  17: ["explanations/f17_1.jpg", "explanations/f17_2.jpg", "explanations/f17_3.jpg", "explanations/f17_4.jpg"],
  18: ["explanations/f18_1.jpg", "explanations/f18_2.jpg"],
  19: ["explanations/f19_1.jpg", "explanations/f19_2.jpg", "explanations/f19_3.jpg", "explanations/f19_4.jpg"],
  23: ["explanations/f23_1.jpg"],
  24: ["explanations/f24_1.jpg", "explanations/f24_2.jpg", "explanations/f24_3.jpg"],
  25: ["explanations/f25_1.jpg", "explanations/f25_2.jpg", "explanations/f25_3.jpg", "explanations/f25_4.jpg"],
  26: ["explanations/f26_1.jpg", "explanations/f26_2.jpg", "explanations/f26_3.jpg", "explanations/f26_4.jpg"],
  27: ["explanations/f27_1.jpg", "explanations/f27_2.jpg"],
  28: ["explanations/f28_1.jpg", "explanations/f28_2.jpg", "explanations/f28_3.jpg", "explanations/f28_4.jpg"],
  29: ["explanations/f29_1.jpg", "explanations/f29_2.jpg", "explanations/f29_3.jpg", "explanations/f29_4.jpg"],
  30: ["explanations/f30_1.jpg", "explanations/f30_2.jpg", "explanations/f30_3.jpg"],
  31: ["explanations/f31_1.jpg", "explanations/f31_2.jpg"],
  32: ["explanations/f32_1.jpg", "explanations/f32_2.jpg"],
  33: ["explanations/f33_1.jpg", "explanations/f33_2.jpg", "explanations/f33_3.jpg", "explanations/f33_4.jpg"],
};

/* ---------- Inline impact summaries (from factor-explanation workbooks) ---------- */
function wireImpactLinks(){
  document.querySelectorAll('#summaryTable .impact-link').forEach(btn=>btn.addEventListener('click',e=>{
    e.preventDefault();
    const panel = document.getElementById(`explain-${btn.dataset.n}`);
    if(!panel) return;
    const isOpen = !panel.classList.contains('hidden');
    if(!isOpen && !panel.dataset.loaded){
      const name = panel.dataset.name || 'Factor';
      const srcs = (panel.dataset.srcs || '').split('|').filter(Boolean);
      panel.innerHTML = srcs.map((s,i)=>`<img src="${s}" loading="lazy" alt="${name} explanation ${i+1}"/>`).join('');
      panel.dataset.loaded = 'true';
    }
    panel.classList.toggle('hidden', isOpen);
    btn.setAttribute('aria-expanded', String(!isOpen));
    btn.textContent = isOpen ? 'Read more' : 'Show less';
  }));
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[ch]));
}

function loadExplanationImages(panel){
  if(!panel || panel.dataset.loaded) return;
  const name = panel.dataset.name || 'Factor';
  const srcs = (panel.dataset.srcs || '').split('|').filter(Boolean);
  panel.innerHTML = srcs.map((s,i)=>`<img src="${s}" loading="lazy" alt="${name} explanation ${i+1}"/>`).join('');
  panel.dataset.loaded = 'true';
}


const FAULT_SHAPE_LAYERS = [
  {name:'Quaternary faults', url:'data/faults/FAM_Qt_Faults.zip', color:'#d61f4c', weight:3},
  {name:'Pre-Quaternary faults', url:'data/faults/FAM_PreQt_Faults.zip', color:'#f59e0b', weight:2},
  {name:'Fault creep', url:'data/faults/FAM_Fault_Creep.zip', color:'#2563eb', weight:4}
];
let faultMap = null;
let faultDataPromise = null;

function loadFaultData(){
  if(faultDataPromise) return faultDataPromise;
  faultDataPromise = Promise.all(FAULT_SHAPE_LAYERS.map(layer => {
    if(typeof shp !== 'function') throw new Error('Fault map reader is still loading. Try again in a moment.');
    return shp(layer.url).then(data => ({layer, data}));
  }));
  return faultDataPromise;
}

function eachCoord(coords, cb){
  if(!Array.isArray(coords)) return;
  if(typeof coords[0] === 'number' && typeof coords[1] === 'number'){
    cb(coords[0], coords[1]);
    return;
  }
  coords.forEach(c => eachCoord(c, cb));
}

function featureNearAddress(feature, st){
  if(!feature || !feature.geometry || !st) return false;
  const lon = +st.lon;
  const lat = +st.lat;
  if(!Number.isFinite(lon) || !Number.isFinite(lat)) return true;
  const latDelta = 1.1;
  const lonDelta = Math.max(1.1, latDelta / Math.max(0.25, Math.cos(lat * Math.PI / 180)));
  let near = false;
  eachCoord(feature.geometry.coordinates, (x,y) => {
    if(Math.abs(x - lon) <= lonDelta && Math.abs(y - lat) <= latDelta) near = true;
  });
  return near;
}

function pointToSegmentMiles(px, py, ax, ay, bx, by){
  const lat0 = py * Math.PI / 180;
  const xScale = 69.172 * Math.cos(lat0);
  const yScale = 69.0;
  const x = 0;
  const y = 0;
  const x1 = (ax - px) * xScale;
  const y1 = (ay - py) * yScale;
  const x2 = (bx - px) * xScale;
  const y2 = (by - py) * yScale;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx*dx + dy*dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
}

function geometryDistanceMiles(geometry, lon, lat){
  let best = Infinity;
  const scanLine = coords => {
    if(!Array.isArray(coords) || coords.length < 2) return;
    for(let i=1; i<coords.length; i++){
      const a = coords[i-1];
      const b = coords[i];
      if(Array.isArray(a) && Array.isArray(b) && typeof a[0] === 'number' && typeof b[0] === 'number'){
        best = Math.min(best, pointToSegmentMiles(lon, lat, a[0], a[1], b[0], b[1]));
      }
    }
  };
  const walk = coords => {
    if(!Array.isArray(coords)) return;
    if(Array.isArray(coords[0]) && typeof coords[0][0] === 'number') scanLine(coords);
    else coords.forEach(walk);
  };
  walk(geometry && geometry.coordinates);
  return best;
}

function faultDistanceLabel(miles){
  return miles < 0.1 ? 'within 0.1 miles' : `${miles.toFixed(miles < 10 ? 1 : 0)} miles`;
}

function faultRiskFromDistance(nearestRecent, nearestContext){
  if(nearestRecent && Number.isFinite(nearestRecent.distanceMiles)){
    const miles = nearestRecent.distanceMiles;
    const name = nearestRecent.name || nearestRecent.layerName || 'mapped CGS fault';
    const dist = faultDistanceLabel(miles);
    const desc = `Nearest active/recent CGS FAM 750k fault feature is ${dist} away (${name}).`;
    if(miles <= 5) return {label:'High Risk',score:8,desc,
      impacts:{property:IMP('High','Mapped fault within 5 miles - elevated seismic disclosure and structural due-diligence context.'),insurance:IMP('High','Near-fault earthquake exposure can affect coverage cost and underwriting.')}};
    if(miles <= 10) return {label:'Moderate Risk',score:6,desc,
      impacts:{property:IMP('Moderate','Mapped fault within 10 miles - seismic context should be reviewed.'),insurance:IMP('Moderate','Earthquake coverage may reflect regional fault proximity.')}};
    if(miles <= 15) return {label:'Low Risk',score:3,desc,
      impacts:{property:IMP('Low','Mapped fault within 15 miles, but not immediate proximity.'),insurance:IMP('Moderate','California regional earthquake exposure still applies.')}};
    return {label:'Low Risk',score:2,desc:`No active/recent CGS FAM 750k fault feature found within 15 miles. Nearest checked active/recent feature is ${dist} away (${name}).`,
      impacts:{property:IMP('Low','No mapped active/recent regional fault in the 15-mile check radius.'),insurance:IMP('Moderate','California regional earthquake exposure still applies.')}};
  }
  if(nearestContext && Number.isFinite(nearestContext.distanceMiles)){
    const name = nearestContext.name || nearestContext.layerName || 'older mapped structure';
    const dist = faultDistanceLabel(nearestContext.distanceMiles);
    return {label:'Low Risk',score:2,desc:`Only an older pre-Quaternary CGS FAM 750k structure is nearby (${dist}: ${name}); no active/recent fault feature was found in the local check radius.`,
      impacts:{property:IMP('Low','Pre-Quaternary fault mapping is context only here; no active/recent mapped fault proximity found.'),insurance:IMP('Moderate','California regional earthquake exposure still applies.')}};
  }
  return {label:'Low Risk',score:2,desc:'No CGS FAM 750k fault feature was found in the local check radius.',
    impacts:{property:IMP('Low','No mapped regional fault in the 15-mile check radius.'),insurance:IMP('Moderate','California regional earthquake exposure still applies.')}};
}

async function localFaultRisk(lat, lon){
  if(typeof shp !== 'function') return null;
  const st = {lat, lon};
  const results = await loadFaultData();
  let nearestRecent = null;
  let nearestContext = null;
  results.forEach(({layer, data}) => {
    normalizeFaultFeatures(data).filter(f => featureNearAddress(f, st)).forEach(feature => {
      const d = geometryDistanceMiles(feature.geometry, lon, lat);
      if(!Number.isFinite(d)) return;
      const p = feature.properties || {};
      const candidate = {
        distanceMiles: d,
        layerName: layer.name,
        name: p.FAULTNAME || p.FAULT_NAME || p.NAME || p.FAULT || p.FLTLABEL || p.Label || layer.name
      };
      const isContextOnly = /Pre-Quaternary/i.test(layer.name);
      if(isContextOnly){
        if(!nearestContext || d < nearestContext.distanceMiles) nearestContext = candidate;
      }else if(!nearestRecent || d < nearestRecent.distanceMiles){
        nearestRecent = candidate;
      }
    });
  });
  return faultRiskFromDistance(nearestRecent, nearestContext);
}

function normalizeFaultFeatures(data){
  if(!data) return [];
  if(data.type === 'FeatureCollection') return data.features || [];
  if(data.type === 'Feature') return [data];
  if(Array.isArray(data)) return data.flatMap(normalizeFaultFeatures);
  if(data.features) return data.features;
  return [];
}

let tsunamiDataPromise = null;
function loadTsunamiData(){
  if(!tsunamiDataPromise){
    tsunamiDataPromise = fetch('data/tsunami/CA_Tsunami_Hazard_Area_screening.geojson')
      .then(r => { if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  }
  return tsunamiDataPromise;
}

function pointInRing(lon, lat, ring){
  let inside = false;
  for(let i=0, j=ring.length-1; i<ring.length; j=i++){
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const hit = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
    if(hit) inside = !inside;
  }
  return inside;
}

function geometryContainsPoint(geometry, lon, lat){
  if(!geometry) return false;
  if(geometry.type === 'Polygon'){
    return (geometry.coordinates || []).some(ring => pointInRing(lon, lat, ring));
  }
  if(geometry.type === 'MultiPolygon'){
    return (geometry.coordinates || []).some(poly => poly.some(ring => pointInRing(lon, lat, ring)));
  }
  return false;
}

function geojsonContainsPoint(fc, lon, lat){
  return normalizeFaultFeatures(fc).some(feature => geometryContainsPoint(feature.geometry, lon, lat));
}

function faultPopup(props, layerName){
  const p = props || {};
  const name = p.FAULTNAME || p.FAULT_NAME || p.NAME || p.FAULT || p.FLTLABEL || p.Label || layerName;
  const activity = p.ACTIVITY || p.SLIP_RATE || p.AGE || p.ACTIVE || '';
  const extra = activity ? `<br><span>${esc(activity)}</span>` : '';
  return `<b>${esc(name)}</b><br><span>${esc(layerName)}</span>${extra}`;
}

function initFaultMap(){
  const el = $('#faultLineMap');
  if(!el || !STATE) return;
  if(faultMap){ try{ faultMap.remove(); }catch(e){} faultMap = null; }
  if(nplMap){ try{ nplMap.remove(); }catch(e){} nplMap = null; }
  if(tsunamiMap){ try{ tsunamiMap.remove(); }catch(e){} tsunamiMap = null; }
  faultMap = L.map(el, {scrollWheelZoom:true}).setView([STATE.lat, STATE.lon], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap · CGS FAM 750k'}).addTo(faultMap);
  L.marker([STATE.lat, STATE.lon]).addTo(faultMap).bindPopup(STATE.display || 'Analyzed address').openPopup();
  L.control.scale({imperial:true}).addTo(faultMap);
  const status = $('#faultMapStatus');
  if(status) status.textContent = 'Loading CGS fault layers...';
  loadFaultData().then(results => {
    let visibleCount = 0;
    results.forEach(({layer, data}) => {
      const features = normalizeFaultFeatures(data).filter(f => featureNearAddress(f, STATE));
      visibleCount += features.length;
      L.geoJSON({type:'FeatureCollection', features}, {
        style: {color: layer.color, weight: layer.weight, opacity:.9},
        onEachFeature: (feature, lyr) => lyr.bindPopup(faultPopup(feature.properties, layer.name))
      }).addTo(faultMap);
    });
    if(status) status.textContent = visibleCount
      ? `${visibleCount.toLocaleString()} nearby fault feature(s) loaded from CGS FAM 750k. Quaternary and creep layers drive the score; pre-Quaternary lines are context only.`
      : 'No nearby fault features from this dataset in the current view. Zoom out or use the official CGS map for verification.';
    setTimeout(()=>faultMap.invalidateSize(), 80);
  }).catch(err => {
    if(status) status.textContent = `Fault map could not load: ${err.message || err}`;
  });
}


let nplMap = null;
function nplPopup(props){
  const p = props || {};
  const name = p.SITE_NAME || p.SITE_FEATURE_NAME || 'EPA NPL Superfund boundary';
  const city = [p.CITY_NAME, p.STATE_CODE].filter(Boolean).join(', ');
  const status = p.NPL_STATUS_CODE ? `<br><span>NPL status: ${esc(p.NPL_STATUS_CODE)}</span>` : '';
  const place = city ? `<br><span>${esc(city)}</span>` : '';
  return `<b>${esc(name)}</b>${place}${status}`;
}

function initNplMap(){
  const el = $('#nplMap');
  if(!el || !STATE) return;
  if(nplMap){ try{ nplMap.remove(); }catch(e){} nplMap = null; }
  nplMap = L.map(el, {scrollWheelZoom:true}).setView([STATE.lat, STATE.lon], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap · EPA Superfund'}).addTo(nplMap);
  L.marker([STATE.lat, STATE.lon]).addTo(nplMap).bindPopup(STATE.display || 'Analyzed address').openPopup();
  L.control.scale({imperial:true}).addTo(nplMap);
  const status = $('#nplMapStatus');
  if(status) status.textContent = 'Loading EPA NPL Superfund boundaries...';
  if(window.L && window.L.esri){
    try{
      L.esri.featureLayer({
        url: SUPERFUND_NPL_URL,
        where: "STATE_CODE = 'CA'",
        style: () => ({color:'#dc2626', weight:2, opacity:.9, fillColor:'#f97316', fillOpacity:.18}),
        onEachFeature: (feature, lyr) => lyr.bindPopup(nplPopup(feature.properties))
      }).addTo(nplMap);
      if(status) status.textContent = 'EPA NPL Superfund boundaries loaded. Use the table result for the 1/5/10 mile screening check.';
    }catch(err){
      if(status) status.textContent = `NPL map could not load: ${err.message || err}`;
    }
  }else if(status){
    status.textContent = 'NPL map could not load because Esri Leaflet is unavailable.';
  }
  setTimeout(()=>nplMap.invalidateSize(), 80);
}

function openNplMapModal(){
  if(!STATE) return;
  $('#xmodalTitle').textContent = 'Superfund (NPL) Sites Map';
  $('#xmodalBody').innerHTML = `<div class="detail-modal fault-map-modal">
    <div class="detail-section no-top">
      <div class="detail-section-title">EPA NPL Superfund boundaries</div>
      <div class="detail-desc">Live EPA National Priorities List Superfund site boundaries centered on ${esc(STATE.display || 'the analyzed address')}.</div>
      <div id="nplMap" class="fault-line-map"></div>
      <div id="nplMapStatus" class="fault-map-status">Preparing NPL map...</div>
    </div>
  </div>`;
  const foot = $('#xmodalFoot');
  if(foot) foot.textContent = 'Click outside, press Escape, or use the close button to close.';
  $('#xmodal').classList.remove('hidden');
  setTimeout(initNplMap, 80);
}

let tsunamiMap = null;
let crimeMap = null;
function initTsunamiMap(){
  const el = $('#tsunamiMap');
  if(!el || !STATE) return;
  if(tsunamiMap){ try{ tsunamiMap.remove(); }catch(e){} tsunamiMap = null; }
  tsunamiMap = L.map(el, {scrollWheelZoom:true}).setView([STATE.lat, STATE.lon], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap · CGS tsunami hazard area'}).addTo(tsunamiMap);
  L.marker([STATE.lat, STATE.lon]).addTo(tsunamiMap).bindPopup(STATE.display || 'Analyzed address').openPopup();
  L.control.scale({imperial:true}).addTo(tsunamiMap);
  const status = $('#tsunamiMapStatus');
  if(status) status.textContent = 'Loading CGS tsunami hazard area...';
  loadTsunamiData().then(fc => {
    L.geoJSON(fc, {
      style: {color:'#0ea5e9', weight:1.5, opacity:.85, fillColor:'#38bdf8', fillOpacity:.22}
    }).addTo(tsunamiMap);
    const inside = geojsonContainsPoint(fc, STATE.lon, STATE.lat);
    if(status) status.textContent = inside
      ? 'This address is inside the local CGS tsunami hazard screening layer. Verify with the official CGS evacuation map.'
      : 'This address is outside the local CGS tsunami hazard screening layer. Verify with the official CGS evacuation map.';
    setTimeout(()=>tsunamiMap.invalidateSize(), 80);
  }).catch(err => {
    if(status) status.textContent = `Tsunami map could not load: ${err.message || err}`;
  });
}

function openTsunamiMapModal(){
  if(!STATE) return;
  $('#xmodalTitle').textContent = 'Tsunami Evacuation Zone Map';
  $('#xmodalBody').innerHTML = `<div class="detail-modal fault-map-modal">
    <div class="detail-section no-top">
      <div class="detail-section-title">CGS tsunami hazard area</div>
      <div class="detail-desc">Local CGS Tsunami Hazard Area for Emergency Planning screening layer centered on ${esc(STATE.display || 'the analyzed address')}.</div>
      <div id="tsunamiMap" class="fault-line-map"></div>
      <div id="tsunamiMapStatus" class="fault-map-status">Preparing tsunami map...</div>
      <div class="detail-desc">This local layer is simplified for screening speed. Use the official CGS evacuation map for final verification.</div>
    </div>
  </div>`;
  const foot = $('#xmodalFoot');
  if(foot) foot.textContent = 'Click outside, press Escape, or use the close button to close.';
  $('#xmodal').classList.remove('hidden');
  setTimeout(initTsunamiMap, 80);
}


function crimeMarkerIcon(type){
  const color = ({police:'#2563eb', fire:'#dc2626', hospital:'#16a34a', ambulance:'#7c3aed'}[type]) || '#64748b';
  const label = ({police:'P', fire:'F', hospital:'H', ambulance:'A'}[type]) || 'S';
  return L.divIcon({
    className:'crime-safety-marker',
    html:`<span style="background:${color}">${label}</span>`,
    iconSize:[28,28],
    iconAnchor:[14,14]
  });
}

function initCrimeMap(){
  const el = $('#crimeSafetyMap');
  if(!el || !STATE) return;
  if(crimeMap){ try{ crimeMap.remove(); }catch(e){} crimeMap = null; }
  crimeMap = L.map(el, {scrollWheelZoom:true}).setView([STATE.lat, STATE.lon], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap · CrimeMapping link'}).addTo(crimeMap);
  L.marker([STATE.lat, STATE.lon]).addTo(crimeMap).bindPopup(STATE.display || 'Analyzed address').openPopup();
  L.circle([STATE.lat, STATE.lon], {radius:4828, color:'#2563eb', weight:2, opacity:.65, fillColor:'#3b82f6', fillOpacity:.08}).addTo(crimeMap);
  L.control.scale({imperial:true}).addTo(crimeMap);
  const status = $('#crimeMapStatus');
  if(status) status.textContent = 'Loading nearby public-safety facilities...';
  fetchCrimeSafetyElements(STATE).then(elements => {
    if(!elements){
      if(status) status.textContent = 'Live safety facilities could not load. Use CrimeMapping for reported incident maps where available.';
      return;
    }
    const facilities = crimeSafetyFacilities(STATE, elements);
    facilities.forEach(f => {
      L.marker([f.lat, f.lon], {icon:crimeMarkerIcon(f.type)})
        .addTo(crimeMap)
        .bindPopup(`<b>${esc(f.name)}</b><br><span>${esc(crimeFacilityLabel(f.type))}</span><br><span>${f.dist.toFixed(f.dist < 1 ? 2 : 1)} miles away</span>`);
    });
    if(status) status.textContent = facilities.length
      ? `${facilities.length} mapped public-safety facility marker(s) loaded within 3 miles. This is a safety-access proxy, not an official incident crime rate.`
      : 'No mapped public-safety facilities found within 3 miles. Use CrimeMapping and local police data for incident review.';
    setTimeout(()=>crimeMap.invalidateSize(), 80);
  }).catch(err => {
    if(status) status.textContent = `Safety map could not load: ${err.message || err}`;
  });
}

function openCrimeMapModal(){
  if(!STATE) return;
  $('#xmodalTitle').textContent = 'Crime & Public Safety Map';
  $('#xmodalBody').innerHTML = `<div class="detail-modal fault-map-modal">
    <div class="detail-section no-top">
      <div class="detail-section-title">CrimeMapping + local safety access</div>
      <div class="detail-desc">CrimeMapping shows reported incidents where local agencies participate. The local map below is centered on ${esc(STATE.display || 'the analyzed address')} and shows nearby public-safety facilities from OpenStreetMap.</div>
      <div class="fault-map-toolbar">
        <span><i class="crime-dot police"></i> Police</span>
        <span><i class="crime-dot fire"></i> Fire</span>
        <span><i class="crime-dot hospital"></i> Hospital</span>
        <span><i class="crime-dot ambulance"></i> Ambulance</span>
      </div>
      <div id="crimeSafetyMap" class="fault-line-map"></div>
      <div id="crimeMapStatus" class="fault-map-status">Preparing safety map...</div>
      <div class="detail-actions">
        <a class="btn primary detail-map" href="https://www.crimemapping.com/map" target="_blank" rel="noopener">Open CrimeMapping ↗</a>
      </div>
    </div>
  </div>`;
  const foot = $('#xmodalFoot');
  if(foot) foot.textContent = 'CrimeMapping coverage depends on participating law-enforcement agencies. Informational screening only.';
  $('#xmodal').classList.remove('hidden');
  setTimeout(initCrimeMap, 80);
}

function impactBlock(label, item){
  return `<div class="detail-impact">
    <div class="detail-impact-top"><span>${label}</span>${lvlPill(item.level)}</div>
    <p>${item.why}</p>
  </div>`;
}


function openLiquefactionMapModal(){
  if(!STATE) return;
  const center = `${Number(STATE.lon).toFixed(6)},${Number(STATE.lat).toFixed(6)}`;
  $('#xmodalTitle').textContent = 'Soil Liquefaction Map';
  $('#xmodalBody').innerHTML = `<div class="detail-modal fault-map-modal">
    <div class="detail-section no-top">
      <div class="detail-section-title">CGS soil liquefaction map</div>
      <div class="detail-desc">ArcGIS liquefaction map centered on ${esc(STATE.display || 'the analyzed address')}.</div>
      <arcgis-embedded-map class="arcgis-factor-map" style="height:600px;width:100%;" item-id="3477be9df9724d69a190546a51db168c" theme="light" bookmarks-enabled heading-enabled legend-enabled information-enabled share-enabled basemap-gallery-enabled time-zone-label-enabled center="${center}" scale="72223.819286" portal-url="https://www.arcgis.com"></arcgis-embedded-map>
      <div class="detail-actions">
        <a class="btn ghost detail-map" href="https://maps.conservation.ca.gov/cgs/informationwarehouse/eqzapp/" target="_blank" rel="noopener">Open official CGS map ↗</a>
      </div>
    </div>
  </div>`;
  const foot = $('#xmodalFoot');
  if(foot) foot.textContent = 'CGS liquefaction map. Informational screening only; verify with official CGS sources.';
  $('#xmodal').classList.remove('hidden');
}

function openFaultMapModal(){
  if(!STATE) return;
  $('#xmodalTitle').textContent = 'Earthquake Fault Lines Map';
  $('#xmodalBody').innerHTML = `<div class="detail-modal fault-map-modal">
    <div class="detail-section no-top">
      <div class="detail-section-title">CGS fault line map</div>
      <div class="detail-desc">Local CGS FAM 750k fault layers centered on ${esc(STATE.display || 'the analyzed address')}.</div>
      <div class="fault-map-toolbar">
        <span><i class="fault-swatch qt"></i> Quaternary</span>
        <span><i class="fault-swatch preqt"></i> Pre-Quaternary</span>
        <span><i class="fault-swatch creep"></i> Creep</span>
      </div>
      <div id="faultLineMap" class="fault-line-map"></div>
      <div id="faultMapStatus" class="fault-map-status">Preparing fault map...</div>
      <div class="detail-actions">
        <a class="btn ghost detail-map" href="${fill((FACTORS.find(f=>f.n===5)||{}).map || '', STATE)}" target="_blank" rel="noopener">Open official CGS map ↗</a>
      </div>
    </div>
  </div>`;
  const foot = $('#xmodalFoot');
  if(foot) foot.textContent = 'CGS Fault Activity Map of California 1:750,000. Informational screening only.';
  $('#xmodal').classList.remove('hidden');
  setTimeout(initFaultMap, 80);
}

function openFactorModal(n){
  const item = SUMMARY_ITEMS[n] || SUMMARY_ITEMS[+n];
  if(!item) return;
  SELECTED_FACTOR = +n;
  document.querySelectorAll('#summaryTable tbody tr').forEach(row=>{
    const on = row.id === `sumrow-${n}`;
    row.classList.toggle('selected', on);
    row.setAttribute('aria-pressed', String(on));
  });
  const {f, live, rk, what, im, mapUrl, imgs} = item;
  const score = live ? `${live.score}/10${live.label.includes('No') ? '' : ' · '+live.label.replace(' Risk','')}` : 'Open map to assess';
  const explain = imgs.length
    ? `<div class="detail-explain" id="detailExplain-${f.n}">
        ${imgs.map((s,i)=>`<img src="${s}" loading="lazy" alt="${f.name} explanation ${i+1}"/>`).join('')}
       </div>`
    : `<div class="detail-empty">No explanation images are available for this factor yet.</div>`;
  $('#xmodalTitle').textContent = `#${f.n} ${f.name}`;
  $('#xmodalBody').innerHTML = `<div class="detail-modal">
    <div class="detail-head">
      <div>
        <div class="detail-cat">${f.cat}${live?' <span class="livechip">LIVE</span>':''}</div>
      </div>
      <span class="detail-risk rk-${rk}">${score}</span>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Overview</div>
      <div class="detail-desc">${what}</div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Impacts</div>
      <div class="detail-impact-grid">
        ${impactBlock('Health', im.health)}
        ${impactBlock('Property value', im.property)}
        ${impactBlock('Insurance', im.insurance)}
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Map</div>
      <div class="detail-desc">Open the live agency or map source recentered on this address.</div>
      <div class="detail-actions">
        <a class="btn primary detail-map" href="${mapUrl}" target="_blank" rel="noopener">Open map ↗</a>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Explanation</div>
      ${explain}
    </div>
  </div>`;
  const foot = $('#xmodalFoot');
  if(foot) foot.textContent = 'Click outside, press Escape, or use the close button to close.';
  $('#xmodal').classList.remove('hidden');
}

function selectVisibleFactor(){
  const visible = [...document.querySelectorAll('#summaryTable tbody tr')].filter(r=>r.style.display !== 'none');
  if(!visible.length) return;
  const selected = SELECTED_FACTOR && visible.find(r=>r.id === `sumrow-${SELECTED_FACTOR}`);
  document.querySelectorAll('#summaryTable tbody tr').forEach(row=>{
    row.classList.toggle('selected', !!selected && row === selected);
    row.setAttribute('aria-pressed', String(!!selected && row === selected));
  });
}

function wireSummaryRows(){
  document.querySelectorAll('#summaryTable .detail-arrow').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      openFactorModal(+btn.dataset.detail);
    });
  });
  document.querySelectorAll('#summaryTable .crime-map-open').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.preventDefault();
      e.stopPropagation();
      openCrimeMapModal();
    });
  });
  document.querySelectorAll('#summaryTable .map-embed-open').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.preventDefault();
      e.stopPropagation();
      openFaultMapModal();
    });
  });
  document.querySelectorAll('#summaryTable .liquefaction-map-open').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.preventDefault();
      e.stopPropagation();
      openLiquefactionMapModal();
    });
  });
  document.querySelectorAll('#summaryTable .npl-map-open').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.preventDefault();
      e.stopPropagation();
      openNplMapModal();
    });
  });
  document.querySelectorAll('#summaryTable .tsunami-map-open').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.preventDefault();
      e.stopPropagation();
      openTsunamiMapModal();
    });
  });
}

function closeFactorModal(){
  const modal = $('#xmodal');
  if(modal) modal.classList.add('hidden');
  if(faultMap){ try{ faultMap.remove(); }catch(e){} faultMap = null; }
  if(nplMap){ try{ nplMap.remove(); }catch(e){} nplMap = null; }
  if(tsunamiMap){ try{ tsunamiMap.remove(); }catch(e){} tsunamiMap = null; }
  if(crimeMap){ try{ crimeMap.remove(); }catch(e){} crimeMap = null; }
  SELECTED_FACTOR = null;
  document.querySelectorAll('#summaryTable tbody tr.selected').forEach(row=>{
    row.classList.remove('selected');
    row.setAttribute('aria-pressed','false');
  });
}
function closeDonationModal(){
  const modal = $("#donationModal");
  if(modal) modal.classList.add("hidden");
}
function showDonationModal(opts={}){
  const modal = $("#donationModal");
  const buy = $("#donationBuy");
  const skip = $("#donationSkip");
  const note = $("#donationNote");
  const actions = modal ? modal.querySelector(".donation-actions") : null;
  if(!modal) return false;
  saveDonationReturnState();
  if(buy) buy.classList.toggle("hidden", !!opts.afterDonation);
  if(skip) skip.textContent = "Download PDF";
  if(actions) actions.classList.add("single");
  if(note) note.textContent = opts.afterDonation
    ? "Thank you for supporting Home Risk Radar. You can download your PDF now."
    : "Donation is optional. You can download the PDF with or without donating.";
  modal.classList.remove("hidden");
  return true;
}
function closeDisclaimerModal(){
  const modal = $('#disclaimerModal');
  if(modal) modal.classList.add('hidden');
}
function openDisclaimerModal(){
  if(!STATE) return;
  const modal = $('#disclaimerModal');
  const ack = $('#disclaimerAck');
  const cont = $('#disclaimerContinue');
  if(!modal || !ack || !cont) return;
  ack.checked = false;
  cont.disabled = true;
  modal.classList.remove('hidden');
}
function startPdfDownload(){
  closeDonationModal();
  clearDonationReturnState();
  makePDF().catch(e=>setStatus("PDF error: "+e.message,"err"));
}
function downloadPdfAfterAcknowledgement(){
  closeDisclaimerModal();
  if(!showDonationModal()) startPdfDownload();
}
(function(){
  document.addEventListener('click', e=>{
    if(e.target && (e.target.id==='xmodalClose' || e.target.id==='xmodal')) closeFactorModal();
    if(e.target && e.target.id==="donationSkip") startPdfDownload();
    if(e.target && (e.target.id==="donationClose" || e.target.id==="donationModal")) closeDonationModal();
    if(e.target && (e.target.id==='disclaimerClose' || e.target.id==='disclaimerCancel' || e.target.id==='disclaimerModal')) closeDisclaimerModal();
    if(e.target && e.target.id==='disclaimerContinue' && !e.target.disabled) downloadPdfAfterAcknowledgement();
  });
  document.addEventListener('change', e=>{
    if(e.target && e.target.id==='disclaimerAck'){
      const cont = $('#disclaimerContinue');
      if(cont) cont.disabled = !e.target.checked;
    }
  });
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape'){
      closeFactorModal();
      closeDonationModal();
      closeDisclaimerModal();
    }
  });
})();

/* ---------- At-a-glance interactivity: category chips, search, risk sort ---------- */
let GLANCE = {cat:'*', q:'', sort:'num'};
function applyGlanceFilters(){
  const tbody=document.querySelector('#summaryTable tbody'); if(!tbody) return;
  let rows=[...tbody.querySelectorAll('tr')];
  rows.sort(GLANCE.sort==='risk'
    ? (a,b)=>(+b.dataset.risk)-(+a.dataset.risk) || (+a.id.slice(7))-(+b.id.slice(7))
    : (a,b)=>(+a.id.slice(7))-(+b.id.slice(7)));
  rows.forEach(r=>tbody.appendChild(r));
  let n=0;
  rows.forEach(r=>{
    const ok=(GLANCE.cat==='*'||r.dataset.cat===GLANCE.cat)
          && (!GLANCE.q || r.dataset.name.includes(GLANCE.q));
    r.style.display = ok ? '' : 'none';
    if(ok) n++;
  });
  const c=$('#glanceCount'); if(c) c.textContent=`showing ${n} of ${FACTORS.length}`;
  if(Object.keys(SUMMARY_ITEMS).length) selectVisibleFactor();
}
function buildGlanceControls(){
  GLANCE={cat:'*', q:'', sort:'num'};
  const box=$('#glanceCats'); if(!box) return;
  const cats=[...new Set(FACTORS.map(f=>f.cat || 'Other'))];
  box.innerHTML = `<button class="fchip active" data-cat="*">All ${FACTORS.length}</button>`
    + cats.map(c=>`<button class="fchip" data-cat="${c}">${c}</button>`).join('');
  box.querySelectorAll('.fchip').forEach(b=>b.addEventListener('click',()=>{
    box.querySelectorAll('.fchip').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); GLANCE.cat=b.dataset.cat; applyGlanceFilters();
  }));
  const s=$('#glanceSearch'); s.value=''; s.oninput=e=>{GLANCE.q=e.target.value.trim().toLowerCase(); applyGlanceFilters();};
  $('#sortNum').onclick=()=>{GLANCE.sort='num'; $('#sortNum').classList.add('active'); $('#sortRisk').classList.remove('active'); applyGlanceFilters();};
  $('#sortRisk').onclick=()=>{GLANCE.sort='risk'; $('#sortRisk').classList.add('active'); $('#sortNum').classList.remove('active'); applyGlanceFilters();};
  $('#sortNum').classList.add('active'); $('#sortRisk').classList.remove('active');
  applyGlanceFilters();
}

function riskKey(label){ if(!label) return 'pending'; const l=label.toLowerCase();
  return l.includes('high')?'high':l.includes('moderate')?'mod':l.includes('low')?'low':'no'; }

const LVLCLASS={'NA':'na','No':'no','Low':'low','Moderate':'mod','High':'high'};
function lvlPill(level){ return `<span class="lvl lvl-${LVLCLASS[level]||'na'}">${level}</span>`; }

// effective per-dimension impact, with live data (flood) overriding where known
function effImpact(f, live){
  const im={health:{...f.impact.health}, property:{...f.impact.property}, insurance:{...f.impact.insurance}};
  if(live && live.impacts){ for(const k of ['health','property','insurance']){ if(live.impacts[k]) im[k]={...live.impacts[k]}; } }
  if(live && f.n===8){
    const hi=live.score>=8;
    im.property ={level:hi?'High':'Low', why:hi?'In a Special Flood Hazard Area — lowers value & resale.':'Minimal flood zone (Zone X) — little value impact.'};
    im.insurance={level:hi?'High':'Low', why:hi?'SFHA triggers mandatory, costly flood insurance.':'No mandatory flood insurance required.'};
  }
  return im;
}

/* ---------- Overall risk scoring ---------- */
const LVLNUM = { NA: null, No: 0, Low: 2.5, Moderate: 6, High: 9 };
const DIMMETA = [['overall','Overall'],['health','Health'],['property','Property Value'],['insurance','Insurance Cost']];
function bandOf(s){ return s < 0.75 ? 'No' : s < 4.5 ? 'Low' : s < 7.5 ? 'Moderate' : 'High'; }
const BANDKEY = { No:'no', Low:'low', Moderate:'mod', High:'high' };

function computeRisk(liveResults){
  const dims = { health:{items:[]}, property:{items:[]}, insurance:{items:[]} };
  FACTORS.forEach(f=>{
    const im = effImpact(f, liveResults[f.n]||null);
    for(const k of ['health','property','insurance']){
      const v = LVLNUM[im[k].level];
      if(v===null || v===undefined) continue;
      dims[k].items.push({ n:f.n, name:f.name, cat:f.cat || 'Other', level:im[k].level, why:im[k].why, v,
                           live: !!liveResults[f.n] });
    }
  });
  let sum=0;
  for(const k of ['health','property','insurance']){
    const it = dims[k].items;
    dims[k].score = it.length ? it.reduce((a,x)=>a+x.v,0)/it.length : 0;
    dims[k].band  = bandOf(dims[k].score);
    sum += dims[k].score;
  }
  const overallScore = sum/3;
  // union view for the "Overall" tab: each factor's worst dimension
  const byFactor = {};
  for(const k of ['health','property','insurance']) dims[k].items.forEach(x=>{
    if(!byFactor[x.n] || x.v > byFactor[x.n].v) byFactor[x.n] = {...x, dim:k};
  });
  return { dims, overall:{ score:overallScore, band:bandOf(overallScore), items:Object.values(byFactor) } };
}

function drawGauge(score, band){
  const svg=$('#gauge'); const col=RC[BANDKEY[band]];
  const cx=110, cy=115, r=90, start=Math.PI, frac=Math.max(.02, Math.min(1, score/10));
  const arc=(f)=>{ const a=start - f*Math.PI + Math.PI; // sweep left->right
    const x=cx + r*Math.cos(Math.PI - f*Math.PI), y=cy - r*Math.sin(Math.PI - f*Math.PI);
    return {x,y}; };
  const p0=arc(0), p1=arc(frac);
  const large = frac>.5 ? 1 : 0;
  svg.innerHTML =
    `<path d="M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}" fill="none" stroke="#e6ecf3" stroke-width="16" stroke-linecap="round"/>`
    + `<path d="M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}" fill="none" stroke="${col}" stroke-width="16" stroke-linecap="round"/>`;
  $('#gaugeNum').textContent = score.toFixed(1) + ' / 10';
  $('#gaugeBand').textContent = band + ' risk';
  $('#gaugeBand').style.color = col;
}

let RISK=null, ACTIVEDIM='overall';
let COMPARE = [];
try{ COMPARE = JSON.parse(localStorage.getItem('riskCompare')||'[]'); }catch(e){ COMPARE=[]; }

function renderDrivers(){
  const set = ACTIVEDIM==='overall' ? RISK.overall.items : RISK.dims[ACTIVEDIM].items;
  const label = DIMMETA.find(d=>d[0]===ACTIVEDIM)[1];
  const top = [...set].sort((a,b)=>b.v-a.v || (b.live?1:0)-(a.live?1:0)).slice(0,6);
  $('#driversTitle').textContent = `Top ${label.toLowerCase()} risk drivers`;
  $('#driversList').innerHTML = top.map(x=>
    `<div class="driver" data-n="${x.n}" title="Jump to this factor in the summary table">
       <span class="d-name">#${x.n} ${x.name}${x.live?' <span class="livechip">LIVE DATA</span>':''}</span>
       ${lvlPill(x.level)}<span class="d-why">${x.why}</span></div>`).join('');
  document.querySelectorAll('#driversList .driver').forEach(el=>el.addEventListener('click',()=>{
    const row=document.getElementById('sumrow-'+el.dataset.n);
    if(row){ row.scrollIntoView({behavior:'smooth', block:'center'}); row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  }));
}
function renderOverall(liveResults){
  RISK = computeRisk(liveResults);
  const driverHTML = x =>
    `<div class="driver" data-n="${x.n}" title="Jump to this factor in the summary table">
       <span class="d-name">#${x.n} ${x.name}${x.live?' <span class="livechip">LIVE DATA</span>':''}</span>
       ${lvlPill(x.level)}<span class="d-why">${x.why}</span></div>`;
  const items = RISK.overall.items;
  const pick = lvl => [...items].filter(x=>x.level===lvl)
      .sort((a,b)=>b.v-a.v || (b.live?1:0)-(a.live?1:0)).slice(0,3);
  const render = arr => arr.length ? arr.map(driverHTML).join('')
      : '<div class="driver none">None identified at this address.</div>';
  $('#highList').innerHTML = render(pick('High'));
  $('#modList').innerHTML  = render(pick('Moderate'));
  document.querySelectorAll('.topriskgrid .driver[data-n]').forEach(el=>el.addEventListener('click',()=>{
    const row=document.getElementById('sumrow-'+el.dataset.n);
    if(row){ row.scrollIntoView({behavior:'smooth', block:'center'}); row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
    openFactorModal(+el.dataset.n);
  }));
  const liveN = Object.keys(STATE._live||{}).length;
  $('#methodBody').innerHTML =
    `<p>Each of the ${FACTORS.length} factors carries an impact level per dimension &mdash; <b>NA</b> (excluded), <b>No</b>, <b>Low</b>, <b>Moderate</b>, <b>High</b>. The lists above show the strongest High and Moderate factors for this address, live-verified factors first.</p>
     <p><b>What's live vs. baseline:</b> ${liveN} factor(s) are scored from live, address-specific data (FEMA flood, CGS fault / liquefaction / landslide zones, CAL FIRE fire severity, OpenStreetMap amenity counts, Census ACS); the rest use their typical California exposure profile. Informational screening only &mdash; not a substitute for professional inspection or underwriting.</p>`;
  return RISK;
}

function strongest(items, levels=['High','Moderate']){
  return [...items].filter(x=>levels.includes(x.level)).sort((a,b)=>b.v-a.v).slice(0,3);
}
function goodFactors(liveResults, amen){
  const good=[];
  if(amen){
    if((amen.eat+amen.shop)>=10) good.push('daily amenities');
    if(amen.park>=1) good.push('parks / green space');
    if((amen.transit+amen.station)>=5) good.push('transit access');
    if(amen.health>0) good.push('healthcare access');
  }
  if(liveResults[8] && liveResults[8].score<=2) good.push('minimal FEMA flood exposure');
  if(liveResults[11] && liveResults[11].score<=3) good.push('lower mapped fire severity');
  return good.slice(0,4);
}
function renderInsights(st, R, census, amen, liveResults){
  amen = amen || baselineAmenityCounts(st);
  const fallbackNote = amen && amen._fallback
    ? '<p class="snapnote">Showing baseline neighborhood counts because live OpenStreetMap counts did not respond for this run.</p>'
    : '';
  const retail = amen ? amen.eat + amen.shop : null;
  $('#neighborhoodSnapshot').innerHTML = amen ? `<div class="snapgrid">
    <div><b>${retail}</b><span>Dining / retail</span></div>
    <div><b>${amen.park}</b><span>Parks</span></div>
    <div><b>${amen.transit + amen.station}</b><span>Transit points</span></div>
    <div><b>${amen.health}</b><span>Healthcare</span></div>
    <div><b>${amen.community}</b><span>Community places</span></div>
    <div><b>${amen.constr}</b><span>Construction</span></div>
  </div>${fallbackNote}` : '<p>Neighborhood amenities could not be loaded from OpenStreetMap for this run.</p>';
}

function aqiLabel(aqi){
  if(aqi == null || Number.isNaN(+aqi)) return {label:'Unavailable', key:'unknown', pct:0, note:'Air-quality data is unavailable for this address right now.'};
  if(aqi <= 50) return {label:'Good', key:'good', pct:Math.max(8, aqi), note:'Air quality is generally suitable for outdoor activity.'};
  if(aqi <= 100) return {label:'Moderate', key:'mod', pct:aqi, note:'Air quality is acceptable; sensitive groups may notice minor effects.'};
  if(aqi <= 150) return {label:'Sensitive', key:'sensitive', pct:aqi, note:'Sensitive groups should consider reducing prolonged outdoor exertion.'};
  return {label:'Unhealthy', key:'bad', pct:Math.min(100, aqi/2), note:'Air quality may affect health; reduce outdoor exposure.'};
}
function windDirection(deg){
  if(deg == null || Number.isNaN(+deg)) return 'n/a';
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round((+deg % 360) / 45) % 8];
}
function weatherText(code){
  const c = +code;
  if([0].includes(c)) return 'Clear';
  if([1,2,3].includes(c)) return 'Clouds';
  if([45,48].includes(c)) return 'Fog';
  if([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(c)) return 'Rain';
  if([71,73,75,77,85,86].includes(c)) return 'Snow';
  if([95,96,99].includes(c)) return 'Storm';
  return 'Weather';
}
function renderEnvironment(env){
  const host = $('#environmentSnapshot'); if(!host) return;
  if(!env || (!env.weather && !env.air)){
    host.innerHTML = '<p>Live air and weather data could not be loaded for this run.</p>';
    return;
  }
  const w = (env.weather && env.weather.current) || {};
  const a = (env.air && env.air.current) || {};
  const aqi = a.us_aqi == null ? null : Math.round(+a.us_aqi);
  const aq = aqiLabel(aqi);
  const temp = w.temperature_2m == null ? 'n/a' : `${Math.round(+w.temperature_2m)}°F`;
  const wind = w.wind_speed_10m == null ? 'n/a' : `${Math.round(+w.wind_speed_10m)} mph ${windDirection(w.wind_direction_10m)}`;
  const humid = w.relative_humidity_2m == null ? 'n/a' : `${Math.round(+w.relative_humidity_2m)}%`;
  const pm = a.pm2_5 == null ? 'n/a' : `${(+a.pm2_5).toFixed(1)}`;
  const ozone = a.ozone == null ? 'n/a' : `${Math.round(+a.ozone)}`;
  host.innerHTML = `<div class="envgrid">
    <div class="aqi-card ${aq.key}">
      <div class="aqi-ring" style="--p:${Math.min(100, aq.pct)}"><span>${aqi ?? 'n/a'}</span></div>
      <div><b>${aq.label}</b><span>US AQI</span></div>
    </div>
    <div class="weather-chips">
      <div><b>${temp}</b><span>${weatherText(w.weather_code)}</span></div>
      <div><b>${wind}</b><span>Wind</span></div>
      <div><b>${humid}</b><span>Humidity</span></div>
    </div>
    <div class="pollutants">
      <span><b>${pm}</b> PM2.5 µg/m³</span>
      <span><b>${ozone}</b> Ozone µg/m³</span>
    </div>
    <p>${aq.note}</p>
  </div>`;
}


function renderInsightLoading(){
  const snap = $('#neighborhoodSnapshot');
  const env = $('#environmentSnapshot');
  if(snap) snap.innerHTML = '<p>Preparing neighborhood snapshot...</p>';
  if(env) env.innerHTML = '<p>Loading current air quality and weather...</p>';
}

/* ---------- Coverage (ZIP-specific rollout) ---------- */
const ZIP_CITY = { '94582':'San Ramon', '94583':'San Ramon', '94506':'Danville', '94526':'Danville' };
const LOCAL_NOTES_BY_CITY = {
  'San Ramon': {
    5:'The Calaveras Fault corridor runs through the San Ramon Valley; Alquist\u2011Priolo study zones flank the valley \u2014 see the fault layer on the live map.',
    6:'Valley-floor alluvium along the San Ramon Creek corridor is where liquefaction zoning concentrates locally \u2014 toggle the CGS layer to check this parcel.',
    7:'Mapped earthquake-induced landslide zones sit on the hillside flanks (Las Trampas ridge to the west, Diablo foothills east); the valley floor is largely outside them.',
    8:'Local flood zones follow San Ramon and Sycamore Valley creeks \u2014 the FEMA result above is queried live for this exact point.',
    11:'Wildland-urban interface parcels on the eastern and western hillside edges carry elevated CAL FIRE severity; central valley-floor neighborhoods are lower.',
    33:'Livermore Municipal is the closest airport (~10 mi E); OAK/SFO approaches pass well to the west \u2014 overflight is modest for most of the ZIP.',
    34:'Dublin/Pleasanton BART is the nearest station (~5\u20138 mi south via I\u2011680); San Ramon itself has bus (County Connection) service.',
  },
  'Danville': {
    5:'The Calaveras Fault corridor passes directly through the Danville area; Alquist\u2011Priolo study zones are mapped locally \u2014 see the fault layer on the live map.',
    6:'Liquefaction zoning locally concentrates on creek-corridor alluvium (San Ramon Creek, Green Valley Creek) \u2014 toggle the CGS layer to check this parcel.',
    7:'Earthquake-induced landslide zones are mapped on the Las Trampas and Diablo foothill flanks around town; valley-floor parcels are largely outside them.',
    8:'Local flood zones track San Ramon and Sycamore creeks \u2014 the FEMA result above is queried live for this exact point.',
    11:'Hillside and Diablo-foothill edges (e.g. toward Blackhawk) carry elevated CAL FIRE severity; the town core is lower.',
    33:'Livermore Municipal (~12 mi SE) and Buchanan Field (~10 mi N) are the nearest airports; overflight is modest for most parcels.',
    34:'Walnut Creek and Dublin/Pleasanton BART are each roughly 15 minutes by car; local transit is County Connection bus.',
  },
};
function localNotesFor(st){ const city = ZIP_CITY[st.zip]; return city ? (LOCAL_NOTES_BY_CITY[city]||{}) : {}; }

function showComingSoon(st){
  $('#results').classList.add('hidden');
  $('#empty').classList.add('hidden');
  const cs=$('#comingsoon');
  cs.classList.remove('hidden');
  $('#csZip').textContent = st.zip ? `ZIP ${st.zip}` : (st.city || 'this area');
  $('#csCity').textContent = st.city ? ` (${st.city})` : '';
  setStatus(`Risk analysis for ${st.zip||st.city} is coming soon \u2014 currently covering San Ramon &amp; Danville.`,'err');
}

/* ---------- Risk score shown on the map ---------- */
let mapRiskCtl = null;
function updateMapRisk(st){
  if(!map || !RISK) return;
  const col = k => RC[BANDKEY[k.band]];
  // corner badge (click -> scroll to the full score panel)
  if(mapRiskCtl){ try{ map.removeControl(mapRiskCtl); }catch(e){} }
  mapRiskCtl = L.control({position:'bottomleft'});
  mapRiskCtl.onAdd = function(){
    const div = L.DomUtil.create('div','map-riskbadge');
    div.innerHTML = `<div class="mrb-top">OVERALL RISK</div>
      <div class="mrb-score" style="color:${col(RISK.overall)}">${RISK.overall.score.toFixed(1)}<span>/10</span></div>
      <div class="mrb-band" style="color:${col(RISK.overall)}">${RISK.overall.band}</div>
      <div class="mrb-dims">
        <span title="Health">H ${RISK.dims.health.score.toFixed(1)}</span>
        <span title="Property Value">P ${RISK.dims.property.score.toFixed(1)}</span>
        <span title="Insurance Cost">I ${RISK.dims.insurance.score.toFixed(1)}</span>
      </div>`;
    L.DomEvent.disableClickPropagation(div);
    div.addEventListener('click', ()=>{ const el=document.querySelector('.riskcol'); if(el) el.scrollIntoView({behavior:'smooth', block:'center'}); });
    return div;
  };
  mapRiskCtl.addTo(map);
  // richer marker popup with the same breakdown
  if(marker){
    marker.bindPopup(`<b>${st.display}</b><br>
      Overall risk: <b style="color:${col(RISK.overall)}">${RISK.overall.score.toFixed(1)}/10 \u00b7 ${RISK.overall.band}</b><br>
      <span style="font-size:11px">Health ${RISK.dims.health.score.toFixed(1)} \u00b7 Property ${RISK.dims.property.score.toFixed(1)} \u00b7 Insurance ${RISK.dims.insurance.score.toFixed(1)}</span>`);
  }
}

/* ---------- Interactive live hazard map ---------- */
/* Verified public agency services drawn as toggleable overlays. */
const MAP_OVERLAYS = [
  { name:'FEMA Flood Zones',              type:'feature', on:true,
    url:'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28',
    where:"SFHA_TF = 'T'",
    style:{ color:'#0969da', weight:1.5, opacity:.8, fillColor:'#4dabf7', fillOpacity:.28 } },
  { name:'Liquefaction Zones (CGS)',      type:'feature', on:true,
    url:'https://services2.arcgis.com/zr3KAIbsRSUyARHG/arcgis/rest/services/CGS_Liquefaction_Zones/FeatureServer/0',
    style:{ color:'#d97706', weight:1, opacity:.85, fillColor:'#f59e0b', fillOpacity:.25 } },
  { name:'Landslide Zones (CGS)',         type:'feature', on:true,
    url:'https://services2.arcgis.com/zr3KAIbsRSUyARHG/arcgis/rest/services/CGS_Landslide_Zones/FeatureServer/0',
    style:{ color:'#15803d', weight:1, opacity:.85, fillColor:'#22c55e', fillOpacity:.22 } },
  { name:'Earthquake Fault Lines (CGS)',  type:'feature', on:true,
    url:'https://services2.arcgis.com/zr3KAIbsRSUyARHG/arcgis/rest/services/CGS_Alquist_Priolo_Fault_Traces/FeatureServer/0',
    style:{ color:'#c41e3a', weight:3, opacity:.9 } },
  { name:'Fire Hazard Severity (CAL FIRE)', type:'dynamic', on:true,
    url:'https://services.gis.ca.gov/arcgis/rest/services/Environment/Fire_Severity_Zones/MapServer', opacity:.5 },
];

function buildMainMap(st){
  if(map){ try{ map.remove(); }catch(e){} map=null; }
  map = L.map('map', { scrollWheelZoom:true }).setView([st.lat, st.lon], 13);
  const baseName = 'OpenStreetMap';
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'\u00a9 OpenStreetMap'}).addTo(map);
  const overlays = {};
  const layerState = {};
  const activeLayers = new Set();
  function refreshLayerStatus(){
    const el=document.getElementById('layerStatus'); if(!el) return;
    const bad=Object.entries(layerState).filter(([,v])=>v===false).map(([k])=>k);
    const active = [...activeLayers];
    const activeHtml = active.length ? `<div><b>Active map layers:</b> ${baseName} · ${active.join(' · ')}</div>` : `<div><b>Active map layers:</b> ${baseName} only</div>`;
    const badHtml = bad.length
      ? `<div>⚠ Couldn't load from the agency server: <b>${bad.join('</b> · <b>')}</b> — re-toggle the layer or try again shortly.</div>`
      : '';
    el.innerHTML = activeHtml + badHtml;
  }
  if(window.L && window.L.esri){
    MAP_OVERLAYS.forEach(o=>{
      let layer=null;
      try{
        if(o.type==='feature'){
          const opts = { url:o.url, style:o.style || (()=>({})) };
          if(o.where) opts.where = o.where;
          layer = L.esri.featureLayer(opts);
        }else{
          layer = L.esri.dynamicMapLayer({url:o.url, opacity:o.opacity ?? .5, layers:o.layers, format:'png32'});
        }
      }catch(e){ layerState[o.name]=false; refreshLayerStatus(); return; }
      layer.on('requesterror', ()=>{ layerState[o.name]=false; refreshLayerStatus(); });
      layer.on('load', ()=>{ layerState[o.name]=true; refreshLayerStatus(); });
      layer.on('add', ()=>{ activeLayers.add(o.name); refreshLayerStatus(); });
      layer.on('remove', ()=>{ activeLayers.delete(o.name); refreshLayerStatus(); });
      overlays[o.name]=layer;
      if(o.on){ activeLayers.add(o.name); layer.addTo(map); }
    });
  }
  L.control.layers(null, overlays, {collapsed:false, position:'topright'}).addTo(map);
  map.on('overlayadd overlayremove', refreshLayerStatus);
  L.control.scale({imperial:true}).addTo(map);
  marker = L.marker([st.lat, st.lon]).addTo(map).bindPopup(st.display).openPopup();
  refreshLayerStatus();
}

/* ---------- Main flow ---------- */
async function analyze(){
  const runId = ++ANALYZE_RUN;
  const q=$('#addr').value.trim();
  if(!q){ setStatus('Enter a California address.','err'); return; }
  $('#go').disabled=true; $('#pdf').disabled=true;
  setPageLoading(true, 'Finding the address...');
  setStatus('<span class="spinner"></span>Geocoding address…');
  let st;
  try{ st=await geocode(q); }
  catch(e){ setStatus(e.message,'err'); $('#go').disabled=false; setPageLoading(false); return; }
  if(runId !== ANALYZE_RUN) return;
  STATE=st;
  try{
  setPageLoading(true, 'Building the map and report sections...');
  $('#comingsoon').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#results').classList.remove('hidden');
  $('#locZip').textContent = 'ZIP '+(st.zip||'n/a');
  $('#locAddr').textContent = st.display;
  $('#locCoords').textContent = `${(+st.lat).toFixed(5)}, ${(+st.lon).toFixed(5)}`;
  setStatus(`<span class="ok">✓</span> Showing results for ${st.display.split(',').slice(0,2).join(',')}`,'ok');
  renderScoring();
  invalidateMapSoon();

  buildMainMap(st);

  const liveResults={};
  renderProfile(null, st);
  renderSummaryTable(st, liveResults);
  renderInsightLoading();
  setPageLoading(true, 'Loading live hazards, amenities, air, and weather...');

  // live lookups in parallel (hazards + livability)
  const safe = (p, label) => p.catch(e => { console.warn(`${label} lookup failed`, e); return null; });
  const [census, school, crime, flood, liq, lands, fault, fhsz, npl, tsunami, amen, env] = await Promise.all([
    safe(withTimeout(censusByZip(st.zip), 9000, 'Census'), 'Census'),
    safe(withTimeout(schoolAccess(st), 18000, 'School access'), 'School access'),
    safe(withTimeout(crimeSafety(st), 18000, 'Crime safety'), 'Crime safety'),
    safe(withTimeout(femaFloodZone(st.lat, st.lon), 9000, 'FEMA flood'), 'FEMA flood'),
    safe(withTimeout(cgsLiquefaction(st.lat, st.lon), 9000, 'CGS liquefaction'), 'CGS liquefaction'),
    safe(withTimeout(cgsLandslide(st.lat, st.lon), 9000, 'CGS landslide'), 'CGS landslide'),
    safe(withTimeout(cgsFault(st.lat, st.lon), 15000, 'CGS fault'), 'CGS fault'),
    safe(withTimeout(calfireFHSZ(st.lat, st.lon), 9000, 'CAL FIRE'), 'CAL FIRE'),
    safe(withTimeout(epaSuperfundNpl(st.lat, st.lon), 12000, 'EPA NPL'), 'EPA NPL'),
    safe(withTimeout(cgsTsunami(st.lat, st.lon), 9000, 'CGS tsunami'), 'CGS tsunami'),
    safe(withTimeout(overpassAmenities(st), 32000, 'OpenStreetMap amenities'), 'OpenStreetMap amenities'),
    safe(withTimeout(localEnvironment(st.lat, st.lon), 6500, 'Environment'), 'Environment')
  ]);
  if(runId !== ANALYZE_RUN) return;
  setPageLoading(true, 'Rendering the final report...');
  renderProfile(census, st);
  if(school){ liveResults[2]=school; }
  if(crime){ liveResults[3]=crime; }
  if(flood){ liveResults[8]=flood; }
  if(liq){ liveResults[6]=liq; }
  if(lands){ liveResults[7]=lands; }
  if(fault){ liveResults[5]=fault; }
  if(fhsz){ liveResults[11]=fhsz; }
  if(npl){ liveResults[15]=npl; }
  if(tsunami){ liveResults[46]=tsunami; }
  Object.assign(liveResults, livabilityResults(amen, census));
  if(census){ liveResults[1]={label:'No Risk', score:0, desc:`ZIP ${st.zip}: pop ${census.pop}, median income ${census.income}, median home ${census.home}, ${census.bachelors} bachelor's+.`}; }

  // summary view (table) + overall risk score
  renderSummaryTable(st, liveResults);
  STATE._live=liveResults;
  const R = renderOverall(liveResults);
  renderInsights(st, R, census, amen, liveResults);
  renderEnvironment(env);
  const fmt = d => `${d.band} · ${d.score.toFixed(1)}/10`;
  const d = { health: fmt(R.dims.health), prop: fmt(R.dims.property), ins: fmt(R.dims.insurance) }; // used by the PDF cover
  $('#foot').innerHTML=`Generated ${new Date().toLocaleDateString()} · Geocoding & basemap © OpenStreetMap/Nominatim · Demographics: U.S. Census ACS · Flood: FEMA NFHL · Weather/Air: Open-Meteo. `
    +`Informational screening only — not a substitute for a professional inspection, geotechnical study, or insurance underwriting. Build ${(window.APP_CONFIG||{}).BUILD||'?'} `;

  STATE._dims=d; STATE._census=census; STATE._amen=amen; STATE._env=env; STATE._risk=R;
  $('#pdf').disabled=false;
  setStatus(`<span class="ok">✓</span> Analysis completed successfully. Your report is ready for download.`,'ok');
  if(RESUME_PDF_AFTER_DONATION){
    RESUME_PDF_AFTER_DONATION = false;
    setStatus('<span class="ok">✓</span> Donation complete — download your PDF when ready.','ok');
    showDonationModal({afterDonation:true});
  }
  }catch(e){ console.error(e); setStatus('Something went wrong rendering the report: '+(e.message||e),'err'); }
  finally{ if(runId === ANALYZE_RUN){ $('#go').disabled=false; setPageLoading(false); } }
}

/* show/resize the Leaflet map once its container is visible */
function invalidateMapSoon(){ setTimeout(()=>{ if(map) map.invalidateSize(); }, 60); }

/* ---------- PDF (matches the polished report design) ---------- */
const PDFRC={no:[91,124,153], low:[46,139,87], mod:[224,138,0], high:[196,30,58], pending:[133,147,166]};
function loadImg(src){
  return new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin='anonymous';
    i.onload=()=>res(i); i.onerror=()=>rej(new Error('img')); i.src=src; });
}
function osmTileUrl(z, x, y){
  const host = ['a','b','c'][Math.abs(x + y) % 3];
  return `https://${host}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}
function lonToTileX(lon, zoom){
  return ((+lon + 180) / 360) * Math.pow(2, zoom);
}
function latToTileY(lat, zoom){
  const rad = (+lat) * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom);
}
async function buildOsmMapDataUrl(lat, lon, w=900, h=430, zoom=13){
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eef5ff';
  ctx.fillRect(0,0,w,h);
  const size = 256, tiles = Math.pow(2, zoom);
  const centerX = lonToTileX(lon, zoom) * size;
  const centerY = latToTileY(lat, zoom) * size;
  const startX = centerX - w / 2;
  const startY = centerY - h / 2;
  const minX = Math.floor(startX / size);
  const maxX = Math.floor((startX + w) / size);
  const minY = Math.floor(startY / size);
  const maxY = Math.floor((startY + h) / size);
  const jobs = [];
  for(let x=minX; x<=maxX; x++){
    for(let y=minY; y<=maxY; y++){
      if(y < 0 || y >= tiles) continue;
      const wrappedX = ((x % tiles) + tiles) % tiles;
      const dx = Math.round(x * size - startX);
      const dy = Math.round(y * size - startY);
      jobs.push(loadImg(osmTileUrl(zoom, wrappedX, y)).then(img=>ctx.drawImage(img, dx, dy, size, size)).catch(()=>{}));
    }
  }
  await Promise.all(jobs);
  ctx.fillStyle = 'rgba(196,30,58,.95)';
  ctx.beginPath(); ctx.arc(w/2, h/2, 12, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(w/2, h/2, 6, 0, Math.PI*2); ctx.stroke();
  ctx.fillStyle = 'rgba(20,28,46,.78)';
  ctx.fillRect(0, h-28, w, 28);
  ctx.fillStyle = '#ffffff';
  ctx.font = '16px Helvetica, Arial, sans-serif';
  ctx.fillText('OpenStreetMap preview - centered on address', 14, h-10);
  return canvas.toDataURL('image/png');
}
async function makePDF(){
  if(!STATE) return;
  $('#pdf').disabled=true;
  setStatus('<span class="spinner"></span>Building PDF…');
  try{
  const { jsPDF } = window.jspdf;
  const doc=new jsPDF({unit:'pt', format:'letter', compress:true}); // 612 x 792
  const W=612, H=792, M=40, CW=W-2*M;
  const live=STATE._live||{}, c=STATE._census, amen=STATE._amen, env=STATE._env;
  const reportRisk = STATE._risk || computeRisk(live);
  const imgs={};
  await withTimeout(buildOsmMapDataUrl(STATE.lat, STATE.lon, 900, 430, 13), 12000, 'PDF map')
    .then(url=>{ imgs.map=url; })
    .catch(()=>{});

  /* ---- Cover ---- */
  doc.setFillColor(18,29,48); doc.rect(0,0,W,174,'F');
  doc.setFillColor(49,112,246); doc.rect(0,0,W,7,'F');
  doc.setFillColor(46,139,87); doc.rect(0,7,W*.34,7,'F');
  doc.setFillColor(224,138,0); doc.rect(W*.34,7,W*.33,7,'F');
  doc.setFillColor(196,30,58); doc.rect(W*.67,7,W*.33,7,'F');
  doc.setTextColor(159,184,218); doc.setFontSize(9); doc.setFont('helvetica','bold');
  doc.text('CALIFORNIA NEIGHBORHOOD INTELLIGENCE', M, 44);
  doc.setTextColor(255,255,255); doc.setFontSize(24); doc.text('Address Risk & Livability Report', M, 74);
  doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(220,228,240);
  doc.text(doc.splitTextToSize(STATE.display, CW), M, 100);
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(157,180,214);
  doc.text(`ZIP ${STATE.zip||'n/a'}   -   ${(+STATE.lat).toFixed(5)}, ${(+STATE.lon).toFixed(5)}   -   ${new Date().toLocaleDateString()}   -   ${FACTORS.length} factors`, M, 154);
  let y=202;
  doc.setFillColor(255,255,255); doc.setDrawColor(226,231,238); doc.roundedRect(M,y,CW,74,8,8,'FD');
  doc.setFillColor(239,246,255); doc.roundedRect(M+12,y+14,92,32,16,16,'F');
  doc.setTextColor(49,112,246); doc.setFont('helvetica','bold'); doc.setFontSize(10);
  doc.text(`ZIP ${STATE.zip||'n/a'}`, M+30, y+35);
  doc.setTextColor(20,28,46); doc.setFontSize(12);
  doc.text('Location Snapshot', M+122, y+25);
  doc.setFont('helvetica','normal'); doc.setTextColor(90,107,128); doc.setFontSize(9.5);
  const meta = c
    ? `Population ${c.pop}  -  Median income ${c.income}  -  Median home ${c.home}  -  Bachelor's+ ${c.bachelors}`
    : `Coordinates ${(+STATE.lat).toFixed(5)}, ${(+STATE.lon).toFixed(5)}  -  Public agency and neighborhood data`;
  doc.text(doc.splitTextToSize(meta, CW-148), M+122, y+45);
  y+=92;
  doc.setFillColor(255,255,255); doc.setDrawColor(220,227,236); doc.roundedRect(M,y,CW,304,9,9,'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(90,107,128);
  doc.text('ADDRESS MAP', M+14, y+20);
  const mapX=M+14, mapY=y+34, mapW=CW-28, mapH=226;
  if(imgs.map){
    doc.addImage(imgs.map,'PNG',mapX,mapY,mapW,mapH);
  }else{
    doc.setFillColor(239,246,255); doc.rect(mapX,mapY,mapW,mapH,'F');
    doc.setTextColor(49,112,246); doc.setFont('helvetica','bold'); doc.setFontSize(13);
    doc.text('Map preview unavailable', mapX+18, mapY+40);
    doc.setTextColor(90,107,128); doc.setFont('helvetica','normal'); doc.setFontSize(10);
    doc.text('Open the interactive report for the live OpenStreetMap view.', mapX+18, mapY+60);
  }
  doc.setDrawColor(49,112,246); doc.setLineWidth(1.5); doc.rect(mapX,mapY,mapW,mapH); doc.setLineWidth(1);
  doc.setFillColor(196,30,58); doc.circle(mapX+mapW/2, mapY+mapH/2, 7, 'F');
  doc.setDrawColor(255,255,255); doc.circle(mapX+mapW/2, mapY+mapH/2, 3, 'S');
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(90,107,128);
  doc.text('OpenStreetMap preview centered on this address. Live report includes FEMA flood, CGS seismic, and CAL FIRE layers.', M+14, y+282);
  y+=320;
  doc.setFillColor(239,246,255); doc.setDrawColor(208,224,255); doc.roundedRect(M,y,CW,46,8,8,'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(49,112,246);
  doc.text('Report focus', M+14, y+18);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(43,57,77);
  doc.text(doc.splitTextToSize('Use this PDF as a clean screening summary. Open the live page for expandable explanations, layer toggles, and agency map links.', CW-28), M+14, y+34);

  /* ---- Latest interactive snapshot ---- */
  doc.addPage(); y=M+6;
  doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.setTextColor(20,28,46);
  doc.text('Report Summary', M, y); y+=10;
  doc.setDrawColor(20,28,46); doc.setLineWidth(1.5); doc.line(M,y,W-M,y); doc.setLineWidth(1); y+=18;
  const para=(txt,x,yy,w,size=9.5,color=[43,57,77],weight='normal')=>{
    doc.setFont('helvetica',weight); doc.setFontSize(size); doc.setTextColor(...color);
    const lines=doc.splitTextToSize(txt,w); doc.text(lines,x,yy); return yy + lines.length*(size+2);
  };
  const sectionLabel=(txt,x,yy)=>{ doc.setFont('helvetica','bold'); doc.setFontSize(8.7); doc.setTextColor(90,107,128); doc.text(txt.toUpperCase(), x, yy); };
  const bandStyle = level => ({
    High:[[253,231,235],[246,196,206],[187,29,56]],
    Moderate:[[253,242,220],[244,219,168],[167,103,0]],
    Low:[[231,246,238],[200,234,214],[21,122,66]],
    No:[[234,240,246],[214,224,234],[70,99,124]],
  }[level] || [[238,241,245],[224,229,236],[107,120,136]]);
  const riskChip=(x,yy,label)=>{
    const text = String(label || 'Review').replace(' Risk','');
    const c = bandStyle(text);
    doc.setFont('helvetica','bold'); doc.setFontSize(7.6);
    const w=doc.getTextWidth(text)+14;
    doc.setFillColor(...c[0]); doc.setDrawColor(...c[1]); doc.roundedRect(x,yy,w,17,4,4,'FD');
    doc.setTextColor(...c[2]); doc.text(text,x+7,yy+11.5);
    return w;
  };
  const topItems = [...(reportRisk.overall.items||[])].sort((a,b)=>b.v-a.v || (b.live?1:0)-(a.live?1:0));
  const topHigh = topItems.filter(x=>x.level==='High').slice(0,3);
  const topMod = topItems.filter(x=>x.level==='Moderate').slice(0,3);
  const riskRow=(x,yy,w,item,accent)=>{
    doc.setFillColor(255,255,255); doc.setDrawColor(226,231,238); doc.roundedRect(x,yy,w,29,6,6,'FD');
    doc.setFillColor(...accent); doc.rect(x,yy+1,3,27,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(8.6); doc.setTextColor(20,28,46);
    doc.text(doc.splitTextToSize(`#${item.n} ${item.name}`, 118), x+10, yy+17);
    const chipW = riskChip(x+126, yy+7, item.level);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.6); doc.setTextColor(90,107,128);
    doc.text(doc.splitTextToSize(item.why || '', Math.max(60, w-146-chipW)), x+132+chipW, yy+12);
  };
  sectionLabel('Top risks in this area', M, y);
  y+=24;
  const colGap=14, colW=(CW-colGap)/2;
  sectionLabel('Top high-risk factors', M, y);
  sectionLabel('Top moderate-risk factors', M+colW+colGap, y);
  y+=12;
  const rows=Math.max(topHigh.length, topMod.length, 1);
  for(let i=0;i<rows;i++){
    if(topHigh[i]) riskRow(M,y,colW,topHigh[i],[196,30,58]);
    if(topMod[i]) riskRow(M+colW+colGap,y,colW,topMod[i],[224,138,0]);
    y+=39;
  }
  if(c){
    y+=8;
    const prof=[['Population (ZIP)',c.pop],['Median Household Income',c.income],['Median Home Value',c.home],["Bachelor's+ Degree",c.bachelors]];
    const pw=(CW-18)/4;
    prof.forEach(([k,v],i)=>{
      const x=M+i*(pw+6);
      doc.setFillColor(247,249,252); doc.setDrawColor(226,231,238); doc.roundedRect(x,y,pw,47,6,6,'FD');
      doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(107,120,136); doc.text(k.toUpperCase(), x+8, y+15);
      doc.setFontSize(10.5); doc.setTextColor(20,28,46); doc.text(String(v), x+8, y+32);
    });
    y+=66;
  }else{
    y+=8;
  }
  const panelGap=16, panelW=(CW-panelGap)/2;
  const retail = amen ? amen.eat + amen.shop : null;
  const snapItems = amen
    ? [[retail,'Dining / retail'],[amen.park,'Parks'],[amen.transit + amen.station,'Transit points'],[amen.health,'Healthcare'],[amen.community,'Community places'],[amen.constr,'Construction']]
    : null;
  const panelH=160;
  doc.setFillColor(255,255,255); doc.setDrawColor(226,231,238); doc.roundedRect(M,y,panelW,panelH,8,8,'FD');
  sectionLabel('Neighborhood snapshot', M+12, y+18);
  if(snapItems){
    const tileW=(panelW-34)/2, tileH=34;
    snapItems.forEach(([v,k],i)=>{
      const x=M+12+(i%2)*(tileW+10), yy=y+32+Math.floor(i/2)*(tileH+8);
      doc.setFillColor(247,249,252); doc.setDrawColor(226,231,238); doc.roundedRect(x,yy,tileW,tileH,5,5,'FD');
      doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(20,28,46); doc.text(String(v), x+8, yy+15);
      doc.setFontSize(7); doc.setTextColor(90,107,128); doc.text(k, x+8, yy+27);
    });
  }else{
    para('Neighborhood amenities could not be loaded from OpenStreetMap for this run.', M+12, y+48, panelW-24, 9.2);
  }
  doc.setFillColor(255,255,255); doc.setDrawColor(226,231,238); doc.roundedRect(M+panelW+panelGap,y,panelW,panelH,8,8,'FD');
  sectionLabel('Air + weather', M+panelW+panelGap+12, y+18);
  const w = (env && env.weather && env.weather.current) || {};
  const a = (env && env.air && env.air.current) || {};
  const aqi = a.us_aqi == null ? null : Math.round(+a.us_aqi);
  const aq = aqiLabel(aqi);
  const temp = w.temperature_2m == null ? 'n/a' : `${Math.round(+w.temperature_2m)} F`;
  const wind = w.wind_speed_10m == null ? 'n/a' : `${Math.round(+w.wind_speed_10m)} mph ${windDirection(w.wind_direction_10m)}`;
  const humid = w.relative_humidity_2m == null ? 'n/a' : `${Math.round(+w.relative_humidity_2m)}%`;
  const ax=M+panelW+panelGap+12, ay=y+32;
  doc.setFillColor(247,249,252); doc.setDrawColor(226,231,238); doc.roundedRect(ax,ay,panelW-24,48,6,6,'FD');
  doc.setDrawColor(235,238,244); doc.setLineWidth(7); doc.circle(ax+25,ay+24,17,'S');
  doc.setDrawColor(224,138,0); doc.setLineWidth(7); doc.circle(ax+25,ay+24,17,'S'); doc.setLineWidth(1);
  doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(20,28,46); doc.text(String(aqi ?? 'n/a'), ax+18, ay+29);
  doc.setFontSize(12); doc.text(aq.label, ax+56, ay+23);
  doc.setFontSize(7); doc.setTextColor(90,107,128); doc.text('US AQI', ax+56, ay+36);
  const miniW=(panelW-44)/3;
  [[temp,'Clouds'],[wind,'Wind'],[humid,'Humidity']].forEach(([v,k],i)=>{
    const tx=ax+i*(miniW+8), ty=ay+60;
    doc.setFillColor(255,255,255); doc.setDrawColor(226,231,238); doc.roundedRect(tx,ty,miniW,31,5,5,'FD');
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(20,28,46); doc.text(String(v), tx+6, ty+13);
    doc.setFontSize(6.5); doc.setTextColor(90,107,128); doc.text(k, tx+6, ty+24);
  });
  para(aq.note, ax, ay+109, panelW-24, 8.2, [90,107,128]);
  y+=panelH+24;
  doc.setFillColor(247,249,252); doc.setDrawColor(226,231,238); doc.roundedRect(M,y,CW,42,6,6,'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(8.3); doc.setTextColor(90,107,128);
  doc.text('Active map layers:', M+10, y+17);
  doc.setFont('helvetica','normal'); doc.setFontSize(8.3); doc.setTextColor(90,107,128);
  doc.text(doc.splitTextToSize('OpenStreetMap - FEMA Flood Zones - Liquefaction Zones (CGS) - Landslide Zones (CGS) - Earthquake Fault Lines (CGS) - Fire Hazard Severity (CAL FIRE)', CW-116), M+90, y+17);
  y+=58;
  doc.setDrawColor(226,231,238); doc.line(M,y,W-M,y); y+=18;
  doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(49,112,246);
  doc.text('How risk levels are determined', M, y);

  /* ---- Compact factor appendix ---- */
  doc.addPage(); y=M+6;
  const LVLPDF={ // [fill, border, text]
    'NA':[[238,241,245],[224,229,236],[107,120,136]],
    'No':[[234,240,246],[214,224,234],[70,99,124]],
    'Low':[[231,246,238],[200,234,214],[21,122,66]],
    'Moderate':[[253,242,220],[244,219,168],[167,103,0]],
    'High':[[253,231,235],[246,196,206],[187,29,56]] };
  const levelTag=(x,yy,val)=>{
    const t=String(val||'NA'); doc.setFontSize(7.5); doc.setFont('helvetica','bold');
    const w=doc.getTextWidth(t)+12;
    const c=LVLPDF[val]||LVLPDF['NA'];
    doc.setFillColor(...c[0]); doc.setDrawColor(...c[1]); doc.roundedRect(x,yy,w,14,3,3,'FD');
    doc.setTextColor(...c[2]); doc.text(t,x+6,yy+9.5); return w;
  };
  const appendixHeader=()=>{
    doc.setFont('helvetica','bold'); doc.setFontSize(15); doc.setTextColor(20,28,46);
    doc.text('Factor Appendix', M, y); y+=8;
    doc.setDrawColor(20,28,46); doc.setLineWidth(1.5); doc.line(M,y,W-M,y); doc.setLineWidth(1); y+=13;
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(90,107,128);
    doc.text('Impact bands only. Open the interactive report for expandable explanations and live maps.', M, y); y+=16;
    doc.setFillColor(247,249,252); doc.setDrawColor(226,231,238); doc.roundedRect(M,y,CW,20,5,5,'FD');
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(90,107,128);
    doc.text('FACTOR', M+10, y+13);
    doc.text('CATEGORY', M+212, y+13);
    doc.text('HEALTH', M+314, y+13);
    doc.text('PROPERTY', M+376, y+13);
    doc.text('INSURANCE', M+454, y+13);
    doc.text('LINK', M+512, y+13);
    y+=24;
  };
  appendixHeader();
  FACTORS.forEach(f=>{
    const cat = f.cat || 'Other';
    const lv=live[f.n]; const rk=riskKey(lv&&lv.label); const col=PDFRC[rk];
    const detail=(lv&&lv.desc)?lv.desc:f.detail;
    const im=effImpact(f,lv);
    const desc = doc.splitTextToSize(detail, 188).slice(0,2);
    const rowH = Math.max(36, 20 + desc.length*8);
    if(y+rowH > H-52){ doc.addPage(); y=M+6; appendixHeader(); }
    doc.setDrawColor(238,242,247); doc.setFillColor(255,255,255); doc.roundedRect(M,y,CW,rowH,5,5,'FD');
    doc.setFillColor(col[0],col[1],col[2]); doc.rect(M,y+1,3,rowH-2,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(8.7); doc.setTextColor(20,28,46);
    doc.text(`#${f.n} ${f.name}`, M+10, y+14);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(90,107,128);
    doc.text(desc, M+10, y+25);
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(43,57,77);
    doc.text(doc.splitTextToSize(cat, 82), M+212, y+15);
    levelTag(M+314, y+10, im.health.level);
    levelTag(M+376, y+10, im.property.level);
    levelTag(M+454, y+10, im.insurance.level);
    doc.setTextColor(59,110,165); doc.setFont('helvetica','bold'); doc.setFontSize(8);
    doc.textWithLink('Open', M+512, y+15, {url:fill(f.map,STATE)});
    y += rowH+6;
  });

  /* ---- footer ---- */
  if(y>H-122){ doc.addPage(); y=M; }
  doc.setFillColor(255,250,240); doc.setDrawColor(240,226,189); doc.roundedRect(M,H-116,CW,54,6,6,'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(8.2); doc.setTextColor(90,74,35);
  doc.text('Disclaimer acknowledgement', M+10, H-99);
  doc.setFont('helvetica','normal'); doc.setFontSize(7.3); doc.setTextColor(90,74,35);
  doc.text(doc.splitTextToSize(DISCLAIMER_ACK_STATEMENT, CW-20), M+10, H-86);
  doc.setTextColor(133,147,166); doc.setFontSize(8); doc.setFont('helvetica','normal');
  doc.text(doc.splitTextToSize('Informational screening from public data (U.S. Census, FEMA NFHL, OpenStreetMap and each factor’s agency map). Not a substitute for a professional inspection, geotechnical study, title report, or insurance underwriting.',CW), M, H-44);

  const safe=(STATE.zip||'address')+'_'+(STATE.display.split(',')[0].replace(/[^a-z0-9]+/gi,'_'));
  doc.save(`CA_Risk_Report_${safe}.pdf`);
  recordStat('download');
  setStatus('✓ PDF downloaded.','ok');
  }finally{
    $('#pdf').disabled=false;
  }
}

/* ---------- Address autosuggest ---------- */
let sugTimer=null, sugItems=[], sugActive=-1;
const SUG_CACHE = {};
async function fetchSuggest(q){
  const key=q.toLowerCase();
  if(SUG_CACHE[key]) return SUG_CACHE[key];
  const url=`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`;
  try{
    const r=await fetch(url); if(!r.ok) return [];
    const j=await r.json();
    const out=(j.features||[])
      .filter(f=>((f.properties||{}).state==='California'))
      .map(f=>{ const p=f.properties||{};
        const line1=[p.housenumber,p.street].filter(Boolean).join(' ')||p.name||'';
        const display=[...new Set([line1, p.city||p.town||p.village, 'California', p.postcode].filter(Boolean))].join(', ');
        return { display, lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0] };
      })
      .filter(x=>x.display);
    SUG_CACHE[key]=out;
    return out;
  }catch(e){ return []; }
}

function renderSuggest(items){
  const box=$('#suggest'); sugItems=items; sugActive=-1;
  if(!items.length){ box.classList.add('hidden'); box.innerHTML=''; return; }
  box.innerHTML=items.map((it,i)=>{
    const parts=it.display.split(','); const t=parts.slice(0,2).join(','); const s=parts.slice(2).join(',').trim();
    return `<div class="opt" data-i="${i}"><span class="pin">📍</span><span><span class="t">${t}</span><br><span class="s">${s}</span></span></div>`;
  }).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.opt').forEach(el=>el.addEventListener('mousedown',e=>{
    e.preventDefault(); const it=sugItems[+el.dataset.i]; $('#addr').value=it.display;
    box.classList.add('hidden'); analyze();
  }));
}
function onAddrInput(){
  const q=$('#addr').value.trim();
  if(sugTimer) clearTimeout(sugTimer);
  if(q.length<4){ $('#suggest').classList.add('hidden'); return; }
  $('#suggest').classList.remove('hidden'); $('#suggest').innerHTML='<div class="loading">Searching California addresses…</div>';
  sugTimer=setTimeout(async()=>{ renderSuggest(await fetchSuggest(q)); }, 450);
}
function onAddrKey(e){
  const box=$('#suggest'); const open=!box.classList.contains('hidden') && sugItems.length;
  if(e.key==='ArrowDown' && open){ e.preventDefault(); sugActive=Math.min(sugActive+1,sugItems.length-1); highlight(); }
  else if(e.key==='ArrowUp' && open){ e.preventDefault(); sugActive=Math.max(sugActive-1,0); highlight(); }
  else if(e.key==='Enter'){
    if(open && sugActive>=0){ $('#addr').value=sugItems[sugActive].display; box.classList.add('hidden'); }
    analyze();
  } else if(e.key==='Escape'){ box.classList.add('hidden'); }
}
function highlight(){ const opts=$('#suggest').querySelectorAll('.opt');
  opts.forEach((o,i)=>o.classList.toggle('active',i===sugActive)); }

/* ---------- wire up ---------- */
$('#go').addEventListener('click', analyze);
$('#addr').addEventListener('input', onAddrInput);
$('#addr').addEventListener('keydown', onAddrKey);
document.addEventListener('click', e=>{ if(!e.target.closest('.field')) $('#suggest').classList.add('hidden'); });
$('#pdf').addEventListener('click', openDisclaimerModal);
document.querySelectorAll('.example').forEach(b=>b.addEventListener('click',()=>{
  $('#addr').value=b.dataset.a; $('#suggest').classList.add('hidden'); analyze();
}));

function handleDonationReturn(){
  const params = new URLSearchParams(window.location.search);
  if(params.get('donation') !== 'success') return;
  const pending = loadDonationReturnState();
  history.replaceState(null, '', window.location.pathname + window.location.hash);
  if(!pending){
    setStatus('<span class="ok">✓</span> Donation complete — enter the address again to download the PDF.','ok');
    return;
  }
  const input = $('#addr');
  if(input) input.value = pending.address;
  RESUME_PDF_AFTER_DONATION = true;
  analyze();
}

/* build stamp: makes the deployed version visible on the page itself */
(function(){
  const b=(window.APP_CONFIG||{}).BUILD||'unknown';
  const t=document.getElementById('buildTag');
  if(t) t.textContent=' · build '+b;
  console.log('CA Risk Report build:', b);
  recordSiteView();
  handleDonationReturn();
})();
