/* California Address Risk & Livability Report — front-end logic.
   Pure static: geocoding (Nominatim/OSM), live lookups (Census ACS, FEMA NFHL),
   address-centered Esri basemap thumbnails, recentered map links, jsPDF export. */

const RC = {no:'#5b7c99', low:'#2e8b57', mod:'#e08a00', high:'#c41e3a', pending:'#8593a6'};
const ESRI = {street:'World_Street_Map', topo:'World_Topo_Map', imagery:'World_Imagery', gray:'Canvas/World_Light_Gray_Base'};
const $ = s => document.querySelector(s);

let STATE = null; // {addr, lat, lon, zip, city, display}
let map, marker;

function setStatus(html, cls=''){ const s=$('#status'); s.className='status '+cls; s.innerHTML=html; }

function thumbUrl(lat, lon, basemap, w=660, h=320){
  const dLat = 0.014, dLon = 0.014/Math.cos(lat*Math.PI/180);
  const bbox = [lon-dLon, lat-dLat, lon+dLon, lat+dLat].join(',');
  return `https://services.arcgisonline.com/arcgis/rest/services/${ESRI[basemap]||ESRI.street}/MapServer/export`
       + `?bbox=${bbox}&bboxSR=4326&size=${w},${h}&format=png&transparent=false&f=image`;
}

function fill(tmpl, st){
  return tmpl
    .replaceAll('{ADDR}', encodeURIComponent(st.display))
    .replaceAll('{LAT}', st.lat.toFixed(6))
    .replaceAll('{LON}', st.lon.toFixed(6))
    .replaceAll('{LONABS}', Math.abs(st.lon).toFixed(6))
    .replaceAll('{ZIP}', st.zip||'')
    .replaceAll('{CITY}', encodeURIComponent(st.city||''));
}

