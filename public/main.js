// One map, one time selector (now / +12 / +24 / +36 h). Forecast: modelled flood area (forward 2D model), river and
// canal stations by % of bank, and risk spots with their causes. Options: canal levels (BMA + municipal gauges), dam
// releases, Traffy Fondue reports, rain (gauges now, forecast for the window) with the weather outlook.
// Data: /live/forecast.json (forecast.mjs), /live/model/latest.json (model/run.py), /live/now.json (jobs.mjs).
let horizon=24,MODEL=null,NOW=null;const layers={};
const num=v=>v==null?'–':Number(v).toLocaleString('th-TH',{maximumFractionDigits:1});
const {f2,sign,pctColor,CANAL}=FL;
const HZ=[12,24,36],windowOf=h=>h||12;  // "now" shows the next 12 h of rain
const provinceShort=p=>(p||'').replace('กรุงเทพมหานคร','กรุงเทพฯ').replace('พระนครศรีอยุธยา','อยุธยา');
const districtShort=d=>(d||'').replace(/^(เขต|อำเภอ|อ\.)\s*/,'');

// --- modelled flood area (central domain forward run; other domains: latest hindcast hour, "now" only) ---------------
const bytesCache=new Map();
const bytes=url=>{if(!bytesCache.has(url))bytesCache.set(url,fetchBytes(url));if(bytesCache.size>40)bytesCache.delete(bytesCache.keys().next().value);return bytesCache.get(url);};
const BINS=[[2,[229,153,247]],[10,[204,93,232]],[30,[156,54,181]],[50,[95,15,122]]];
function fwd(){const d=MODEL?.domains?.find(x=>x.scenarios?.some(s=>s?.forecast));return d?{d,f:d.scenarios.find(s=>s?.forecast).forecast}:null;}
function frameAt(x,h){const fr=x.f[$('f-variant').value]?.frames||x.f.base.frames;return fr.find(f=>f.hoursAhead===h)||fr.at(-1);}
let floodTok=0;
async function paintFlood(){
 const tok=++floodTok;layers.flood?.forEach(l=>l.remove());layers.flood=[];
 if(!$('f-flood').checked||!MODEL||!domainsInfo)return;
 const x=fwd(),out=[],paint=async(id,file,ref,hold)=>{const info=domainsInfo.domains.find(d=>d.id===id);if(!info)return;
  const [ib,dep,dep0,hd]=await Promise.all([bytes(`/data/overview/${id}.bin.gz`),bytes(MODEL.base+file),ref?bytes(MODEL.base+ref):null,hold?bytes(MODEL.base+hold):null]);
  const idx=new Uint32Array(ib.buffer,ib.byteOffset,ib.byteLength/4),{width:W,height:H,bounds:[w,s,e,n]}=info.overview;
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;const ctx=cv.getContext('2d'),img=ctx.createImageData(W,H),px=img.data;
  for(let p=0;p<idx.length;p++){const c=idx[p];if(c===0xFFFFFFFF)continue;const v=dep[c];if(v<2)continue;const o=p*4;
   if(hd&&hd[c]<2){px[o]=224;px[o+1]=0;px[o+2]=40;px[o+3]=240;continue;}      // wet only because of the added dam release
   if(dep0&&dep0[c]<2){px[o]=255;px[o+1]=140;px[o+2]=0;px[o+3]=225;continue;}  // newly wet since now
   let col=BINS[0][1];for(const [t,rgb] of BINS)if(v>=t)col=rgb;px[o]=col[0];px[o+1]=col[1];px[o+2]=col[2];px[o+3]=200;}
  ctx.putImageData(img,0,0);out.push(L.imageOverlay(cv.toDataURL(),[[s,w],[n,e]],{pane:'flood',opacity:.85,interactive:false,className:'pixelated'}));};
 const jobs=[];
 if(x){const fr=frameAt(x,horizon),f0=x.f[$('f-variant').value]?.frames[0]||x.f.base.frames[0],hf=horizon?x.f.hold?.frames.find(f=>f.hoursAhead===fr.hoursAhead):null;jobs.push(paint(x.d.id,fr.file,horizon?f0.file:null,hf?.file));}
 if(!horizon){const k=Math.max(0,(MODEL.drainageScenariosMmH||[]).indexOf(3));for(const d of MODEL.domains)if(!d.skipped&&d!==x?.d&&d.times?.length)jobs.push(paint(d.id,`${d.id}-s${k}-f${d.times.length-1}.bin.gz`));}
 await Promise.allSettled(jobs);if(tok!==floodTok)return;layers.flood=out;out.forEach(l=>l.addTo(map));
}

