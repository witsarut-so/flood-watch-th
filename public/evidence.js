// Evidence on the map plus the situation panel. Colours avoid the basemap's blue (water), orange (roads)
// and purple (modelled flooding). Mentioned roads/sois/villages are drawn in hot pink.
const evidenceKinds={bmaroad:'#a51111',bmareport:'#e03131',citizen:'#e03131',social:'#1c1c1c',road:'#212529',rain:'#2b8a3e',dam:'#6f4e37',news:'#d6336c',flow:'#364fc7',canal:'#5c7cfa',gate:'#495057'};
const kindLabel={bmaroad:'จุดวัด กทม.',bmareport:'รายงานเขต กทม.',citizen:'รายงานประชาชน',social:'โซเชียล',road:'เซนเซอร์ถนน',rain:'ฝน 24 ชม.',dam:'เขื่อน',news:'ข่าว',flow:'อัตราการไหล',canal:'ระดับน้ำคลอง',gate:'ประตูระบายน้ำ'};
const MENTION='#ff006e';
const evidenceLayers=typeof L!=='undefined'?Object.fromEntries([...Object.keys(evidenceKinds),'mentions'].map(k=>[k,L.layerGroup()])):{};
const evidenceRenderer=typeof L!=='undefined'?L.canvas({padding:.3,pane:'evidence'}):null,mentionRenderer=typeof L!=='undefined'?L.canvas({padding:.3,pane:'mentions'}):null;
let evidenceData=null,evidenceTimer=null;
const safeUrl=u=>/^https?:\/\//.test(u||'')?esc(u):'#';
const kindOf=i=>i.subkind==='bma-road'?'bmaroad':i.subkind==='bma-report'?'bmareport':i.kind==='citizen'?'citizen':i.kind==='social'?'social':i.kind==='news'?'news':i.subkind==='rain'?'rain':i.subkind==='dam'?'dam':i.subkind==='flow'?'flow':i.subkind==='canal'?'canal':i.subkind==='gate'?'gate':'road';
const precisionText={point:'พิกัดจุด',subdistrict:'ระดับตำบล/แขวง',district:'ระดับอำเภอ/เขต',province:'ระดับจังหวัด'};
const geoKind={road:'ถนน/ซอย',soi:'ซอย',village:'หมู่บ้าน',canal:'คลอง',river:'แม่น้ำ',bridge:'สะพาน',junction:'แยก',place:'ชุมชน/ย่าน',water:'แหล่งน้ำ'};