/* ---------- Geocoding (CA-only) ---------- */
async function geocode(q){
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1`
            + `&countrycodes=us&limit=1&q=${encodeURIComponent(q)}`;
  let data;
  try{
    const res = await fetch(url, {headers:{'Accept':'application/json'}});
    if(!res.ok) throw new Error('Geocoder returned '+res.status);
    data = await res.json();
  }catch(e){ throw new Error('Network error contacting geocoder. '+(e.message||'')); }
  if(!data || !data.length) throw new Error('Address not found. Try a fuller street address.');
  const r = data[0]; const a = r.address||{};
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

function renderSummaryTable(st, liveResults){
  const gz=$('#glanceZip'); if(gz) gz.textContent = st.zip ? `\u2014 ZIP ${st.zip} \u00b7 ${ZIP_CITY[st.zip]||st.city||''}` : '';
  const NOTES = localNotesFor(st);
  const cell = o => `<td class="impcell">${lvlPill(o.level)}<span class="w">${o.why}</span></td>`;
  const rows = FACTORS.map(f=>{
    const live=liveResults[f.n]; const rk=riskKey(live&&live.label);
    const localNote = NOTES[f.n] ? `<div class="localnote">\ud83d\udccd ${NOTES[f.n]}</div>` : '';
    const what=((live&&live.desc)?live.desc:f.detail) + localNote;
    const im=effImpact(f,live);
    const mapUrl=fill(f.map, st);
    const risk = live
      ? `${live.label.replace(' Risk','')} · ${live.score}/10`
      : `<a class="rk-link" href="${mapUrl}" target="_blank" rel="noopener">Open map ↗</a>`;
    return `<tr id="sumrow-${f.n}">
      <td class="num">${f.n}</td>
      <td><div class="fname">${f.name}</div><div class="fcat">${f.cat}</div></td>
      <td class="what">${what}</td>
      ${cell(im.health)}${cell(im.property)}${cell(im.insurance)}
      <td class="rk rk-${rk}">${risk}</td>
    </tr>`;
  }).join('');
  $('#summaryTable').innerHTML =
    `<colgroup><col class="c-num"><col class="c-fac"><col class="c-what">
       <col class="c-imp"><col class="c-imp"><col class="c-imp"><col class="c-rk"></colgroup>
     <thead><tr>
       <th>#</th><th>Factor</th><th>What it is</th>
       <th>Health impact</th><th>Property&nbsp;Value impact</th><th>Insurance impact</th><th>Risk</th>
     </tr></thead><tbody>${rows}</tbody>`;
}

function riskKey(label){ if(!label) return 'pending'; const l=label.toLowerCase();
  return l.includes('high')?'high':l.includes('moderate')?'mod':l.includes('low')?'low':'no'; }

const LVLCLASS={'NA':'na','No':'no','Low':'low','Moderate':'mod','High':'high'};
function lvlPill(level){ return `<span class="lvl lvl-${LVLCLASS[level]||'na'}">${level}</span>`; }

// effective per-dimension impact, with live data (flood) overriding where known
function effImpact(f, live){
  const im={health:{...f.impact.health}, property:{...f.impact.property}, insurance:{...f.impact.insurance}};
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
      dims[k].items.push({ n:f.n, name:f.name, cat:f.cat, level:im[k].level, why:im[k].why, v,
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
  drawGauge(RISK.overall.score, RISK.overall.band);
  $('#dimTabs').innerHTML = DIMMETA.map(([k,label])=>{
    const s = k==='overall' ? RISK.overall : RISK.dims[k];
    return `<button class="dimtab ${k===ACTIVEDIM?'active':''}" data-dim="${k}">
      <span class="t">${label}</span><span class="s" style="color:${RC[BANDKEY[s.band]]}">${s.score.toFixed(1)} · ${s.band}</span></button>`;
  }).join('');
  document.querySelectorAll('.dimtab').forEach(b=>b.addEventListener('click',()=>{
    ACTIVEDIM=b.dataset.dim;
    document.querySelectorAll('.dimtab').forEach(x=>x.classList.toggle('active', x.dataset.dim===ACTIVEDIM));
    renderDrivers();
  }));
  renderDrivers();
  const liveN = Object.keys(STATE._live||{}).length;
  $('#methodBody').innerHTML =
    `<p>Each of the 36 factors carries an impact level per dimension &mdash; <b>NA</b> (excluded), <b>No</b> (0), <b>Low</b> (2.5), <b>Moderate</b> (6), <b>High</b> (9). A dimension's score is the average across its applicable factors; the overall score is the average of the three dimensions, banded as <b>0 No &middot; 1&ndash;4 Low &middot; 5&ndash;7 Moderate &middot; 8&ndash;10 High</b>.</p>
     <p><b>What's live vs. baseline:</b> ${liveN} factor(s) are currently verified against live agency data for this exact address (FEMA flood zone${liveN>1?', Census demographics':''}) and override the baseline where they apply &mdash; e.g. a Special Flood Hazard Area raises Property &amp; Insurance sharply. The remaining factors use their typical California exposure profile, so treat this as an <b>indicative screening score</b>, not an address-certified rating. More live lookups (CAL FIRE, CGS, CalGEM&hellip;) can be added over time to make it increasingly address-specific.</p>
     <p>Informational only &mdash; not a substitute for professional inspection, geotechnical study, or insurance underwriting.</p>`;
  return RISK;
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
  { name:'FEMA Flood Zones',              type:'dynamic', on:true,
    url:'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer', layers:[28], opacity:.45 },
  { name:'Liquefaction Zones (CGS)',      type:'dynamic',
    url:'https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Liquefaction_Zones/MapServer', opacity:.55 },
  { name:'Landslide Zones (CGS)',         type:'dynamic',
    url:'https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Landslide_Zones/MapServer', opacity:.55 },
  { name:'Earthquake Fault Zones (CGS)',  type:'feature',
    url:'https://gis.conservation.ca.gov/server/rest/services/CGS_Earthquake_Hazard_Zones/SHP_Fault_Zones/FeatureServer/0',
    style:{ color:'#c41e3a', weight:2, fillOpacity:.15 } },
  { name:'Fire Hazard Severity (CAL FIRE)', type:'dynamic',
    url:'https://services.gis.ca.gov/arcgis/rest/services/Environment/Fire_Severity_Zones/MapServer', opacity:.5 },
];

function buildMainMap(st){
  if(map){ try{ map.remove(); }catch(e){} map=null; }
  map = L.map('map', { scrollWheelZoom:true }).setView([st.lat, st.lon], 14);
  const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'\u00a9 OpenStreetMap'});
  const imagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'\u00a9 Esri'});
  streets.addTo(map);
  const overlays = {};
  if(window.L && window.L.esri){
    MAP_OVERLAYS.forEach(o=>{
      let layer=null;
      try{
        layer = o.type==='feature'
          ? L.esri.featureLayer({url:o.url, style:()=>o.style||{}})
          : L.esri.dynamicMapLayer({url:o.url, opacity:o.opacity ?? .5, layers:o.layers});
      }catch(e){ return; }
      overlays[o.name]=layer;
      if(o.on) layer.addTo(map);
    });
  }
  L.control.layers({ 'Streets':streets, 'Imagery':imagery }, overlays, {collapsed:false, position:'topright'}).addTo(map);
  L.control.scale({imperial:true}).addTo(map);
  marker = L.marker([st.lat, st.lon]).addTo(map).bindPopup(st.display).openPopup();
}

/* ---------- Main flow ---------- */
async function analyze(){
  const q=$('#addr').value.trim();
  if(!q){ setStatus('Enter a California address.','err'); return; }
  $('#go').disabled=true; $('#pdf').disabled=true;
  setStatus('<span class="spinner"></span>Geocoding address…');
  let st;
  try{ st=await geocode(q); }
  catch(e){ setStatus(e.message,'err'); $('#go').disabled=false; return; }
  STATE=st;
  if(!ZIP_CITY[st.zip]){ showComingSoon(st); $('#go').disabled=false; return; }
  try{
  $('#comingsoon').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#results').classList.remove('hidden');
  $('#locZip').textContent = 'ZIP '+(st.zip||'n/a');
  $('#locAddr').textContent = st.display;
  $('#locCoords').textContent = `${(+st.lat).toFixed(5)}, ${(+st.lon).toFixed(5)}`;
  setStatus(`<span class="ok">✓</span> Showing results for ${st.display.split(',').slice(0,2).join(',')}`,'ok');
  renderLegend();
  invalidateMapSoon();

  buildMainMap(st);

  const liveResults={};
  renderProfile(null, st);

  // live lookups in parallel
  const [census, flood] = await Promise.all([ censusByZip(st.zip), femaFloodZone(st.lat, st.lon) ]);
  renderProfile(census, st);
  if(flood){ liveResults[8]=flood; }
  if(census){ liveResults[1]={label:'No Risk', score:0, desc:`ZIP ${st.zip}: pop ${census.pop}, median income ${census.income}, median home ${census.home}, ${census.bachelors} bachelor's+.`}; }

  // summary view (table) + overall risk score
  renderScoring();
  renderSummaryTable(st, liveResults);
  STATE._live=liveResults;
  const R = renderOverall(liveResults);
  updateMapRisk(st);
  const fmt = d => `${d.band} · ${d.score.toFixed(1)}/10`;
  const d = { health: fmt(R.dims.health), prop: fmt(R.dims.property), ins: fmt(R.dims.insurance) };
  $('#dimHealth').textContent=d.health; $('#dimProp').textContent=d.prop; $('#dimIns').textContent=d.ins;
  $('#foot').innerHTML=`Generated ${new Date().toLocaleDateString()} · Geocoding © OpenStreetMap/Nominatim · Demographics: U.S. Census ACS · Flood: FEMA NFHL · Basemaps © Esri. `
    +`Informational screening only — not a substitute for a professional inspection, geotechnical study, or insurance underwriting.`;

  STATE._dims=d; STATE._census=census;
  $('#pdf').disabled=false;
  setStatus(`<span class="ok">✓</span> Report ready — ${FACTORS.length} factors for ${st.display.split(',').slice(0,2).join(',')}`,'ok');
  }catch(e){ console.error(e); setStatus('Something went wrong rendering the report: '+(e.message||e),'err'); }
  finally{ $('#go').disabled=false; }
}