// --- dam releases -------------------------------------------------------------------------------------------------
function planAt(p,t){return [...p.schedule].sort((a,b)=>Date.parse(a.from)-Date.parse(b.from)).filter(s=>Date.parse(s.from)<=t).at(-1)||p.schedule[0];}
function releaseLayer(d){
 const g=L.layerGroup(),t=Date.now()+horizon*3600000,plans=d.plans?.dams||[];let n=0;
 for(const x of d.dams||[]){if(x.lat<12.4||x.lat>17.5||x.lng<98.3||x.lng>102.8||x.releaseM3s==null)continue;
  if(x.releaseM3s<1&&!(x.storagePct>=90))continue;n++;  // idle dams with room to spare say nothing about flooding
  const plan=plans.find(p=>p.name.includes(x.name.replace('เขื่อน',''))),at=plan?planAt(plan,t):null,col=x.storagePct>=100?'#a51111':x.storagePct>=90?'#e03131':x.storagePct>=80?'#f76707':'#6f4e37';
  const q=at&&horizon?at.m3s:x.releaseM3s;
  L.marker([x.lat,x.lng],{pane:'evidence',icon:L.divIcon({className:'fc-dam',html:`<span style="--c:${col}">▼ ${num(q)} • ${Math.round(x.storagePct)}%</span>`,iconSize:null})})
   .bindPopup(`<b>${esc(x.name)}</b><br>ระบาย <b>${num(x.releaseM3s)}</b> ลบ.ม./วินาที • ไหลเข้า ${num(x.inflowM3s)} • เก็บกัก ${x.storagePct}%${x.spillM3s?` • ทางน้ำล้น ${num(x.spillM3s)}`:''}<br><small>ค่าเฉลี่ยวันที่ ${esc(x.date)} (กรมชลประทาน ผ่าน ThaiWater)</small>${plan?`<br><b>แผนระบาย:</b> ${plan.schedule.map(s=>`${esc(thaiTime(s.from))} ${num(s.m3s)}${s.auto?' (อัตโนมัติ)':''}`).join(' → ')} ลบ.ม./วิ${plan.outlook?`<br><small>${esc(plan.outlook)}</small>`:''}`:''}`,{maxWidth:330}).addTo(g);}
 // Chao Phraya Dam is a barrage, not in the storage-dam table: its release from the plan (kept current from news)
 const cp=plans.find(p=>p.id==='chaophraya');if(cp){const now=planAt(cp,Date.now()),at=planAt(cp,t);n++;
  L.marker([cp.lat,cp.lng],{pane:'evidence',icon:L.divIcon({className:'fc-dam',html:`<span style="--c:#1864ab">▼ ${num(at.m3s)} ลบ.ม./วิ</span>`,iconSize:null})})
   .bindPopup(`<b>${esc(cp.name)}</b><br>ระบาย <b>${num(now.m3s)}</b> ลบ.ม./วินาที ตั้งแต่ ${esc(thaiTime(now.from))}${at!==now?`<br>+${horizon} ชม.: <b>${num(at.m3s)}</b> (ตั้งแต่ ${esc(thaiTime(at.from))})`:''}${cp.high?`<br><small>${esc(cp.high.why)}</small>`:''}<br><small>${esc(now.source)}</small>${cp.outlook?`<br><small>${esc(cp.outlook)}</small>`:''}`,{maxWidth:330}).addTo(g);}
 $('c-release').textContent=n?n+' แห่ง':'';return g;
}