// Official BMA layers: severity colours (sensor roads R/r/a, district reports H/M/L), solid vs dashed.
const BMA_COLOR={R:'#a51111',r:'#e03131',a:'#ff8787',H:'#a51111',M:'#e03131',L:'#ff8787'};
function bmaPopup(i){
 const sensors=(i.sensors||[]).map(s=>`<li>${esc(s.code)} ${esc(s.where)}: ${esc(s.cm)} ซม. (สูงสุดรอบนี้ ${esc(s.maxCm)} ซม.)</li>`).join('');
 return `<b>${esc(i.title)}</b><br><small>${esc(i.source)} • อัปเดต ${esc(thaiTime(i.at))} (${esc(ago(i.at))})${i.via?` • ดึงผ่าน${esc(i.via)}`:''}${i.stale?` • ข้อมูลรอบก่อน (ดึงล่าสุด ${esc(thaiTime(i.fetchedAt))})`:''}</small>${i.detail?`<br>ช่วง: ${esc(i.detail)}`:''}${i.depthText?`<br>ความลึกตามรายงาน: ${esc(i.depthText)}`:''}${i.closedM?`<br>Google แสดงรถติด/ปิดถนนต่อเนื่อง ~${esc(i.closedM)} ม.`:''}${sensors?`<ul class="popup-list">${sensors}</ul>`:''}${i.dryNow?.length?`<br><small>ตัดช่วงใกล้เซนเซอร์ที่วัดได้ 0 ซม. หลังเวลารายงาน: ${esc(i.dryNow.map(s=>s.title.replace('เซนเซอร์น้ำท่วมถนน ','')+' ('+thaiTime(s.at)+')').join(', '))}</small>`:''}${i.approximate?`<br><small>ตำแหน่งโดยประมาณ: ${i.placedBy==='district-centre'?'รายงานไม่ระบุตำแหน่ง จึงวางไว้กลางเขต':i.placedBy==='osm-name'?'จับคู่ชื่อถนนกับ OSM':'รายงานไม่ระบุช่วง จึงแสดงถนนเส้นนี้เฉพาะในเขตที่รายงาน ไม่ได้แปลว่าท่วมตลอดเส้น'}</small>`:i.clipped==='soi'?'<br><small>แสดงเฉพาะช่วงถนนใกล้ปากซอยที่รายงานระบุ</small>':''}<br><a href="${safeUrl(i.sourceUrl)}" target="_blank" rel="noreferrer">เปิดหน้าเตือนภัย กทม. ↗</a>`;
}
function popup(i){
 const depth=i.depthCm!=null&&i.kind!=='sensor'?`<br>ความลึกที่ระบุ: ${esc(i.depthCm)} ซม.${i.depthEstimated?' (ประมาณจากคำบรรยาย)':''}`:i.kind==='sensor'&&!i.subkind?`<br>ค่าที่วัดได้: ${esc(i.depthCm)} ซม.`:'';
 const places=i.places?.length?`<br>พื้นที่: ${esc(i.places.slice(0,6).map(p=>p.short).join(', '))} (${esc(precisionText[i.precision]||'')})`:'';
 const geo=i.geo?.length?`<br>สถานที่ที่ระบุ: ${esc(i.geo.map(g=>`${g.name}${g.ambiguous?' (ไม่ระบุพื้นที่)':''}`).join(', '))}`:'';
 const facts=i.facts?.length?`<br>ตัวเลข: ${esc(i.facts.join(' • '))}`:'';
 const photo=i.photo?`<br><img src="${safeUrl(i.photo)}" alt="ภาพประกอบ" loading="lazy" referrerpolicy="no-referrer" class="popup-photo">`:'';
 const link=i.kind==='news'||i.kind==='social'?`<br><a href="${safeUrl(i.sourceUrl)}" target="_blank" rel="noreferrer">เปิดต้นฉบับ ↗</a>`:'';
 return `<b>${esc(i.title)}</b><br><small>${esc(i.source)}${i.via?' ผ่าน '+esc(i.via):''} • ${esc(thaiTime(i.at))} (${esc(ago(i.at))})${i.stale?' • ข้อมูลรอบก่อน':''}</small>${i.address?`<br><small>${esc(i.address)}</small>`:''}${depth}${places}${geo}${facts}${i.status?`<br>สถานะเรื่อง: ${esc(i.status)}`:''}${photo}${link}`;
}
function visible(i,k){
 if(k==='citizen')return Date.now()-Date.parse(i.at)<=Number($('f-citizen-hours').value)*3600000;
 if(k==='road')return !$('f-road-wet').checked||i.depthCm>0;
 return true;
}
const icon=(k,label)=>L.divIcon({className:'ev-icon ev-'+k,html:label,iconSize:null});
function paintEvidence(){
 if(!map||!evidenceData)return;
 const counts={};
 for(const [k,layer] of Object.entries(evidenceLayers)){layer.clearLayers();const on=$('f-'+k)?.checked;if(on)layer.addTo(map);else map.removeLayer(layer);}
 for(const i of evidenceData.items){
  const k=kindOf(i);if(!visible(i,k)||(k==='bmareport'&&i.expired))continue;counts[k]=(counts[k]||0)+1;
  // mentioned places: drawn lines/points for every visible item that resolved one
  if($('f-mentions').checked&&$('f-'+k)?.checked)for(const g of i.geo||[]){if(!g.drawn)continue;
   if(g.lines.length){L.polyline(g.lines,{renderer:mentionRenderer,color:'#fff',weight:8,opacity:.8,interactive:false}).addTo(evidenceLayers.mentions);L.polyline(g.lines,{renderer:mentionRenderer,color:MENTION,weight:4,opacity:.95,interactive:false}).addTo(evidenceLayers.mentions);}
   L.circleMarker(g.lines[0]?.[Math.floor(g.lines[0].length/2)]||[g.lat,g.lng],{renderer:evidenceRenderer,pane:'evidence',radius:5,color:'#fff',weight:2,fillColor:MENTION,fillOpacity:1}).bindPopup(()=>`<b>${esc(g.name)}</b> <small>(${esc(geoKind[g.kind]||g.kind)}${g.province?' • '+esc(g.province):''}${g.clipped?' • แสดงเฉพาะช่วงใกล้พื้นที่ที่ระบุ':''})</small><hr>${popup(i)}`,{maxWidth:320}).addTo(evidenceLayers.mentions);}
  if(!$('f-'+k)?.checked)continue;
  const style={renderer:evidenceRenderer,pane:'evidence',color:'#fff',weight:1.2,fillColor:evidenceKinds[k],fillOpacity:.9};
  if(k==='news'||(k==='social'&&!i.precision)){for(const p of (i.places||[]).filter(p=>p.precision!=='province').slice(0,5))(k==='social'?L.marker([p.lat,p.lng],{pane:'evidence',icon:icon('social','💬')}):L.circleMarker([p.lat,p.lng],{...style,radius:p.precision==='province'?7:5.5,fillOpacity:.6})).bindPopup(()=>popup(i),{maxWidth:300}).addTo(evidenceLayers[k]);continue;}
  if(k==='bmaroad'||k==='bmareport'){const col=BMA_COLOR[i.level]||'#e03131',dash=k==='bmareport'?'7 5':null,layer=evidenceLayers[k];
   // district-level approximations (report named a road but no segment) are faint and off by default
   const approx=k==='bmareport'&&i.approximate;
   if(!approx||$('f-bmaapprox').checked)for(const l of i.lines||[])if(l.length>1){
    if(approx){L.polyline(l,{renderer:evidenceRenderer,color:col,weight:3,opacity:.45,dashArray:'2 7',lineCap:'round'}).bindPopup(()=>bmaPopup(i),{maxWidth:320}).addTo(layer);continue;}
    L.polyline(l,{renderer:evidenceRenderer,color:'#fff',weight:9,opacity:.85,interactive:false}).addTo(layer);L.polyline(l,{renderer:evidenceRenderer,color:col,weight:5,opacity:.95,dashArray:dash,lineCap:'round'}).bindPopup(()=>bmaPopup(i),{maxWidth:320}).addTo(layer);}
   if(Number.isFinite(i.lat))L.circleMarker([i.lat,i.lng],{renderer:evidenceRenderer,pane:'evidence',radius:k==='bmaroad'?6:5,color:'#fff',weight:2,fillColor:col,fillOpacity:1,dashArray:null}).bindPopup(()=>bmaPopup(i),{maxWidth:320}).addTo(layer);
   continue;}
  if(!Number.isFinite(i.lat)||(k==='social'&&i.precision==='province'))continue;
  let layer;
  if(k==='social')layer=L.marker([i.lat,i.lng],{pane:'evidence',icon:icon('social','💬')});
  else if(k==='flow')layer=map.getZoom()>=11?L.marker([i.lat,i.lng],{pane:'evidence',icon:icon('flow',`⇢ ${esc(i.flowM3s.toFixed(1))}`)}):L.circleMarker([i.lat,i.lng],{...style,radius:4});
  else if(k==='gate')layer=L.marker([i.lat,i.lng],{pane:'evidence',icon:icon('gate','▦')});
  else{const radius=k==='rain'?Math.min(9,3+i.rain24hMm/30):k==='road'?(i.depthCm>0?4.5+Math.min(6,i.depthCm/8):3.5):k==='dam'?7:k==='canal'?4:5.5;
   layer=L.circleMarker([i.lat,i.lng],{...style,radius,fillColor:k==='road'&&!(i.depthCm>0)?'#adb5bd':k==='dam'&&i.storagePercent>=80?'#a61e4d':evidenceKinds[k]});}
  layer.bindPopup(()=>popup(i),{maxWidth:300}).addTo(evidenceLayers[k]);
 }
 for(const k of Object.keys(evidenceKinds)){const el=$('c-'+k);if(el)el.textContent=(counts[k]||0).toLocaleString('th-TH');}
 const m=evidenceData.items.reduce((n,i)=>n+(i.geo||[]).filter(g=>g.drawn).length,0);$('c-mentions').textContent=m.toLocaleString('th-TH');
}

