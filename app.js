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
  const cell = o => `<td class="impcell">${lvlPill(o.level)}<span class="w">${o.why}</span></td>`;
  const rows = FACTORS.map(f=>{
    const live=liveResults[f.n]; const rk=riskKey(live&&live.label);
    const what=(live&&live.desc)?live.desc:f.detail;
    const im=effImpact(f,live);
    const mapUrl=fill(f.map, st);
    const risk = live
      ? `${live.label.replace(' Risk','')} · ${live.score}/10`
      : `<a class="rk-link" href="${mapUrl}" target="_blank" rel="noopener">Open map ↗</a>`;
    return `<tr>
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

function cardHTML(f, st, live){
  const url = fill(f.map, st);
  const thumb = thumbUrl(st.lat, st.lon, f.basemap);
  const col = RC[ riskKey(live&&live.label) ];
  const im = effImpact(f, live);
  const impRows = [['Health','health'],['Property','property'],['Insurance','insurance']]
    .map(([lab,k])=>`<div class="imp-row"><span class="imp-k">${lab}</span><span class="imp-lvl">${lvlPill(im[k].level)}</span><span class="imp-why">${im[k].why}</span></div>`).join('');
  const recenterTag = f.recenter==='search'
    ? `<span class="hint">↳ opens the live map — type the address in its search bar</span>`
    : `<span class="hint">↳ live map recentered on this address</span>`;
  const altLink = f.alt ? ` · <a href="${f.alt}" target="_blank" rel="noopener">alt source ↗</a>` : '';
  return `<div class="card" data-cat="${f.cat}" style="--stripe:${col}">
    <img class="thumb" src="${thumb}" alt="map of ${f.name} at the address" loading="lazy" crossorigin="anonymous"
         onerror="this.style.background='#e6ecf3';this.removeAttribute('src');"/>
    <div class="body">
      <div class="top">
        <div><div class="cat">${f.cat}</div><div class="nm">#${f.n} ${f.name}</div></div>
        ${badge(live&&live.label, live?live.score:null)}
      </div>
      <div class="note">${live&&live.desc ? live.desc : f.detail}</div>
      <div class="impacts">${impRows}</div>
      <div class="links"><a href="${url}" target="_blank" rel="noopener">Open live map ↗</a>${altLink}</div>
      ${recenterTag}
    </div></div>`;
}

function deriveDims(flood){
  const ins = flood && flood.score>=8 ? 'High (flood + earthquake)' : 'Moderately High (earthquake)';
  const prop = flood && flood.score>=8 ? 'Moderate–High' : 'Low–Moderate';
  return {health:'Low–Moderate (indicative)', prop, ins};
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
  $('#empty').classList.add('hidden');
  $('#results').classList.remove('hidden');
  $('#locZip').textContent = 'ZIP '+(st.zip||'n/a');
  $('#locAddr').textContent = st.display;
  $('#locCoords').textContent = `${(+st.lat).toFixed(5)}, ${(+st.lon).toFixed(5)}`;
  setStatus(`<span class="ok">✓</span> Showing results for ${st.display.split(',').slice(0,2).join(',')}`,'ok');
  renderLegend();
  invalidateMapSoon();

  // map
  if(!map){ map=L.map('map').setView([st.lat,st.lon],14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
  } else { map.setView([st.lat,st.lon],14); }
  if(marker) marker.remove();
  marker=L.marker([st.lat,st.lon]).addTo(map).bindPopup(st.display).openPopup();

  // factor cards (links + thumbnails first, ratings fill in)
  const liveResults={};
  $('#cards').innerHTML = FACTORS.map(f=>cardHTML(f, st, null)).join('');
  renderProfile(null, st);

  // live lookups in parallel
  const [census, flood] = await Promise.all([ censusByZip(st.zip), femaFloodZone(st.lat, st.lon) ]);
  renderProfile(census, st);
  if(flood){ liveResults[8]=flood; }
  if(census){ liveResults[1]={label:'No Risk', score:0, desc:`ZIP ${st.zip}: pop ${census.pop}, median income ${census.income}, median home ${census.home}, ${census.bachelors} bachelor's+.`}; }

  // summary view (table) + map shots + full detail cards
  renderScoring();
  renderSummaryTable(st, liveResults);
  renderMapShots(st);
  $('#cards').innerHTML = FACTORS.map(f=>cardHTML(f, st, liveResults[f.n]||null)).join('');
  buildFilters();

  // dims
  const d=deriveDims(flood);
  $('#dimHealth').textContent=d.health; $('#dimProp').textContent=d.prop; $('#dimIns').textContent=d.ins;

  const liveCount=Object.keys(liveResults).length;
  $('#counts').textContent=`${liveCount} auto-assessed from live data · ${FACTORS.length-liveCount} via recentered maps`;
  $('#foot').innerHTML=`Generated ${new Date().toLocaleDateString()} · Geocoding © OpenStreetMap/Nominatim · Demographics: U.S. Census ACS · Flood: FEMA NFHL · Basemaps © Esri. `
    +`Informational screening only — not a substitute for a professional inspection, geotechnical study, or insurance underwriting.`;

  STATE._live=liveResults; STATE._dims=d; STATE._census=census;
  $('#go').disabled=false; $('#pdf').disabled=false;
  setStatus(`<span class="ok">✓</span> Report ready — ${FACTORS.length} factors for ${st.display.split(',').slice(0,2).join(',')}`,'ok');
}

/* show/resize the Leaflet map once its container is visible */
function invalidateMapSoon(){ setTimeout(()=>{ if(map) map.invalidateSize(); }, 60); }

/* ---------- Map Shots (dynamic live screenshots via self-hosted server) ---------- */
function mapShotUrl(factorId, query){
  const cfg=window.APP_CONFIG||{};
  return `${cfg.MAPSHOT_API_BASE.replace(/\/$/,'')}/api/mapshot?factor=${factorId}&q=${encodeURIComponent(query)}`;
}

function renderMapShots(st){
  const cfg=window.APP_CONFIG||{};
  const section=$('#mapshotsSection');
  const searchFactors = FACTORS.filter(f=>f.recenter==='search');

  if(!cfg.MAPSHOT_API_BASE){
    $('#mapshotsNote').innerHTML = `Dynamic map shots aren't configured for this deployment yet. `
      + `Set <code>MAPSHOT_API_BASE</code> in <code>config.js</code> to your self-hosted map-shot server (see <code>/server</code>) to enable live, address-searched screenshots for the ${searchFactors.length} search-only factors below. `
      + `Until then, use each factor's "Open live map" link in Full Details and search manually.`;
    $('#mapshotsGrid').innerHTML='';
    return;
  }

  const query = st.zip || st.display;
  $('#mapshotsNote').innerHTML = `Searching <b>${query}</b> on ${searchFactors.length} agency sites. Each shot is captured live and cached for a week.`;
  $('#mapshotsGrid').innerHTML = searchFactors.map(f=>{
    const src = mapShotUrl(f.n, query);
    const liveLink = fill(f.map, st);
    return `<div class="card mscard" data-cat="${f.cat}">
      <div class="ms-imgwrap">
        <img class="thumb ms-thumb" src="${src}" alt="live search screenshot of ${f.name} for ${query}" loading="lazy"
             onload="this.closest('.mscard').classList.add('loaded')"
             onerror="this.closest('.mscard').classList.add('failed')"/>
        <div class="ms-loading"><span class="spinner"></span>Capturing live…</div>
        <div class="ms-failed">Couldn't capture a live shot. <a href="${liveLink}" target="_blank" rel="noopener">Open live map ↗</a> and search "${query}" yourself.</div>
      </div>
      <div class="body">
        <div class="top"><div><div class="cat">${f.cat}</div><div class="nm">#${f.n} ${f.name}</div></div></div>
        <div class="note">${f.detail}</div>
        <div class="links"><a href="${liveLink}" target="_blank" rel="noopener">Open live map ↗</a></div>
      </div>
    </div>`;
  }).join('');
}

/* category filter chips */
function buildFilters(){
  const cats=[...new Set(FACTORS.map(f=>f.cat))];
  const box=$('#filters');
  box.innerHTML = `<button class="fchip active" data-cat="*">All ${FACTORS.length}</button>`
    + cats.map(c=>`<button class="fchip" data-cat="${c.replace(/"/g,'')}">${c}</button>`).join('');
  box.querySelectorAll('.fchip').forEach(btn=>btn.addEventListener('click',()=>{
    box.querySelectorAll('.fchip').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const cat=btn.dataset.cat;
    document.querySelectorAll('#cards .card').forEach(card=>{
      card.style.display = (cat==='*'||card.dataset.cat===cat) ? '' : 'none';
    });
  }));
}

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