// --- canals: BMA gauges (forecast = trend) + municipal gauges (now) -----------------------------------------------
const LOCAL_COLOR={normal:'#2f9e44',watch:'#f5b400',warning:'#f76707',critical:'#e03131'},LOCAL_TEXT={normal:'ปกติ',watch:'เฝ้าระวัง',warning:'เสี่ยง',critical:'วิกฤต'};
function canalLayer(d){
 const g=FL.canalLayer({horizon});
 const near=map.getZoom()>=10;  // labels from zoom 10; dots below, where the labels would overlap
 for(const i of NOW?.gauges||[])(near?L.marker([i.lat,i.lng],{pane:'evidence',icon:L.divIcon({className:'ev-icon',html:`<span class="ev-local" style="--c:${LOCAL_COLOR[i.state]||'#868e96'}">▲ ${i.levelM!=null?f2(i.levelM)+' ม.':''} ${esc(LOCAL_TEXT[i.state]||'')}</span>`,iconSize:null})}):L.circleMarker([i.lat,i.lng],{pane:'evidence',radius:6,color:'#fff',weight:2,fillColor:LOCAL_COLOR[i.state]||'#868e96',fillOpacity:1}))
  .bindPopup(`<b>${esc(i.title)}</b><br><small>${esc(i.source)} • ${esc(thaiTime(i.at))} (${esc(ago(i.at))})${i.stale?' • ข้อมูลรอบก่อน':''}</small>${i.how?`<br>${esc(i.how)}`:''}${i.detail?`<br><small>${esc(i.detail)}</small>`:''}${horizon?'<br><small>ค่าปัจจุบัน (เทศบาลไม่มีคาดการณ์)</small>':''}<br><a href="${esc(i.sourceUrl)}" target="_blank" rel="noreferrer">เปิดต้นฉบับ ↗</a>`,{maxWidth:300}).addTo(g);
 const c=d.canals?.[horizon?'countsAhead':'counts'];const cc=horizon?c?.[horizon]:c;$('c-canal').textContent=cc?`${cc.critical} วิกฤต`:'';
 return g;
}

// --- Traffy Fondue ------------------------------------------------------------------------------------------------
function traffyLayer(){
 const g=L.layerGroup(),hrs=Number($('f-traffy-hours').value),list=(NOW?.traffy||[]).filter(i=>Date.now()-Date.parse(i.at)<=hrs*3600000);
 for(const i of list)L.circleMarker([i.lat,i.lng],{pane:'evidence',radius:5.5,color:'#fff',weight:1.2,fillColor:'#e03131',fillOpacity:.9})
  .bindPopup(()=>`<b>${esc(i.title)}</b><br><small>Traffy Fondue • ${esc(thaiTime(i.at))} (${esc(ago(i.at))})${i.via?' • ดึงผ่าน'+esc(i.via):''}</small>${i.address?`<br><small>${esc(i.address)}</small>`:''}${i.depthCm!=null?`<br>ความลึกที่ระบุ: ${esc(i.depthCm)} ซม.${i.depthEstimated?' (ประมาณ)':''}`:''}${i.status?`<br>สถานะเรื่อง: ${esc(i.status)}`:''}${i.photo?`<br><img src="${esc(i.photo)}" alt="ภาพประกอบ" loading="lazy" referrerpolicy="no-referrer" class="popup-photo">`:''}`,{maxWidth:300}).addTo(g);
 $('c-traffy').textContent=list.length.toLocaleString('th-TH');return g;
}

