// Map shell: tiles, panes, filter panel (state remembered per browser), place search, geolocation,
// province outlines and ThaiWater gauges. All data are static files: /data/* (prepared) and /live/* (jobs).
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const thaiTime=t=>t?new Date(t).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'short',timeStyle:'short'}):'ไม่ทราบเวลา';
function ago(t){const m=(Date.now()-Date.parse(t))/60000;return !Number.isFinite(m)?'':m<1?'เมื่อสักครู่':m<60?`${Math.round(m)} นาทีที่แล้ว`:m<2880?`${Math.round(m/60)} ชม.ที่แล้ว`:`${Math.round(m/1440)} วันที่แล้ว`;}
// Fetch a static file; *.gz bodies are inflated here unless the server already decoded them.
async function fetchBytes(url,opts={}){
 const r=await fetch(url,opts);if(!r.ok)throw Error(`${r.status} ${url}`);const buf=new Uint8Array(await r.arrayBuffer());
 if(buf[0]===0x1f&&buf[1]===0x8b)return new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
 return buf;
}
async function fetchJson(url,opts){return JSON.parse(new TextDecoder().decode(await fetchBytes(url,opts)));}
let map=null,tileLayer=null,provinceLayer=null,domainsInfo=null;
const TILE_URL='https://tile.openstreetmap.org/{z}/{x}/{y}.png',TILE_ATTRIBUTION='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Filter state: checkbox/select values survive reloads for this viewer only.
const FILTER_KEY='thara-filters-v2';
function loadFilters(){let saved={};try{saved=JSON.parse(localStorage.getItem(FILTER_KEY)||'{}');}catch{}for(const el of document.querySelectorAll('#filters input[id^="f-"],#filters select[id^="f-"]')){if(!(el.id in saved)||el.id==='f-time')continue;if(el.type==='checkbox')el.checked=!!saved[el.id];else if([...(el.options||[])].some(o=>o.value===saved[el.id]))el.value=saved[el.id];}}
function saveFilters(){const out={};for(const el of document.querySelectorAll('#filters input[id^="f-"],#filters select[id^="f-"]'))if(el.id!=='f-time')out[el.id]=el.type==='checkbox'?el.checked:el.value;try{localStorage.setItem(FILTER_KEY,JSON.stringify(out));}catch{}}
const filterHandlers=[];
function onFilter(ids,fn){filterHandlers.push([new Set(ids),fn]);}
document.addEventListener('change',e=>{if(!e.target.closest?.('#filters'))return;saveFilters();for(const [ids,fn] of filterHandlers)if(ids.has(e.target.id))fn();});
loadFilters();

if(typeof L!=='undefined'){
 map=L.map('map',{zoomControl:false}).setView([13.9,100.6],8);L.control.zoom({position:'topright'}).addTo(map);L.control.scale({position:'bottomright',imperial:false}).addTo(map);
 tileLayer=L.tileLayer(TILE_URL,{maxZoom:19,attribution:TILE_ATTRIBUTION}).addTo(map);
 // Stacking: overlays and lines are click-through; evidence markers sit on top so their popups work.
 for(const [name,z] of [['rainSurface',300],['waterAreas',310],['waterLines',320],['roadsBase',330],['flood',360],['mentions',380],['evidence',450]]){const p=map.createPane(name);p.style.zIndex=z;if(name!=='evidence')p.style.pointerEvents='none';}
 const panel=$('filters');L.DomEvent.disableClickPropagation(panel);L.DomEvent.disableScrollPropagation(panel);
 fetchJson('/data/provinces.geojson').then(g=>{provinceLayer=L.geoJSON(g,{pane:'mentions',interactive:false,style:{color:'#495057',weight:1.4,dashArray:'6 6',fill:false}});
  const sel=$('go-province');for(const f of g.features.sort((a,b)=>a.properties.name.localeCompare(b.properties.name,'th'))){const o=document.createElement('option');o.value=f.properties.name;o.textContent=f.properties.name;sel.append(o);}
  sel.onchange=()=>{const f=g.features.find(x=>x.properties.name===sel.value);if(f)map.fitBounds(L.geoJSON(f).getBounds());sel.value='';};showBoundary();}).catch(()=>{});
 fetchJson('/data/domains.json').then(d=>{domainsInfo=d;document.dispatchEvent(new CustomEvent('domains',{detail:d}));}).catch(()=>{});
}else $('map').textContent='โหลดแผนที่ไม่ได้ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วรีเฟรช';
function showBoundary(){if(!map||!provinceLayer)return;$('f-boundary').checked?provinceLayer.addTo(map):map.removeLayer(provinceLayer);}
onFilter(['f-boundary'],showBoundary);