// Hourly rain intensity surface: inverse-distance weighting of station rain_1h on a coarse canvas over the
// current view; blank where the nearest station is > 25 km away. An estimate from gauges, not radar.
const RAIN_STOPS=[[1,[173,232,255]],[2.5,[97,197,255]],[5,[43,143,242]],[10,[46,196,125]],[20,[250,215,55]],[35,[247,127,30]],[50,[224,49,49]],[80,[174,62,201]]];
let rainOverlay=null,rainGrid=null;
function rainColor(v){if(v<RAIN_STOPS[0][0])return null;let c=RAIN_STOPS[0][1];for(const [t,rgb] of RAIN_STOPS)if(v>=t)c=rgb;return c;}
function paintRain(){
 rainOverlay?.remove();rainOverlay=null;if(!map||!$('f-rainrate').checked||!evidenceData?.rainRate)return;
 const st=evidenceData.rainRate.stations;if(!rainGrid){rainGrid=new Map();for(const s of st){const k=`${Math.floor(s[0]/.25)}_${Math.floor(s[1]/.25)}`;if(!rainGrid.has(k))rainGrid.set(k,[]);rainGrid.get(k).push(s);}}
 const b=map.getBounds(),size=map.getSize(),W=Math.max(40,Math.round(size.x/6)),H=Math.max(40,Math.round(size.y/6));
 const cv=document.createElement('canvas');cv.width=W;cv.height=H;const ctx=cv.getContext('2d'),img=ctx.createImageData(W,H),px=img.data;
 const s0=b.getSouth(),n0=b.getNorth(),w0=b.getWest(),e0=b.getEast();
 for(let y=0;y<H;y++){const lat=n0-(y+.5)*(n0-s0)/H,kl=Math.cos(lat*Math.PI/180);for(let x=0;x<W;x++){const lng=w0+(x+.5)*(e0-w0)/W;let sw=0,sv=0,near=1e9;
  const gi=Math.floor(lat/.25),gj=Math.floor(lng/.25);
  for(let a=-1;a<=1;a++)for(let c=-1;c<=1;c++){const cell=rainGrid.get(`${gi+a}_${gj+c}`);if(!cell)continue;for(const s of cell){const dk=Math.hypot((s[0]-lat)*111,(s[1]-lng)*111*kl);if(dk<near)near=dk;if(dk>25)continue;const w=1/Math.max(dk*dk,.25);sw+=w;sv+=w*s[2];}}
  if(near>25||!sw)continue;const col=rainColor(sv/sw);if(!col)continue;const o=(y*W+x)*4;px[o]=col[0];px[o+1]=col[1];px[o+2]=col[2];px[o+3]=130;}}
 ctx.putImageData(img,0,0);rainOverlay=L.imageOverlay(cv.toDataURL(),b,{pane:'rainSurface',opacity:map.getZoom()>=12?.45:.75,interactive:false}).addTo(map);
 $('c-rainrate').textContent=st.length.toLocaleString('th-TH');
}