// --- rain: gauges now (IDW surface), forecast per place for the window ---------------------------------------------
const RAIN_STOPS=[[1,[173,232,255]],[2.5,[97,197,255]],[5,[43,143,242]],[10,[46,196,125]],[20,[250,215,55]],[35,[247,127,30]],[50,[224,49,49]],[80,[174,62,201]]];
const rainColor=v=>{if(v<RAIN_STOPS[0][0])return null;let c=RAIN_STOPS[0][1];for(const [t,rgb] of RAIN_STOPS)if(v>=t)c=rgb;return c;};
let rainGrid=null;
function rainSurface(){
 const st=NOW?.rainRate?.stations;if(!st)return null;
 if(!rainGrid){rainGrid=new Map();for(const s of st){const k=`${Math.floor(s[0]/.25)}_${Math.floor(s[1]/.25)}`;if(!rainGrid.has(k))rainGrid.set(k,[]);rainGrid.get(k).push(s);}}
 const b=map.getBounds(),size=map.getSize(),W=Math.max(40,Math.round(size.x/6)),H=Math.max(40,Math.round(size.y/6));
 const cv=document.createElement('canvas');cv.width=W;cv.height=H;const ctx=cv.getContext('2d'),img=ctx.createImageData(W,H),px=img.data,s0=b.getSouth(),n0=b.getNorth(),w0=b.getWest(),e0=b.getEast();
 for(let y=0;y<H;y++){const lat=n0-(y+.5)*(n0-s0)/H,kl=Math.cos(lat*Math.PI/180);for(let x=0;x<W;x++){const lng=w0+(x+.5)*(e0-w0)/W;let sw=0,sv=0,near=1e9;const gi=Math.floor(lat/.25),gj=Math.floor(lng/.25);
  for(let a=-1;a<=1;a++)for(let c=-1;c<=1;c++){const cell=rainGrid.get(`${gi+a}_${gj+c}`);if(!cell)continue;for(const s of cell){const dk=Math.hypot((s[0]-lat)*111,(s[1]-lng)*111*kl);if(dk<near)near=dk;if(dk>25)continue;const w=1/Math.max(dk*dk,.25);sw+=w;sv+=w*s[2];}}
  if(near>25||!sw)continue;const col=rainColor(sv/sw);if(!col)continue;const o=(y*W+x)*4;px[o]=col[0];px[o+1]=col[1];px[o+2]=col[2];px[o+3]=130;}}
 ctx.putImageData(img,0,0);return L.imageOverlay(cv.toDataURL(),b,{pane:'rainSurface',opacity:map.getZoom()>=12?.45:.75,interactive:false});
}
const rainCol=mm=>mm>=35?'#e03131':mm>=10?'#fab005':mm>=1?'#74c0fc':'#dee2e6';
function rainLayer(d){
 const g=L.layerGroup(),w=windowOf(horizon);
 if(!horizon){const s=rainSurface();if(s)s.addTo(g);const n=(NOW?.rainRate?.stations||[]).filter(s=>s[2]>0).length;$('c-rain').textContent=`ฝนตก ${n} สถานี`;}
 else{for(const r of d.rain||[]){const x=r.windows[w];if(!x||x.mm==null||x.mm<1)continue;  // under 1 mm: listed in the panel, not drawn
  L.circle([r.lat,r.lng],{pane:'mentions',radius:5000+Math.min(x.mm,80)*400,color:'#1c7ed6',weight:1,fillColor:rainCol(x.mm),fillOpacity:.32,interactive:false}).addTo(g);
  L.marker([r.lat,r.lng],{pane:'evidence',icon:L.divIcon({className:'fc-rain',html:`<span>☔ ${num(x.mm)}</span>`,iconSize:null})}).bindPopup(()=>weatherPopup(r,w,d),{maxWidth:300}).addTo(g);}
  const top=Math.max(0,...(d.rain||[]).map(r=>r.windows[w]?.mm||0));$('c-rain').textContent=`สูงสุด ${num(top)} มม.`;}
 return g;
}
function weatherPopup(r,w,d){const x=r.windows[w];
 return `<b>${esc(r.name)}</b><br>${esc(x.condition||'')} • ฝนสะสม <b>${num(x.mm)} มม.</b> ช่วง ${w-12}–${w} ชม. • โอกาสฝน ${x.probPct}%${x.thunderPct!=null?` • พายุฝนฟ้าคะนอง ${x.thunderPct}%`:''}
  ${x.nModels?`<br><small>แบบจำลองแต่ละตัว (มม.): ${Object.entries(x.models).map(([k,v])=>`${esc(k)} ${num(v)}`).join(' • ')} — ${x.wetModels}/${x.nModels} ตัวคาดว่าฝน ≥${d.rainSource?.wetMm??5} มม.</small>`:''}
  <br><small>แหล่ง: ${esc(d.rainSource?.primary==='Google Weather'?'Google Weather (ค่าหลัก) + Open-Meteo':'Open-Meteo เฉลี่ยหลายแบบจำลอง')}</small>`;}
function weatherPanel(d){
 const w=windowOf(horizon),src=d.rainSource,rows=[...(d.rain||[])].filter(r=>r.windows[w]).sort((a,b)=>(b.windows[w].mm||0)-(a.windows[w].mm||0)).slice(0,8);
 $('weather').innerHTML=!$('f-rain').checked?'':`<p class="w-head">พยากรณ์ ${w-12}–${w} ชม. ข้างหน้า • ${esc(src?.primary==='Google Weather'?'Google Weather':'เฉลี่ย '+(src?.models||[]).join(' / '))}</p>`
  +rows.map(r=>{const x=r.windows[w];return `<button class="w-row" data-lat="${r.lat}" data-lng="${r.lng}"><span class="w-mm" style="--c:${rainCol(x.mm)}">${num(x.mm)}</span><b>${esc(r.name)}</b><small>${esc(x.condition||'')} • ${x.probPct}%${x.nModels?` • ${x.wetModels}/${x.nModels} แบบจำลอง`:''}</small></button>`;}).join('')
  +`<p class="w-foot">มม. สะสมใน 12 ชม. • % = โอกาสฝน${src&&!src.googleConfigured?' • ยังไม่ได้ตั้งค่า Google Weather':''}</p>`;
 for(const b of $('weather').querySelectorAll('.w-row'))b.onclick=()=>{map.setView([+b.dataset.lat,+b.dataset.lng],11);if(!wide())setPanel(false);};
}