/* show/resize the Leaflet map once its container is visible */
function invalidateMapSoon(){ setTimeout(()=>{ if(map) map.invalidateSize(); }, 60); }

/* ---------- PDF (matches the polished report design) ---------- */
const PDFRC={no:[91,124,153], low:[46,139,87], mod:[224,138,0], high:[196,30,58], pending:[133,147,166]};
function loadImg(src){
  return new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin='anonymous';
    i.onload=()=>res(i); i.onerror=()=>rej(new Error('img')); i.src=src; });
}
async function makePDF(){
  if(!STATE) return;
  setStatus('<span class="spinner"></span>Building PDF…');
  const { jsPDF } = window.jspdf;
  const doc=new jsPDF({unit:'pt', format:'letter', compress:true}); // 612 x 792
  const W=612, H=792, M=40, CW=W-2*M;
  const live=STATE._live, d=STATE._dims, c=STATE._census;

  // preload thumbnails (overview + per factor) in parallel
  const imgs={};
  await Promise.all([
    loadImg(thumbUrl(STATE.lat,STATE.lon,'street',680,300)).then(i=>imgs.cover=i).catch(()=>{}),
    ...FACTORS.map(f=>loadImg(thumbUrl(STATE.lat,STATE.lon,f.basemap,420,300)).then(i=>imgs[f.n]=i).catch(()=>{}))
  ]);

  /* ---- Cover ---- */
  doc.setFillColor(20,28,46); doc.rect(0,0,W,168,'F');
  doc.setTextColor(157,180,214); doc.setFontSize(9); doc.setFont('helvetica','bold');
  doc.text('CALIFORNIA NEIGHBORHOOD INTELLIGENCE', M, 42);
  doc.setTextColor(255,255,255); doc.setFontSize(23); doc.text('Address Risk & Livability Report', M, 70);
  doc.setFont('helvetica','normal'); doc.setFontSize(11); doc.setTextColor(220,228,240);
  doc.text(doc.splitTextToSize(STATE.display, CW), M, 94);
  doc.setFontSize(10); doc.setTextColor(157,180,214);
  doc.text(`ZIP ${STATE.zip||'n/a'}   ·   ${(+STATE.lat).toFixed(5)}, ${(+STATE.lon).toFixed(5)}   ·   ${new Date().toLocaleDateString()}   ·   36 factors`, M, 150);
  let y=190;
  // dimension cards
  const dims=[['HEALTH RISK',d.health],['PROPERTY VALUE RISK',d.prop],['INSURANCE COST',d.ins]];
  const bw=(CW-24)/3;
  dims.forEach((dm,i)=>{ const x=M+i*(bw+12);
    doc.setFillColor(247,249,252); doc.setDrawColor(226,231,238); doc.roundedRect(x,y,bw,54,6,6,'FD');
    doc.setTextColor(90,107,128); doc.setFontSize(7.5); doc.text(dm[0],x+10,y+17);
    doc.setTextColor(26,36,51); doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.text(doc.splitTextToSize(String(dm[1]),bw-20),x+10,y+34); doc.setFont('helvetica','normal');
  });
  y+=70;
  if(c){ doc.setFillColor(247,249,252); doc.setDrawColor(226,231,238); doc.roundedRect(M,y,CW,30,6,6,'FD');
    doc.setTextColor(60,72,90); doc.setFontSize(9.5);
    doc.text(`Population (ZIP): ${c.pop}      Median income: ${c.income}      Median home: ${c.home}      Bachelor's+: ${c.bachelors}`, M+10, y+19); y+=42; }
  if(imgs.cover){ const ih=(CW)*300/680; doc.addImage(imgs.cover,'JPEG',M,y,CW,ih);
    doc.setDrawColor(196,30,58); doc.setLineWidth(2); doc.rect(M,y,CW,ih); doc.setLineWidth(1); y+=ih+6; }
  doc.setFontSize(8); doc.setTextColor(133,147,166);
  doc.text('Overall dimensions are indicative; per-factor detail and live lookups follow.', M, y+4);

  /* ---- Factor cards ---- */
  doc.addPage(); y=M+6;
  doc.setFont('helvetica','bold'); doc.setFontSize(15); doc.setTextColor(20,28,46);
  doc.text('Factor Assessments (1–36)', M, y); y+=8;
  doc.setDrawColor(20,28,46); doc.setLineWidth(1.5); doc.line(M,y,W-M,y); doc.setLineWidth(1); y+=14;

  const LVLPDF={ // [fill, border, text]
    'NA':[[238,241,245],[224,229,236],[107,120,136]],
    'No':[[234,240,246],[214,224,234],[70,99,124]],
    'Low':[[231,246,238],[200,234,214],[21,122,66]],
    'Moderate':[[253,242,220],[244,219,168],[167,103,0]],
    'High':[[253,231,235],[246,196,206],[187,29,56]] };
  const chip=(x,yy,label,val)=>{
    const t=`${label}: ${val}`; doc.setFontSize(8);
    const w=doc.getTextWidth(t)+12;
    const c=LVLPDF[val]||LVLPDF['NA'];
    doc.setFillColor(...c[0]); doc.setDrawColor(...c[1]); doc.roundedRect(x,yy,w,15,3,3,'FD');
    doc.setTextColor(...c[2]); doc.text(t,x+6,yy+10); return w+6;
  };
  FACTORS.forEach(f=>{
    const lv=live[f.n]; const rk=riskKey(lv&&lv.label); const col=PDFRC[rk];
    const detail=(lv&&lv.desc)?lv.desc:f.detail;
    doc.setFontSize(9.5); const dl=doc.splitTextToSize(detail, CW-24);
    const cardH = 22 + 14 + dl.length*11 + 8 + 15 + 8 + 12 + 14;
    if(y+cardH > H-44){ doc.addPage(); y=M+6; }
    // card frame
    doc.setDrawColor(226,231,238); doc.setFillColor(255,255,255); doc.roundedRect(M,y,CW,cardH,7,7,'FD');
    doc.setFillColor(col[0],col[1],col[2]); doc.rect(M,y+1,4,cardH-2,'F'); // left stripe
    let yy=y+16;
    doc.setTextColor(133,147,166); doc.setFontSize(7.5); doc.setFont('helvetica','bold');
    doc.text(f.cat.toUpperCase(), M+14, yy);
    doc.setTextColor(20,28,46); doc.setFontSize(11.5); doc.text(`#${f.n}  ${f.name}`, M+14, yy+14);
    // badge
    const blabel = lv ? `${lv.label}${lv.score!=null?' · '+lv.score+'/10':''}` : 'Open map to assess';
    doc.setFontSize(8.5); const bw2=doc.getTextWidth(blabel)+16;
    const bx=W-M-bw2-8;
    if(rk==='pending'){ doc.setFillColor(133,147,166);} else { doc.setFillColor(col[0],col[1],col[2]); }
    doc.roundedRect(bx,y+10,bw2,16,4,4,'F');
    doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.text(blabel,bx+8,y+21);
    // detail
    doc.setFont('helvetica','normal'); doc.setTextColor(43,57,77); doc.setFontSize(9.5);
    yy=y+38; doc.text(dl, M+14, yy); yy+=dl.length*11+4;
    // dim chips (color-coded by level)
    const im=effImpact(f,lv);
    let cx=M+14; doc.setFont('helvetica','normal');
    cx+=chip(cx,yy,'Health',im.health.level);
    cx+=chip(cx,yy,'Property Value',im.property.level);
    cx+=chip(cx,yy,'Insurance',im.insurance.level);
    yy+=24;
    // source link
    doc.setTextColor(59,110,165); doc.setFontSize(8.5);
    doc.textWithLink('Open live map  (recentered on this address)', M+14, yy, {url:fill(f.map,STATE)});
    y += cardH+10;
  });

  /* ---- Map Shots ---- */
  doc.addPage(); y=M+6;
  doc.setFont('helvetica','bold'); doc.setFontSize(15); doc.setTextColor(20,28,46);
  doc.text('Map Shots — address in view', M, y); y+=8;
  doc.setDrawColor(20,28,46); doc.setLineWidth(1.5); doc.line(M,y,W-M,y); doc.setLineWidth(1); y+=14;
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(90,100,115);
  doc.text(doc.splitTextToSize('Each thumbnail is a live basemap centered on the address. Open the linked interactive map for full hazard layers.',CW), M, y); y+=22;
  const tw=(CW-14)/2, th=tw*300/420;
  let col2=0;
  FACTORS.forEach(f=>{
    if(y+th+30 > H-30){ doc.addPage(); y=M+6; col2=0; }
    const x=M+col2*(tw+14);
    if(imgs[f.n]){ doc.addImage(imgs[f.n],'JPEG',x,y,tw,th); }
    else { doc.setFillColor(230,236,243); doc.rect(x,y,tw,th,'F'); }
    doc.setDrawColor(226,231,238); doc.rect(x,y,tw,th);
    doc.setTextColor(20,28,46); doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    doc.text(doc.splitTextToSize(`#${f.n} ${f.name}`,tw), x, y+th+12);
    if(col2===1){ y+=th+34; col2=0; } else { col2=1; }
  });

  /* ---- footer ---- */
  if(y>H-60){ doc.addPage(); y=M; }
  doc.setTextColor(133,147,166); doc.setFontSize(8); doc.setFont('helvetica','normal');
  doc.text(doc.splitTextToSize('Informational screening from public data (U.S. Census, FEMA NFHL, Esri, OpenStreetMap and each factor’s agency map). Not a substitute for a professional inspection, geotechnical study, title report, or insurance underwriting.',CW), M, H-44);

  const safe=(STATE.zip||'address')+'_'+(STATE.display.split(',')[0].replace(/[^a-z0-9]+/gi,'_'));
  doc.save(`CA_Risk_Report_${safe}.pdf`);
  setStatus('✓ PDF downloaded.','ok');
}

/* ---------- Address autosuggest ---------- */
let sugTimer=null, sugItems=[], sugActive=-1;
async function fetchSuggest(q){
  const url=`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=us&limit=6&q=${encodeURIComponent(q)}`;
  try{ const r=await fetch(url,{headers:{'Accept':'application/json'}}); if(!r.ok) return [];
    const data=await r.json();
    return data.filter(x=>(x.address&&x.address.state==='California'))
      .map(x=>({display:x.display_name.replace(', United States',''), lat:x.lat, lon:x.lon}));
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
  sugTimer=setTimeout(async()=>{ renderSuggest(await fetchSuggest(q)); }, 320);
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
$('#pdf').addEventListener('click', ()=>{ makePDF().catch(e=>setStatus('PDF error: '+e.message,'err')); });
document.querySelectorAll('.example').forEach(b=>b.addEventListener('click',()=>{
  $('#addr').value=b.dataset.a; $('#suggest').classList.add('hidden'); analyze();
}));
