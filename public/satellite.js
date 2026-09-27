// Satellite-detected flood areas (GISTDA) from /live/satellite.json: one polygon per flooded part of an H3 cell.
// Loaded only while the layer is on (~0.7 MB). Summary table in the situation section comes from evidence.json.
let satData=null,satLoading=null,satHits=[];
const satGroup=typeof L!=='undefined'?L.layerGroup():null,satRenderer=typeof L!=='undefined'?L.canvas({padding:.3,pane:'satellite'}):null;
const SAT_STYLE={renderer:satRenderer,pane:'satellite',interactive:false,stroke:false,fillColor:'#1c7ed6',fillOpacity:.5};  // fill only: outlines turn into speckle at regional zoom
const rai=m2=>(m2/1600).toLocaleString('th-TH',{maximumFractionDigits:0});
const passText=p=>p?.at?`${thaiTime(p.at)}${p.sensor?` (${p.sensor.toUpperCase()})`:''}`:'–';

function decodeRing(r){const out=[];let y=0,x=0;for(let i=0;i<r.length;i+=2){y+=r[i];x+=r[i+1];out.push([y/1e5,x/1e5]);}return out;}
function satPopup(s,f){
 const [pi,ai,m2,road,bld,pop]=f,[tb,ap,pv]=s.admins[ai].split('|');
 return `<b>น้ำท่วมจากภาพดาวเทียม</b><br><small>${esc(s.source)} • ถ่ายภาพ ${esc(passText(s.passes[pi]))}</small><br>ต.${esc(tb)} อ.${esc(ap)} จ.${esc(pv)}<br>พื้นที่น้ำในช่องนี้ ~${rai(m2)} ไร่${road?` • ถนน ${road.toLocaleString('th-TH')} ม.`:''}${bld?` • อาคาร ${bld}`:''}${pop?` • ประชากรในช่อง ~${pop.toLocaleString('th-TH')} คน`:''}<br><small>เรดาร์เห็นผิวน้ำเปิดโล่ง อาจไม่เห็นน้ำตื้นบนถนนในเมือง • ไม่ใช่เวลาปัจจุบัน</small>`;}

async function loadSatellite(){
 if(satData)return satData;
 satLoading??=fetchJson('/live/satellite.json').then(d=>(satData=d)).finally(()=>{satLoading=null;});
 return satLoading;}

async function paintSatellite(){
 if(!map||!satGroup)return;
 if(!$('f-sat')?.checked){map.removeLayer(satGroup);return;}
 let s;try{s=await loadSatellite();}catch{$('sat-note').textContent='ยังไม่มีข้อมูลดาวเทียม';return;}
 if(!satGroup.getLayers().length){satHits=[];for(const f of s.features){const ring=decodeRing(f[6]),poly=L.polygon(ring,SAT_STYLE).addTo(satGroup);satHits.push([poly.getBounds(),ring,f]);}}
 satGroup.addTo(map);}

// Situation section: flooded area per district from the latest passes (evidence.json .satellite)
function renderSatelliteSummary(d){
 const box=$('sat-summary'),note=$('sat-note'),s=d?.satellite;if(!box)return;
 if(!s?.summary?.length){box.innerHTML='';if(note)note.textContent=s?.error?'ยังดึงข้อมูลดาวเทียมไม่ได้':'ยังไม่มีข้อมูลดาวเทียม';return;}
 const passes=s.passes.map(passText).join(', ');
 if(note)note.textContent=`ภาพถ่าย ${passes} • ${s.features.toLocaleString('th-TH')} พื้นที่`;
 const rows=s.summary.slice(0,12).map(x=>`<tr><td>${esc(x.district)}</td><td>${esc(x.province)}</td><td>${x.floodKm2.toLocaleString('th-TH',{maximumFractionDigits:1})}</td><td>${x.roadKm.toLocaleString('th-TH')}</td><td>${x.population.toLocaleString('th-TH')}</td></tr>`).join('');
 box.innerHTML=`<h3>พื้นที่น้ำท่วมจากภาพดาวเทียม <small>(GISTDA • ${esc(passes)})</small></h3><div class="table-scroll"><table class="ev-table"><thead><tr><th>อำเภอ/เขต</th><th>จังหวัด</th><th>ตร.กม.</th><th>ถนน (กม.)</th><th>ประชากรในพื้นที่</th></tr></thead><tbody>${rows}</tbody></table></div><p class="note">ครอบคลุมทุกจังหวัดในกรอบแผนที่ ไม่ใช่เฉพาะ กทม. • ข้อมูลรายรอบที่ดาวเทียมผ่าน (ไม่ใช่เวลาปัจจุบัน) และมองไม่เห็นน้ำตื้นบนถนนในเมือง • ที่มา: <a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener">สทอภ. (GISTDA)</a></p>`;}

// The evidence canvas on top takes the clicks, so polygons are hit-tested here (bbox, then point in ring).
function inRing(ll,ring){let c=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [yi,xi]=ring[i],[yj,xj]=ring[j];if((yi>ll.lat)!==(yj>ll.lat)&&ll.lng<(xj-xi)*(ll.lat-yi)/(yj-yi)+xi)c=!c;}return c;}
function satClick(e){
 if(!satData||!$('f-sat')?.checked||!map.hasLayer(satGroup))return;
 const hit=satHits.find(([b,ring])=>b.contains(e.latlng)&&inRing(e.latlng,ring));if(!hit)return;
 // a marker/line popup opened by the same click wins (vector clicks also bubble to the map)
 setTimeout(()=>{if(Date.now()-lastPopupAt<300)return;L.popup({maxWidth:300}).setLatLng(e.latlng).setContent(satPopup(satData,hit[2])).openOn(map);},0);}
let lastPopupAt=0;
if(map){const p=map.createPane('satellite');p.style.zIndex=340;p.style.pointerEvents='none';map.on('click',satClick);map.on('popupopen',()=>{lastPopupAt=Date.now();});onFilter(['f-sat'],paintSatellite);paintSatellite();}