// --- risk spots: where water is expected, and why ------------------------------------------------------------------
// Grouped by district: river stations over bank (cause: dam/upstream water when routed or regressed on the dam chain,
// tide, or the recent trend), modelled new flooding (and the part due to the added dam release), canals at/over the
// BMA control level, heavy rain forecast. Rain also adds to a spot within RAIN_NEAR_KM.
const CAUSE={dam:['เขื่อน/น้ำเหนือ','#1864ab'],river:['แม่น้ำล้นตลิ่ง','#e03131'],tide:['น้ำทะเลหนุน','#0b7285'],canal:['คลองเต็ม','#f08c00'],rain:['ฝนหนัก','#2b8a3e'],model:['แบบจำลอง','#9c36b5']};
const RAIN_NEAR_KM=15,km=(a,b)=>Math.hypot((a[0]-b[0])*111,(a[1]-b[1])*111*Math.cos(a[0]*Math.PI/180));
function locate(name,province){const n=districtShort(name),p=provinceShort(province),rows=placeRows.filter(r=>r[1]===6&&r[0]===n);return (rows.find(r=>p.includes(r[2])||r[2].includes(p))||rows[0])?.slice(3,5)||null;}
function hotspots(d){
 const spots=new Map(),h=horizon,add=(key,name,province,ll,cause,text,score)=>{if(!ll)return;let s=spots.get(key);if(!s)spots.set(key,s={name,province,ll,causes:new Map(),lines:[],score:0});
  if(!s.causes.has(cause))s.causes.set(cause,0);s.causes.set(cause,s.causes.get(cause)+score);s.lines.push(text);s.score+=score;};
 const keyOf=(amphoe,prov)=>districtShort(amphoe)+'|'+provinceShort(prov);
 for(const s of d.stations){const v=h?s.forecast[h]:{pct:s.pctNow,level:s.levelNow};if(!(v?.pct>=100))continue;
  const rise=h?v.level-s.levelNow:0,dam=(s.method==='flow'||s.method==='regress')&&(s.dam||(s.up||[]).length),k=keyOf(s.amphoe,s.province),nm=`${esc(s.name)} ${v.pct}% ตลิ่ง${h&&Math.abs(rise)>=.01?` (${sign(rise)} ม.)`:''}${h&&s.pctNow<100?' • ตอนนี้ยังไม่ล้น':''}`;
  add(k,(s.province==='กรุงเทพมหานคร'?'เขต':'อ.')+s.amphoe,s.province,[s.lat,s.lng],/^(คลอง|ค\.)/.test(s.name)?'canal':'river',nm,1+(v.pct-100)/10+(h&&s.pctNow<100?1:0));
  if(dam)add(k,'','',[s.lat,s.lng],'dam',`ระดับน้ำตามน้ำจาก${s.dam?esc(s.dam):'ต้นน้ำ ('+(s.up||[]).join(', ')+')'}${s.lagH!=null?` ใช้เวลาเดินทาง ~${s.lagH} ชม.`:''}`,1);
  if(s.tidal)add(k,'','',[s.lat,s.lng],'tide','มีผลจากน้ำขึ้นน้ำลง',.5);}
 const x=fwd();if(x&&h){const fr=frameAt(x,h);for(const a of fr.areas||[]){if(!(a.newKm2>=1||a.damKm2>=.1))continue;const ll=locate(a.name,a.province),k=keyOf(a.name,a.province);
  add(k,a.kind+a.name,a.province,ll,'model',`แบบจำลอง: ท่วมเพิ่ม ${num(a.newKm2)} ตร.กม. (มีน้ำรวม ${num(a.km2)})`,Math.log10(1+a.newKm2));
  if(a.damKm2>=.1)add(k,'','',ll,'dam',`ในจำนวนนี้ ${num(a.damKm2)} ตร.กม. เพราะเขื่อนปล่อยน้ำเพิ่ม`,1+a.damKm2);}}
 for(const s of d.canals?.stations||[]){if(FL.canalState(s,h)!=='critical')continue;const v=h?s.forecast?.[h]:s,k=keyOf(s.district,'กรุงเทพฯ');
  add(k,'เขต'+districtShort(s.district),'กรุงเทพฯ',[s.lat,s.lng],'canal',`${esc(s.name)}${v?.overM!=null?` เกินระดับควบคุม ${f2(v.overM)} ม.`:''}${h?' (แนวโน้ม)':''} — ระบายน้ำได้ช้า`,.7);}
 const w=windowOf(h);
 for(const r of d.rain||[]){const x2=r.windows[w];if(!x2?.mm)continue;let near=null;for(const s of spots.values()){const dk=km(s.ll,[r.lat,r.lng]);if(dk<=RAIN_NEAR_KM&&(!near||dk<near[0]))near=[dk,s];}
  const txt=`ฝนคาด ${num(x2.mm)} มม. ช่วง ${w-12}–${w} ชม. (${esc(r.name)}${x2.nModels?`, ${x2.wetModels}/${x2.nModels} แบบจำลอง`:''})`;
  if(near&&x2.mm>=10){const s=near[1];s.causes.set('rain',(s.causes.get('rain')||0)+x2.mm/20);s.lines.push(txt);s.score+=x2.mm/20;}
  else if(x2.mm>=35)add('rain|'+r.name,r.name,'',[r.lat,r.lng],'rain',txt,x2.mm/20);}
 return [...spots.values()].sort((a,b)=>b.score-a.score);
}
function hotspotLayer(list){
 const g=L.layerGroup();
 const z=map.getZoom();for(const s of list.slice(0,z<9?12:z<11?25:60))L.marker(s.ll,{pane:'evidence',icon:L.divIcon({className:'hs-icon',html:`<span>⚠${[...s.causes.keys()].map(c=>`<i style="--c:${CAUSE[c][1]}"></i>`).join('')}</span>`,iconSize:null})})
  .bindPopup(()=>hotspotHtml(s),{maxWidth:330}).addTo(g);
 return g;
}
const hotspotHtml=s=>`<b>${esc(s.name)}</b> <small>${esc(s.province)}</small><div class="hs-causes">${[...s.causes.keys()].map(c=>`<span style="--c:${CAUSE[c][1]}">${CAUSE[c][0]}</span>`).join('')}</div><ul class="hs-lines">${s.lines.slice(0,6).map(t=>`<li>${t}</li>`).join('')}</ul>`;
let hotspotsOpen=false;
function hotspotPanel(list){
 $('c-hotspot').textContent=list.length?list.length+' จุด':'';const n=hotspotsOpen?25:6;
 $('hotspots').innerHTML=!$('f-hotspot').checked?'':list.length?list.slice(0,n).map((s,i)=>`<button class="hs-row" data-i="${i}"><b>${esc(s.name)}</b> <small>${esc(provinceShort(s.province))}</small><span class="hs-causes">${[...s.causes.keys()].map(c=>`<span style="--c:${CAUSE[c][1]}">${CAUSE[c][0]}</span>`).join('')}</span></button>`).join('')+(list.length>6?`<button class="hs-more">${hotspotsOpen?'แสดงน้อยลง':`ดูอีก ${Math.min(list.length,25)-6} จุด`}</button>`:'')+(list.length>25&&hotspotsOpen?`<p class="w-foot">และอีก ${list.length-25} จุดบนแผนที่</p>`:''):'<p class="w-foot">ไม่มีจุดที่คาดว่าน้ำล้นตลิ่ง คลองวิกฤต หรือฝนหนักในช่วงนี้</p>';
 const more=$('hotspots').querySelector('.hs-more');if(more)more.onclick=()=>{hotspotsOpen=!hotspotsOpen;hotspotPanel(list);};
 for(const b of $('hotspots').querySelectorAll('.hs-row'))b.onclick=()=>{const s=list[+b.dataset.i];map.setView(s.ll,12);L.popup({maxWidth:330}).setLatLng(s.ll).setContent(hotspotHtml(s)).openOn(map);if(!wide())setPanel(false);};
}