function renderSituation(){
 const d=evidenceData;if(typeof renderSatelliteSummary==="function")renderSatelliteSummary(d);
 $('ev-status').textContent=`อัปเดต ${thaiTime(d.fetchedAt)} (${ago(d.fetchedAt)}) • ข่าว/โซเชียลย้อนหลัง ${d.windowHours.news} ชม. • รายงานประชาชน ${d.windowHours.citizen} ชม.`+(d.errors.length?` • บางแหล่งดึงไม่สำเร็จ: ${[...new Set(d.errors.map(e=>e.source.split(':')[0]))].join(', ')}`:'');
 const br=d.items.filter(i=>i.subkind==='bma-road'),rr=d.items.filter(i=>i.subkind==='bma-report'&&!i.expired),rx=d.items.filter(i=>i.subkind==='bma-report'&&i.expired).length;
 if(br.length||rr.length)$('ev-status').textContent+=` • กทม.: จุดวัดพบน้ำ ${br.length} ถนน, รายงานเขต ${rr.length} จุด (จุดวัด ${br[0]?thaiTime(br[0].at):'–'}${rr[0]?`, รายงานเขต ${thaiTime(rr[0].at)}`:''})${rx?` • ไม่แสดงรายงานเขตเก่าเกิน 12 ชม. ${rx} จุด`:''}`;else if(d.sources?.bmaAlert&&!d.sources.bmaAlert.ok)$('ev-status').textContent+=' • ดึงข้อมูลเตือนภัย กทม. ไม่สำเร็จ';
 $('live-status').innerHTML=`<i></i> อัปเดต ${esc(ago(d.fetchedAt))}`;$('footer-updated').textContent=`• ข้อมูลล่าสุด ${thaiTime(d.fetchedAt)}`;
 const tbody=$('ev-provinces');tbody.replaceChildren();
 for(const p of d.provinces.slice(0,20)){const tr=document.createElement('tr');
  for(const c of [p.province,p.counts.news,p.counts.social||0,p.counts.citizen,p.counts.rain,p.counts.sensor?`${p.counts.sensor}${p.maxDepthCm!=null?` (สูงสุด ${p.maxDepthCm} ซม.)`:''}`:'–',ago(p.latestAt)]){const td=document.createElement('td');td.textContent=c;tr.append(td);}
  tr.tabIndex=0;tr.onclick=tr.onkeydown=e=>{if(e.type==='keydown'&&e.key!=='Enter')return;map?.flyTo([p.lat,p.lng],9);$('map-section').scrollIntoView({behavior:'smooth'});};tbody.append(tr);}
 const list=$('ev-news-list');list.replaceChildren();
 for(const i of d.items.filter(i=>i.kind==='news'||(i.kind==='social'&&(i.places?.length||i.geo?.length))).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,60)){
  const li=document.createElement('li'),a=document.createElement('a'),meta=document.createElement('small'),tag=document.createElement('span');
  tag.className='ev-tag '+i.kind;tag.textContent=i.kind==='social'?'โซเชียล':'ข่าว';
  a.href=/^https?:\/\//.test(i.sourceUrl)?i.sourceUrl:'#';a.target='_blank';a.rel='noreferrer';a.textContent=i.title;
  const bits=[i.source+(i.alsoIn?.length?` (+${i.alsoIn.length} สื่อ)`:''),ago(i.at)];
  const named=(i.geo||[]).filter(g=>!g.ambiguous).map(g=>g.name);
  if(named.length)bits.push('🛣 '+named.slice(0,4).join(', '));else if(i.places.length)bits.push('📍 '+i.places.slice(0,4).map(p=>p.short).join(', '));
  if(i.depthCm)bits.push(`น้ำ ${i.depthCm} ซม.${i.depthEstimated?' (ประมาณ)':''}`);
  if(i.facts?.length)bits.push(i.facts.slice(0,3).join(' • '));
  meta.textContent=bits.join(' • ');li.append(tag,a,meta);
  const g=(i.geo||[]).find(x=>x.drawn),p=i.places?.[0];
  if(g||p){li.classList.add('locatable');li.onclick=e=>{if(e.target.tagName==='A')return;if(g?.lines?.length)map?.fitBounds(L.polyline(g.lines).getBounds().pad(.3));else if(g)map?.setView([g.lat,g.lng],15);else map?.flyTo([p.lat,p.lng],p.precision==='province'?9:12);$('map-section').scrollIntoView({behavior:'smooth'});};}
  list.append(li);}
}
// Data saver: the lite file (Traffy last 6 h, trimmed fields) loads first; the full file only for longer windows.
const needFull=()=>Number($('f-citizen-hours').value)>(evidenceData?.lite?.citizenHours||6);
async function loadEvidence(){
 try{const want=needFull()?'/live/evidence.json':'/live/evidence-lite.json';
  evidenceData=await fetchJson(want,{cache:'no-cache'}).catch(()=>fetchJson('/live/evidence.json',{cache:'no-cache'}));rainGrid=null;renderSituation();paintEvidence();paintRain();}
 catch(err){$('ev-status').textContent='โหลดข้อมูลไม่สำเร็จ • จะลองใหม่อัตโนมัติ';}
 evidenceTimer=setTimeout(loadEvidence,document.hidden?600000:300000);
}
onFilter(['f-citizen-hours'],()=>{if(evidenceData?.lite&&needFull()){clearTimeout(evidenceTimer);$('ev-status').textContent='กำลังโหลดรายงานประชาชนช่วงที่เลือก…';loadEvidence();}});
onFilter(['f-bmaroad','f-bmareport','f-bmaapprox','f-citizen','f-social','f-road','f-rain','f-dam','f-news','f-flow','f-canal','f-gate','f-mentions','f-citizen-hours','f-road-wet'],paintEvidence);
onFilter(['f-rainrate'],paintRain);
if(map){let t,wasNear=map.getZoom()>=11;map.on('moveend',()=>{clearTimeout(t);t=setTimeout(paintRain,200);});map.on('zoomend',()=>{const near=map.getZoom()>=11;if(near!==wasNear){wasNear=near;paintEvidence();}});}
loadEvidence();