// Panel open/closed; closed by default on small screens.
const wide=()=>window.matchMedia('(min-width: 760px)').matches;
function setPanel(open){$('filters').classList.toggle('closed',!open);$('filter-toggle').setAttribute('aria-expanded',String(open));}
setPanel(wide());
$('filter-toggle').onclick=()=>setPanel($('filters').classList.contains('closed'));$('filter-close').onclick=()=>setPanel(false);
$('go-region').onclick=()=>map?.setView([13.9,100.6],8);

let meMarker=null;
$('go-me').onclick=()=>{if(!navigator.geolocation||!map)return;$('go-me').disabled=true;navigator.geolocation.getCurrentPosition(p=>{$('go-me').disabled=false;const ll=[p.coords.latitude,p.coords.longitude];meMarker?.remove();meMarker=L.circleMarker(ll,{pane:'evidence',radius:8,color:'#fff',weight:3,fillColor:'#1971c2',fillOpacity:1}).bindTooltip('ตำแหน่งของคุณ (ไม่ได้ส่งไปที่ใด)').addTo(map);map.setView(ll,15);},()=>{$('go-me').disabled=false;alert('ไม่สามารถระบุตำแหน่งได้ กรุณาอนุญาตการเข้าถึงตำแหน่ง');},{enableHighAccuracy:true,timeout:10000});};

// Place search over the OSM admin gazetteer (provinces, districts, subdistricts).
const placeIndex=new Map();
fetchJson('/data/places.json').then(rows=>{const list=$('place-list');const frag=document.createDocumentFragment();const lvl={4:'จังหวัด',6:'อำเภอ/เขต',8:'ตำบล/แขวง'};
 for(const [name,level,province,lat,lng] of rows){const label=level===4?`${name} (จังหวัด)`:`${name} • ${province} (${lvl[level]})`;if(placeIndex.has(label))continue;placeIndex.set(label,[lat,lng,level]);const o=document.createElement('option');o.value=label;frag.append(o);}list.append(frag);}).catch(()=>{});
$('place-search').addEventListener('change',e=>{const v=e.target.value.trim(),hit=placeIndex.get(v)||[...placeIndex].find(([k])=>k.startsWith(v))?.[1];if(hit&&map){map.setView([hit[0],hit[1]],hit[2]===4?10:hit[2]===6?13:14);if(!wide())setPanel(false);}});

// ThaiWater water-level stations (metres above mean sea level; never converted to street depth).
const gaugeLayer=typeof L!=='undefined'?L.layerGroup():null;let gaugesLoaded=false;
async function paintGauges(){
 if(!map)return;if(!$('f-gauges').checked){map.removeLayer(gaugeLayer);return;}gaugeLayer.addTo(map);if(gaugesLoaded)return;
 try{const d=await fetchJson('/live/waterlevels.json',{cache:'no-cache'});gaugesLoaded=true;$('c-gauges').textContent=d.stations.length.toLocaleString('th-TH');
  for(const s of d.stations)L.circleMarker([s.lat,s.lng],{pane:'evidence',radius:4.5,color:'#fff',weight:1,fillColor:'#1971c2',fillOpacity:.9}).bindPopup(()=>`<b>${esc(s.name)}</b><br>ระดับน้ำ ${esc(s.levelMsl.toFixed(2))} ม.รทก. (เทียบระดับทะเล ไม่ใช่ความลึก)<br><small>${esc(s.agency)} • ${esc(thaiTime(s.observedAt))} (${esc(ago(s.observedAt))})</small>`).addTo(gaugeLayer);}
 catch{$('c-gauges').textContent='!';}
}
onFilter(['f-gauges'],paintGauges);paintGauges();