// --- summary tiles ---------------------------------------------------------------------------------------------------
function tiles(d,list){
 const t=Date.now()+horizon*3600000,cp=d.plans?.dams.find(p=>p.id==='chaophraya'),ps=d.plans?.dams.find(p=>p.id==='pasak'),out=[];
 if(cp){const a=planAt(cp,t);out.push(['เขื่อนเจ้าพระยา',num(a.m3s),'ลบ.ม./วิ','blue']);}
 if(ps){const a=planAt(ps,t);out.push(['เขื่อนป่าสักฯ',num(a.m3s),'ลบ.ม./วิ','blue']);}
 const over=d.stations.filter(s=>(horizon?s.forecast[horizon]?.pct:s.pctNow)>=100);out.push(['สถานีล้นตลิ่ง',over.length,horizon?`ใหม่ ${over.filter(s=>s.pctNow<100).length}`:'สถานี','red']);
 const x=fwd();if(x&&horizon){const fr=frameAt(x,horizon);out.push(['ท่วมเพิ่ม (แบบจำลอง)',num(fr.newKm2),'ตร.กม.','orange']);}
 const c=horizon?d.canals?.countsAhead?.[horizon]:d.canals?.counts;if(c)out.push(['คลอง กทม. วิกฤต',c.critical,'จุดวัด','red']);
 const w=windowOf(horizon),top=[...(d.rain||[])].sort((a,b)=>(b.windows[w]?.mm||0)-(a.windows[w]?.mm||0))[0];if(top)out.push([`ฝนสูงสุด ${w-12}–${w} ชม.`,num(top.windows[w].mm),'มม.','green']);
 $('tiles').innerHTML=out.map(([k,v,u,c])=>`<div class="fc-tile ${c}"><small>${esc(k)}</small><b>${esc(v)}<em>${esc(u)}</em></b></div>`).join('');
}

