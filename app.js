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
function recordSiteView(){
  recordStat('view');
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
  const vars='NAME,DP05_0001E,DP03_0062E,DP04_0089E,DP02_0068PE';
  const yr=cfg.ACS_YEAR||'2023';
  const url=`https://api.census.gov/data/${yr}/acs/acs5/profile?get=${vars}&for=zip%20code%20tabulation%20area:${zip}&key=${cfg.CENSUS_KEY}`;
  try{
    const res=await fetch(url); if(!res.ok) return null;
    const j=await res.json(); if(!j||j.length<2) return null;
    const [h,row]=j; const o={}; h.forEach((k,i)=>o[k]=row[i]);
    return {
      pop:(+o.DP05_0001E).toLocaleString(),
      income: o.DP03_0062E>0 ? '$'+(+o.DP03_0062E).toLocaleString() : 'n/a',
      home: o.DP04_0089E>0 ? '$'+(+o.DP04_0089E).toLocaleString() : 'n/a',
      bachelors: o.DP02_0068PE>0 ? o.DP02_0068PE+'%' : 'n/a'
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
  const f=await esriQuery('https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Fault_Zones/FeatureServer/0',
                          q=>q.nearby(L.latLng(lat,lon), 500));
  if(f===null) return null;
  return f.length
    ? {label:'High Risk',score:8,desc:'Within ~500 m of an Alquist-Priolo earthquake fault zone.',
       impacts:{property:IMP('High','Fault-zone proximity \u2014 disclosure required, surface-rupture exposure.'),insurance:IMP('High','Earthquake coverage priced for near-fault exposure.')}}
    : {label:'Low Risk',score:2,desc:'No Alquist-Priolo fault zone within ~500 m of this point.',
       impacts:{property:IMP('Low','No mapped fault zone in the immediate vicinity.'),insurance:IMP('Moderate','Regional earthquake exposure still applies (statewide).')}};
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
  const direct = await overpassAmenitiesDirect(lat,lon);
  return amenityTotal(direct) > 0 ? direct : null;
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

function renderProfile(c, st){
  if(c){
    const items=[['Population (ZIP)',c.pop],['Median Household Income',c.income],['Median Home Value',c.home],["Bachelor's+ Degree",c.bachelors]];
    $('#profile').innerHTML = items.map(([k,v])=>`<div class="prof"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  } else if(st){
    const zlink=`https://www.zipdatamaps.com/${st.zip||''}`;
    $('#profile').innerHTML = `<div class="prof" style="grid-column:1/-1"><div class="k">ZIP ${st.zip||''} demographics</div>`
      +`<div class="v" style="font-weight:500;font-size:12px">Add a free <a href="https://api.census.gov/data/key_signup.html" target="_blank" rel="noopener">Census API key</a> in <code>config.js</code> to auto-load population, income &amp; home value — or <a href="${zlink}" target="_blank" rel="noopener">view the ZIP profile ↗</a>.</div></div>`;
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
    const links = `<span class="link-actions"><a class="rk-link map-open" href="${mapUrl}" target="_blank" rel="noopener">Open map</a>${detailBtn}</span>`;
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

function loadExplanationImages(panel){
  if(!panel || panel.dataset.loaded) return;
  const name = panel.dataset.name || 'Factor';
  const srcs = (panel.dataset.srcs || '').split('|').filter(Boolean);
  panel.innerHTML = srcs.map((s,i)=>`<img src="${s}" loading="lazy" alt="${name} explanation ${i+1}"/>`).join('');
  panel.dataset.loaded = 'true';
}

function impactBlock(label, item){
  return `<div class="detail-impact">
    <div class="detail-impact-top"><span>${label}</span>${lvlPill(item.level)}</div>
    <p>${item.why}</p>
  </div>`;
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
}

function closeFactorModal(){
  const modal = $('#xmodal');
  if(modal) modal.classList.add('hidden');
  SELECTED_FACTOR = null;
  document.querySelectorAll('#summaryTable tbody tr.selected').forEach(row=>{
    row.classList.remove('selected');
    row.setAttribute('aria-pressed','false');
  });
}
function stripeDonationUrl(){
  const url = String((window.APP_CONFIG||{}).STRIPE_DONATION_URL || '').trim();
  return /^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com|stripe\.com)\//i.test(url) ? url : '';
}
function closeDonationModal(){
  const modal = $("#donationModal");
  if(modal) modal.classList.add("hidden");
}
function showDonationModal(){
  const modal = $("#donationModal");
  const link = $("#donationStripe");
  const note = document.querySelector("#donationNote");
  const actions = modal ? modal.querySelector(".donation-actions") : null;
  if(!modal || !link) return false;
  const url = stripeDonationUrl();
  if(url){
    link.href = url;
    link.classList.remove("hidden");
    link.setAttribute("aria-disabled", "false");
    if(actions) actions.classList.remove("single");
    if(note) note.textContent = "Donation is optional. You can skip and download the PDF anytime.";
  }else{
    link.href = "#";
    link.classList.add("hidden");
    link.setAttribute("aria-disabled", "true");
    if(actions) actions.classList.add("single");
    if(note) note.textContent = "Stripe donation link is not configured yet. You can still download the PDF.";
  }
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
  const retail = amen ? amen.eat + amen.shop : null;
  $('#neighborhoodSnapshot').innerHTML = amen ? `<div class="snapgrid">
    <div><b>${retail}</b><span>Dining / retail</span></div>
    <div><b>${amen.park}</b><span>Parks</span></div>
    <div><b>${amen.transit + amen.station}</b><span>Transit points</span></div>
    <div><b>${amen.health}</b><span>Healthcare</span></div>
    <div><b>${amen.community}</b><span>Community places</span></div>
    <div><b>${amen.constr}</b><span>Construction</span></div>
  </div>` : '<p>Neighborhood amenities could not be loaded from OpenStreetMap for this run.</p>';
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
  renderLegend();
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
  const [census, flood, liq, lands, fault, fhsz, amen, env] = await Promise.all([
    safe(withTimeout(censusByZip(st.zip), 9000, 'Census'), 'Census'),
    safe(withTimeout(femaFloodZone(st.lat, st.lon), 9000, 'FEMA flood'), 'FEMA flood'),
    safe(withTimeout(cgsLiquefaction(st.lat, st.lon), 9000, 'CGS liquefaction'), 'CGS liquefaction'),
    safe(withTimeout(cgsLandslide(st.lat, st.lon), 9000, 'CGS landslide'), 'CGS landslide'),
    safe(withTimeout(cgsFault(st.lat, st.lon), 9000, 'CGS fault'), 'CGS fault'),
    safe(withTimeout(calfireFHSZ(st.lat, st.lon), 9000, 'CAL FIRE'), 'CAL FIRE'),
    safe(withTimeout(overpassAmenities(st), 32000, 'OpenStreetMap amenities'), 'OpenStreetMap amenities'),
    safe(withTimeout(localEnvironment(st.lat, st.lon), 6500, 'Environment'), 'Environment')
  ]);
  if(runId !== ANALYZE_RUN) return;
  setPageLoading(true, 'Rendering the final report...');
  renderProfile(census, st);
  if(flood){ liveResults[8]=flood; }
  if(liq){ liveResults[6]=liq; }
  if(lands){ liveResults[7]=lands; }
  if(fault){ liveResults[5]=fault; }
  if(fhsz){ liveResults[11]=fhsz; }
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
  setStatus(`<span class="ok">✓</span> Report ready — ${FACTORS.length} factors for ${st.display.split(',').slice(0,2).join(',')}`,'ok');
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

/* build stamp: makes the deployed version visible on the page itself */
(function(){
  const b=(window.APP_CONFIG||{}).BUILD||'unknown';
  const t=document.getElementById('buildTag');
  if(t) t.textContent=' · build '+b;
  console.log('CA Risk Report build:', b);
  recordSiteView();
})();