// --- method notes ----------------------------------------------------------------------------------------------------
function method(d){
 const x=fwd(),src=d.rainSource;
 $('method').innerHTML=[
  `<b>ระดับแม่น้ำ/คลอง:</b> สถานี ThaiWater ${d.stations.length} แห่ง ค่าที่ +12/24/36 ชม. คือระดับสูงสุดในช่วง 12 ชม. นั้น • สถานีบนลำน้ำหลักส่งต่ออัตราการไหลจากต้นน้ำตามเวลาเดินทาง (ต้นทาง = แผนระบายเขื่อนเจ้าพระยาและป่าสักฯ ที่อัปเดตจากข่าว/ThaiWater อัตโนมัติ) • สถานีอื่นเทียบน้ำต้นทางย้อนหลัง 10 วัน (+น้ำขึ้นน้ำลง) หรือใช้แนวโน้มล่าสุด • ทุกสถานีทดสอบย้อนหลัง ดูค่าคลาดเคลื่อนใน popup`,
  x?`<b>พื้นที่น้ำท่วม:</b> แบบจำลองการไหล 2 มิติ กริด 100 ม. ลุ่มเจ้าพระยาตอนล่าง (กทม. นนทบุรี ปทุมธานี อยุธยา สมุทรปราการ นครปฐม) คำนวณเมื่อ ${esc(thaiTime(MODEL.issuedAt))} จำลองต่อ ${x.f.hours} ชม. ด้วยน้ำจากเขื่อนที่ส่งต่อตามเวลาเดินทาง แม่น้ำป่าสัก และฝนคาดการณ์ • <b style="color:#ff8c00">ส้ม</b> = มีน้ำเพิ่มจากตอนนี้ • <b style="color:#e00028">แดง</b> = มีน้ำเพราะเขื่อนปล่อยน้ำเพิ่ม • ไม่มีคันกั้นน้ำ ประตูน้ำ คลองซอย ในแบบจำลอง และใช้ DSM ความลึกเป็นค่าเฉลี่ยเซลล์ ใช้ดูทิศทางน้ำ ไม่ใช่ความลึกหน้าบ้าน • "ตอนนี้" ของพื้นที่อื่น (สระบุรี–นครนายก ชลบุรี กาญจนบุรี) เป็นน้ำขังจากฝนย้อนหลัง`:'<b>พื้นที่น้ำท่วม:</b> รอผลแบบจำลองรอบถัดไป (ทุก 2 ชม.)',
  `<b>คลอง กทม.:</b> ระดับน้ำและสถานะจากสำนักการระบายน้ำ (now.bangkok.go.th) • +12/24/36 ชม. = แนวโน้ม ~3 ชม. ล่าสุดต่อไปแบบหน่วงลง ไม่เกิน ±0.5 ม. ไม่รวมการสูบน้ำหรือฝน • เทศบาลนครรังสิต/ปากเกร็ด: ค่าปัจจุบัน`,
  `<b>เขื่อน:</b> ปริมาณระบายรายวันจากกรมชลประทาน (ThaiWater) และแผนระบายจากประกาศ/ข่าว`,
  `<b>ฝน:</b> ตอนนี้ = สถานีวัดฝนรายชั่วโมง ThaiWater (ประมาณพื้นผิวจากสถานีภายใน 25 กม.) • คาดการณ์ = ${src?.primary==='Google Weather'?`Google Weather API (ค่าหลัก ดึงเมื่อ ${esc(thaiTime(src.googleFetchedAt))}) และ `:''}Open-Meteo ${esc((src?.models||[]).join(', '))} (เฉลี่ย และนับจำนวนแบบจำลองที่คาดว่าฝน ≥${src?.wetMm??5} มม.) • สภาพอากาศตามเกณฑ์ฝนของกรมอุตุนิยมวิทยา`,
  `<b>จุดเสี่ยง:</b> รวมรายอำเภอ/เขต จากสถานีที่คาดว่าน้ำล้นตลิ่ง พื้นที่ที่แบบจำลองท่วมเพิ่ม คลองที่เกินระดับควบคุม และฝนหนัก • สาเหตุ "เขื่อน/น้ำเหนือ" = ระดับน้ำของสถานีคำนวณจากน้ำที่ปล่อยจากเขื่อน/ต้นน้ำ`,
  `<b>Traffy Fondue:</b> เรื่องร้องเรียนน้ำท่วม (กทม.) ลบเบอร์โทร/อีเมล ยังไม่ได้ตรวจสอบภาคสนาม`,
  `แผนที่ © OpenStreetMap contributors • ภูมิประเทศ Copernicus DEM © DLR/Airbus, ESA`,
 ].map(t=>`<li>${t}</li>`).join('');
}

// --- render ----------------------------------------------------------------------------------------------------------
function render(){
 const d=FL.data;if(!d||!map)return;
 for(const k of ['river','canal','release','traffy','rain','hotspot']){layers[k]?.remove();layers[k]=null;}
 $('panel-title').textContent=horizon?`คาดการณ์ +${horizon} ชม.`:'สถานการณ์ตอนนี้';
 for(const b of document.querySelectorAll('.time-bar button'))b.classList.toggle('on',+b.dataset.h===horizon);
 const list=hotspots(d);
 if($('f-river').checked)layers.river=FL.riverLayer(horizon).addTo(map);
 $('c-river').textContent=`${d.stations.filter(s=>(horizon?s.forecast[horizon]?.pct:s.pctNow)>=100).length} ล้นตลิ่ง`;
 if($('f-canal').checked)layers.canal=canalLayer(d).addTo(map);else $('c-canal').textContent='';
 if($('f-release').checked)layers.release=releaseLayer(d).addTo(map);else $('c-release').textContent='';
 if($('f-traffy').checked)layers.traffy=traffyLayer().addTo(map);else $('c-traffy').textContent='';
 if($('f-rain').checked)layers.rain=rainLayer(d).addTo(map);else $('c-rain').textContent='';
 if($('f-hotspot').checked)layers.hotspot=hotspotLayer(list).addTo(map);
 hotspotPanel(list);tiles(d,list);weatherPanel(d);method(d);paintFlood();
}
const setHorizon=h=>{horizon=h;render();const u=new URL(location);u.searchParams.set('h',h);history.replaceState(null,'',u);};
// shareable view: ?h=0|12|24|36, ?view=bkk
{const q=new URLSearchParams(location.search),h=Number(q.get('h'));if([0,...HZ].includes(h)&&q.has('h'))horizon=h;if(q.get('view')==='bkk')map?.setView([13.85,100.6],11);}
for(const b of document.querySelectorAll('.time-bar button'))b.onclick=()=>setHorizon(+b.dataset.h);
onFilter(['f-river','f-canal','f-release','f-traffy','f-traffy-hours','f-rain','f-hotspot','f-flood','f-variant'],render);
if(map){let z0=map.getZoom();map.on('zoomend',()=>{const z=map.getZoom(),band=v=>v<9?0:v<10?1:v<11?2:3;if(band(z)!==band(z0))render();z0=z;});}
if(map){let t;map.on('moveend',()=>{if(!horizon&&$('f-rain').checked){clearTimeout(t);t=setTimeout(()=>{layers.rain?.remove();layers.rain=rainLayer(FL.data).addTo(map);},200);}});}
document.addEventListener('domains',()=>paintFlood());document.addEventListener('places',render);

async function load(){
 const [fc,model,now]=await Promise.allSettled([FL.load(true),fetchJson('/live/model/latest.json',{cache:'no-cache'}),fetchJson('/live/now.json',{cache:'no-cache'})]);
 if(model.status==='fulfilled')MODEL=model.value;if(now.status==='fulfilled'){NOW=now.value;rainGrid=null;}
 if(fc.status==='fulfilled'){const d=FL.data;$('live-status').innerHTML=`<i></i> คาดการณ์ ${esc(thaiTime(d.issuedAt))} (${esc(ago(d.issuedAt))})`;render();}
 else $('live-status').textContent='โหลดข้อมูลไม่สำเร็จ • จะลองใหม่อัตโนมัติ';
 setTimeout(load,document.hidden?600000:300000);
}
load();
