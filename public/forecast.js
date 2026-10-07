// Forecast page: map of river stations by forecast horizon, areas expected over bank, dam plans, the Chao Phraya / Pa Sak
// chain with travel times, dam table, Bangkok canals and the rain outlook. Data: /live/forecast.json (forecast.mjs).
const $=id=>document.getElementById(id),{esc,time,f2,sign}=FL;
const num=v=>v==null?'–':Number(v).toLocaleString('th-TH');
const day=t=>new Date(t).toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',year:'2-digit'});
const ago=t=>{const m=Math.round((Date.now()-Date.parse(t))/60000);return m<60?`${Math.max(m,1)} นาทีก่อน`:m<2880?`${Math.round(m/60)} ชม.ก่อน`:`${Math.round(m/1440)} วันก่อน`;};
let map=null,horizon=24,layers={};
const CHAIN_CP=[['C.2','นครสวรรค์'],['C.13','ท้ายเขื่อนเจ้าพระยา'],['C.3','สิงห์บุรี'],['C.7A','อ่างทอง'],['C.35','อยุธยา (บ้านป้อม)'],['CPY012','บางปะอิน'],['CPY014','นนทบุรี (ปากเกร็ด)'],['C.12','กทม. สามเสน'],['CPY015','กทม. สะพานกรุงเทพ']];
const CHAIN_PS=[['S.9','สระบุรี (บ้านป่า)'],['S.26','ท้ายเขื่อนพระราม 6'],['PAS008','ท่าเรือ'],['S.5','อยุธยา (สะพานปรีดี)']];

function initMap(){
 map=L.map('map',{zoomControl:false}).setView([14.1,100.55],8);L.control.zoom({position:'topright'}).addTo(map);L.control.scale({position:'bottomright',imperial:false}).addTo(map);
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
 $('map').classList.add('muted-base');
 for(const [name,z] of [['mentions',380],['evidence',450]])map.createPane(name).style.zIndex=z;
}
// --- 2D flood model forward run (/live/model/latest.json: scenario.forecast, frames every 6 h) ----------------------
let model=null,domInfo=null,paintTok=0;const bytesCache=new Map();
async function bytes(url){if(!bytesCache.has(url))bytesCache.set(url,(async()=>{const r=await fetch(url);if(!r.ok)throw Error(r.status);const b=new Uint8Array(await r.arrayBuffer());
 return b[0]===0x1f&&b[1]===0x8b?new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()):b;})());return bytesCache.get(url);}
async function loadModel(){try{[model,domInfo]=await Promise.all([fetch('/live/model/latest.json',{cache:'no-cache'}).then(r=>r.json()),fetch('/data/domains.json').then(r=>r.json())]);}catch{model=null;}}
function fwd(){const d=model?.domains?.find(x=>x.scenarios?.some(s=>s?.forecast));if(!d)return null;return {d,f:d.scenarios.find(s=>s?.forecast).forecast};}
const variant=()=>$('t-variant').value;
function frameAt(x,h){const fr=x.f[variant()]?.frames||[];return fr.find(f=>f.hoursAhead===h)||fr.at(-1);}
const BINS=[[2,[229,153,247]],[10,[204,93,232]],[30,[156,54,181]],[50,[95,15,122]]];
async function floodLayer(tok){
 const x=fwd();if(!x)return;const info=domInfo?.domains.find(d=>d.id===x.d.id);if(!info)return;
 const fr=frameAt(x,horizon),f0=x.f[variant()].frames[0],hf=x.f.hold?.frames.find(f=>f.hoursAhead===fr.hoursAhead);
 const [idxB,dep,dep0,hold]=await Promise.all([bytes(`/data/overview/${x.d.id}.bin.gz`),bytes(model.base+fr.file),bytes(model.base+f0.file),hf&&horizon?bytes(model.base+hf.file):null]);if(tok!==paintTok)return;
 const idx=new Uint32Array(idxB.buffer,idxB.byteOffset,idxB.byteLength/4),{width:W,height:H,bounds:[w,s,e,n]}=info.overview;
 const cv=document.createElement('canvas');cv.width=W;cv.height=H;const ctx=cv.getContext('2d'),img=ctx.createImageData(W,H),px=img.data;
 for(let p=0;p<idx.length;p++){const c=idx[p];if(c===0xFFFFFFFF)continue;const v=dep[c];if(v<2)continue;const o=p*4;
  if(hold&&hold[c]<2){px[o]=224;px[o+1]=0;px[o+2]=40;px[o+3]=240;continue;}  // wet only because of the added release (dry if inflow held)
  if(horizon&&dep0[c]<2){px[o]=255;px[o+1]=140;px[o+2]=0;px[o+3]=225;continue;}  // newly flooded since the issue hour
  let col=BINS[0][1];for(const [t,rgb] of BINS)if(v>=t)col=rgb;px[o]=col[0];px[o+1]=col[1];px[o+2]=col[2];px[o+3]=200;}
 ctx.putImageData(img,0,0);layers.flood?.remove();layers.flood=L.imageOverlay(cv.toDataURL(),[[s,w],[n,e]],{pane:'flood',opacity:.85,interactive:false,className:'pixelated'}).addTo(map);
}
function inund(){
 const x=fwd();if(!x){$('inund-note').textContent=model?'รอบนี้แบบจำลองยังไม่ได้คำนวณไปข้างหน้า (รอผลรอบถัดไป ทุก 2 ชม.)':'โหลดผลแบบจำลองไม่ได้';return;}
 const F=x.f,v=F[variant()],fr=frameAt(x,horizon||12),f0=v.frames[0],num1=n=>n.toLocaleString('th-TH',{maximumFractionDigits:1});
 $('inund-note').innerHTML=`คำนวณเมื่อ ${esc(time(model.issuedAt))} • จำลองต่อจากสภาพน้ำ ณ ${esc(time(F.issuedAt))} ไปอีก ${F.hours} ชม. • น้ำเข้าแม่น้ำเจ้าพระยาที่ ${esc(F.inflowStation)} ตาม<b>อัตราระบายเขื่อน</b>ที่ส่งต่อตามเวลาเดินทาง + แม่น้ำป่าสักที่อยุธยา + ฝนคาดการณ์ • <b style="color:#e00028">สีแดง</b> = ท่วมเพราะน้ำเขื่อนที่เพิ่มขึ้น (ถ้าน้ำเข้าคงที่ระดับปัจจุบันจะไม่ท่วม) • <b style="color:#e8590c">สีส้ม</b> = น้ำที่ล้นตลิ่งอยู่แล้วแผ่ขยายต่อ/ฝน (แบบจำลองเริ่มจากพื้นแห้งเมื่อ ~2.5 วันก่อน พื้นที่ส้มหลายแห่งจึงอาจท่วมอยู่แล้วในความจริง) • น้ำที่ปล่อยจากเขื่อนเจ้าพระยาใช้เวลา ~14 ชม. ถึงอ่างทอง และอีก ~1–2 วันถึงนนทบุรี/กทม. ผลส่วนใหญ่ต่อ กทม. จึงอยู่หลัง 36 ชม.`;
 const tot=o=>Object.values(o.provincesKm2).reduce((a,b)=>a+b,0);
 $('inund-tiles').innerHTML=[[`ท่วมเพิ่มเพราะน้ำเขื่อนที่เพิ่มขึ้น (+${fr.hoursAhead} ชม.)`,num1(fr.damKm2??0),'ตร.กม.','red'],[`ท่วมเพิ่มทั้งหมดใน ${fr.hoursAhead} ชม.`,num1(fr.newKm2),'ตร.กม.','orange'],['พื้นที่มีน้ำ (นอกลำน้ำ) ตอนนี้',num1(tot(f0)),'ตร.กม.','blue'],[`พื้นที่มีน้ำ +${fr.hoursAhead} ชม.`,num1(tot(fr)),'ตร.กม.','blue']]
  .map(([k,val,u,c])=>`<div class="fc-tile ${c}"><small>${esc(k)}</small><b>${esc(val)}<em>${u}</em></b></div>`).join('');
 $('inund-area-title').textContent=`อำเภอ/เขตที่แบบจำลองมีน้ำท่วมเพิ่ม ภายใน ${fr.hoursAhead} ชม. (${variant()==='high'?'สมมติฐานสูง':'ระบายตามประกาศ'})`;
 const rows=[...fr.areas].sort((a,b)=>(b.damKm2||0)-(a.damKm2||0)||b.newKm2-a.newKm2).filter(a=>a.newKm2>=.05||a.km2>=1).slice(0,30);
 $('inund-rows').innerHTML=rows.map(a=>`<tr><td>${esc(a.kind)}${esc(a.name)} <small>${esc(a.province)}</small></td><td>${a.damKm2>=.05?`<b class="dam">+${num1(a.damKm2)}</b>`:'–'}</td><td>${a.newKm2>=.05?`<b class="new">+${num1(a.newKm2)}</b>`:'–'}</td><td>${num1(a.km2)}</td><td>${num1(a.deepKm2)}</td></tr>`).join('')||'<tr><td colspan="4">แบบจำลองไม่มีพื้นที่ท่วมเพิ่มในช่วงนี้</td></tr>';
 const svg=$('inund-chart'),ns='http://www.w3.org/2000/svg',el=(n,a)=>{const e=document.createElementNS(ns,n);for(const k in a)e.setAttribute(k,a[k]);return e;};svg.replaceChildren();
 const ser=k=>F[k].inflow.map(r=>[Date.parse(r[0]),r[1],r[2][0]||0]),B=ser('base'),Hh=ser('high'),all=[...B,...Hh];
 const t0=all[0][0],t1=all.at(-1)[0],vmax=Math.max(...all.map(r=>r[1]))*1.08,X=t=>44+(t-t0)/(t1-t0||1)*466,Y=v=>150-v/vmax*135;
 for(const val of [0,vmax/2,vmax]){svg.append(el('line',{x1:44,x2:510,y1:Y(val),y2:Y(val),stroke:'#e3e9e6'}));const tx=el('text',{x:40,y:Y(val)+4,'text-anchor':'end','font-size':10,fill:'#6b7f79'});tx.textContent=Math.round(val).toLocaleString('th-TH');svg.append(tx);}
 const line=(rows,k,col,dash)=>svg.append(el('polyline',{points:rows.map(r=>`${X(r[0])},${Y(r[k])}`).join(' '),fill:'none',stroke:col,'stroke-width':2.5,'stroke-dasharray':dash||''}));
 line(Hh,1,'#e8590c','5 3');line(B,1,'#1971c2');line(B,2,'#2f9e44');
 for(const t of [t0,t1]){const tx=el('text',{x:X(t),y:166,'text-anchor':t===t0?'start':'end','font-size':10,fill:'#6b7f79'});tx.textContent=time(new Date(t).toISOString());svg.append(tx);}
 const tt=Date.parse(fr.validAt);svg.append(el('line',{x1:X(tt),x2:X(tt),y1:10,y2:150,stroke:'#adb5bd','stroke-dasharray':'2 3'}));
 $('inund-inflow').innerHTML=`<span style="color:#1971c2">━</span> เจ้าพระยาเข้าพื้นที่ (${esc(F.inflowStation)} หน่วง ${F.inflowLagHours} ชม.) ${num(B[0][1])} → ${num(B.at(-1)[1])} • <span style="color:#e8590c">┅</span> สมมติฐานสูง → ${num(Hh.at(-1)[1])} • <span style="color:#2f9e44">━</span> ป่าสักที่อยุธยา (S.26 หน่วง ${F.tributaries[0]?.lagHours??'–'} ชม.) ${num(B[0][2])} → ${num(B.at(-1)[2])}`;
 const gl=Object.entries(fr.riverLevelsM||{}),st=new Map(FL.data.stations.map(s=>[s.code,s]));
 $('inund-method').innerHTML=[
  'แบบจำลองการไหลบนผิวดิน 2 มิติ (local-inertial) กริด 100 ม. บนภูมิประเทศ Copernicus DSM ครอบคลุม กทม. นนทบุรี ปทุมธานี อยุธยา สมุทรปราการ นครปฐม • น้ำในร่องแม่น้ำเจ้าพระยาไหลตามจริง ล้นตลิ่งเมื่อระดับน้ำสูงกว่าพื้นที่ข้างเคียง',
  'เริ่มจากสภาพน้ำที่แบบจำลองย้อนหลัง (ฝน 36 ชม. + น้ำที่วัดจริงที่ C.7A และ S.26) แล้วคำนวณต่อไปข้างหน้าด้วยปริมาณน้ำที่คาดว่าจะเข้ามา: อัตราไหลที่ C.7A จากแผนระบายเขื่อนเจ้าพระยาส่งต่อตามเวลาเดินทาง, แม่น้ำป่าสักจาก S.26, ฝนรายชั่วโมงจาก Open-Meteo • สมมติฐานการระบายน้ำ (สูบ/ท่อ) กลาง',
  gl.length?`ตรวจความสอดคล้อง: ระดับน้ำแม่น้ำในแบบจำลองที่ +${fr.hoursAhead} ชม. / คาดการณ์รายสถานี — ${gl.map(([c,val])=>{const s=st.get(c),p=s?.forecast?.[horizon||12];return `${esc(c)} ${f2(val)}${p?` / ${f2(p.level)}`:''} ม.`;}).join(' • ')}`:'',
  '<b>ข้อจำกัด:</b> พื้นที่ชายทะเลสมุทรปราการ (บ่อปลา/นากุ้ง ความสูงต่ำ) อาจเกินจริง • ไม่มีคันกั้นน้ำ/กำแพงริมแม่น้ำ ประตูระบายน้ำ และคลองซอย (เช่น คลองบางบัวทอง คลองพระพิมล) ในแบบจำลอง • ใช้ DSM (รวมอาคาร/ต้นไม้) ไม่ใช่ความสูงพื้นดินจริง • ไม่มีน้ำทะเลหนุนที่ปากแม่น้ำ (ระดับน้ำ กทม. ช่วงน้ำขึ้นอาจต่ำกว่าจริง) • ไม่รวมแม่น้ำน้อย/ท่าจีน • ความลึกเป็นค่าเฉลี่ยของเซลล์ 100 ม. ใช้ดูว่า<b>น้ำจะไปทางไหนและพื้นที่ไหนเพิ่มขึ้น</b> ไม่ใช่ความลึกหน้าบ้าน'
 ].filter(Boolean).map(t=>`<li>${t}</li>`).join('');
}

function paintMap(){
 for(const l of Object.values(layers))l.remove();layers={};const d=FL.data;const tok=++paintTok;
 if($('t-flood').checked)floodLayer(tok).catch(()=>{});
 if($('t-rain').checked&&horizon)layers.rain=rainLayer(d).addTo(map);
 if($('t-canal').checked)layers.canal=FL.canalLayer().addTo(map);
 if($('t-dam').checked)layers.dam=damLayer(d).addTo(map);
 if($('t-river').checked)layers.river=FL.riverLayer(horizon).addTo(map);
}
function damLayer(d){
 const g=L.layerGroup(),plans=Object.fromEntries(d.plans.dams.map(p=>[p.name.split(' ')[0],p]));
 for(const x of d.dams){if(x.lat<12||x.lat>17.5||x.lng<98.3||x.lng>102.8)continue;const col=x.storagePct>=100?'#a51111':x.storagePct>=90?'#e03131':x.storagePct>=80?'#f76707':'#6f4e37';
  const plan=Object.values(plans).find(p=>p.name.includes(x.name.replace('เขื่อน','')));
  L.marker([x.lat,x.lng],{pane:'evidence',icon:L.divIcon({className:'fc-dam',html:`<span style="--c:${col}">▼ ${Math.round(x.storagePct)}%</span>`,iconSize:null})})
   .bindPopup(`<b>${esc(x.name)}</b><br>ความจุ ${x.storagePct}% • ไหลเข้า ${num(x.inflowM3s)} • ระบาย ${num(x.releaseM3s)} ลบ.ม./วิ${x.spillM3s?` • ทางน้ำล้น ${num(x.spillM3s)}`:''}<br><small>ค่าเฉลี่ยวันที่ ${esc(x.date)} (กรมชลประทาน ผ่าน ThaiWater)</small>${plan?`<br><b>แผนระบาย:</b> ${plan.schedule.map(s=>`${esc(time(s.from))} ${num(s.m3s)}`).join(' → ')} ลบ.ม./วิ`:''}`,{maxWidth:320}).addTo(g);}
 // Chao Phraya Dam is a barrage (not in the storage-dam table): show its announced release
 const cp=d.plans.dams.find(p=>p.id==='chaophraya');if(cp){const now=cp.schedule.filter(s=>Date.parse(s.from)<=Date.now()).at(-1)||cp.schedule[0];
  L.marker([cp.lat,cp.lng],{pane:'evidence',icon:L.divIcon({className:'fc-dam',html:`<span style="--c:#1864ab">▼ ${num(now.m3s)} ลบ.ม./วิ</span>`,iconSize:null})}).bindPopup(`<b>${esc(cp.name)}</b><br>ระบาย ${num(now.m3s)} ลบ.ม./วินาที ตั้งแต่ ${esc(time(now.from))}<br><small>${esc(now.source)}</small><br>${esc(cp.outlook||'')}`,{maxWidth:320}).addTo(g);}
 return g;
}
function rainLayer(d){
 const g=L.layerGroup();for(const r of d.rain||[]){const w=r.windows[horizon];if(!w)continue;const mm=w.mm;
  L.circle([r.lat,r.lng],{pane:'mentions',radius:6000+Math.min(mm,80)*450,color:'#1c7ed6',weight:1,fillColor:mm>=35?'#e03131':mm>=10?'#fab005':mm>=1?'#74c0fc':'#dee2e6',fillOpacity:.35,interactive:false}).addTo(g);
  L.marker([r.lat,r.lng],{pane:'evidence',icon:L.divIcon({className:'fc-rain',html:`<span>☔ ${mm} มม.</span>`,iconSize:null})}).bindTooltip(`${r.name}: ฝนสะสม ${mm} มม. ช่วง ${horizon-12}–${horizon} ชม.`).addTo(g);}
 return g;
}

function tiles(d){
 const r36=d.risk[36]||[],cp=d.plans.dams.find(p=>p.id==='chaophraya'),ps=d.plans.dams.find(p=>p.id==='pasak');
 const cur=p=>p.schedule.filter(s=>Date.parse(s.from)<=Date.now()).at(-1)||p.schedule[0],next=p=>p.schedule.filter(s=>Date.parse(s.from)>Date.now());
 const t=[];
 if(cp){const c=cur(cp);t.push(['เขื่อนเจ้าพระยา ระบาย',`${num(c.m3s)}`,'ลบ.ม./วินาที',`ตั้งแต่ ${time(c.from)}${cp.high?` • สมมติฐานสูง ${num(cp.high.m3s)}`:''}`,'blue']);}
 if(ps){const c=cur(ps),n=next(ps);t.push(['เขื่อนป่าสักฯ ระบาย',`${num(c.m3s)}${n.length?' → '+num(n.at(-1).m3s):''}`,'ลบ.ม./วินาที',n.length?`เพิ่มเป็น ${num(n.at(-1).m3s)} วันที่ ${new Date(n.at(-1).from).toLocaleDateString('th-TH',{day:'numeric',month:'short'})}`:'ตามแผนล่าสุด','blue']);}
 t.push(['สถานีคาดว่าล้นตลิ่งใน 36 ชม.',`${r36.length}`,'สถานี',`ในจำนวนนี้ ${r36.filter(x=>x.newly).length} แห่งตอนนี้ยังไม่ล้น`,'red']);
 if(d.canals)t.push(['คลอง กทม. วิกฤต',`${d.canals.counts.critical}`,'จุดวัด',`เตือนภัย ${d.canals.counts.warning} • ปกติ ${d.canals.counts.normal} • ขัดข้อง ${d.canals.counts.offline}`,'red']);
 const wet=[...(d.rain||[])].sort((a,b)=>b.windows[36].mm+b.windows[24].mm+b.windows[12].mm-(a.windows[36].mm+a.windows[24].mm+a.windows[12].mm))[0];
 if(wet){const tot=wet.windows[12].mm+wet.windows[24].mm+wet.windows[36].mm;t.push(['ฝนคาดสูงสุดใน 36 ชม.',`${tot.toFixed(0)}`,'มม.',wet.name,'green']);}
 $('fc-tiles').innerHTML=t.map(([k,v,u,s,c])=>`<div class="fc-tile ${c}"><small>${esc(k)}</small><b>${esc(v)}<em>${esc(u)}</em></b><span>${esc(s)}</span></div>`).join('');
}

function riskList(d){
 const h=horizon||12,list=horizon?d.risk[h]:d.stations.filter(s=>s.pctNow>=100).map(s=>({...s,pct:s.pctNow,riseM:0}));
 $('risk-title').textContent=horizon?`คาดว่าน้ำล้นตลิ่ง ช่วง ${h-12}–${h} ชม.`:'น้ำล้นตลิ่งตอนนี้';
 $('risk-note').textContent=`${list.length} สถานี • ⚠ ใหม่ = ตอนนี้ยังไม่ล้น • กดเพื่อดูบนแผนที่`;
 const by=new Map();for(const x of list){if(!by.has(x.province))by.set(x.province,[]);by.get(x.province).push(x);}
 const html=[...by].sort((a,b)=>b[1].length-a[1].length).map(([p,xs])=>`<details open><summary><b>${esc(p)}</b> <small>${xs.length} จุด</small></summary><ul>${xs.map(x=>`<li data-code="${esc(x.code)}"><span class="pct" style="--c:${FL.pctColor(x.pct)}">${x.pct}%</span> ${x.newly?'<i class="new">⚠ ใหม่</i> ':''}${esc(x.name)} <small>อ.${esc(x.amphoe)}${x.riseM?` • ${sign(x.riseM)} ม.`:''}</small></li>`).join('')}</ul></details>`).join('');
 $('risk-list').innerHTML=html||'<p>ไม่มีสถานีที่คาดว่าล้นตลิ่ง</p>';
 for(const li of $('risk-list').querySelectorAll('li'))li.onclick=()=>{const s=d.stations.find(x=>x.code===li.dataset.code);if(s){map.setView([s.lat,s.lng],12);L.popup({maxWidth:340}).setLatLng([s.lat,s.lng]).setContent(FL.stationPopup(s)).openOn(map);$('fc-map').scrollIntoView({behavior:'smooth'});}};
}

function damPlans(d){
 $('dam-plans').innerHTML=d.plans.dams.map(p=>{const max=Math.max(...p.schedule.map(s=>s.m3s),p.high?.m3s||0);
  return `<div class="dam-plan"><h3>${esc(p.name)}</h3><div class="steps">${p.schedule.map(s=>{const past=Date.parse(s.from)<=Date.now();return `<div class="step${past?' past':''}${s.auto?' auto':''}" title="${esc(s.source)}"><i style="height:${Math.max(6,s.m3s/max*64)}px"></i><b>${num(s.m3s)}</b><small>${new Date(s.from).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}${s.auto?'<br>อัตโนมัติ':''}</small></div>`;}).join('')}${p.high?`<div class="step high"><i style="height:${p.high.m3s/max*64}px"></i><b>${num(p.high.m3s)}?</b><small>สมมติฐานสูง</small></div>`:''}</div>
   <p>${esc(p.outlook||'')}${p.outlook&&d.plans.outlookAt?` <small>(ข้อความ ณ ${esc(day(d.plans.outlookAt))})</small>`:''}${p.high?`<br><small>${esc(p.high.why)}</small>`:''}</p>${p.news?.length?`<ul class="dam-news">${p.news.map(n=>`<li><a href="${esc(n.url)}" target="_blank" rel="noreferrer">${esc(n.title)}</a> <small>${esc(n.source)} • ${esc(ago(n.at))}</small></li>`).join('')}</ul>`:''}<p class="fc-small">ที่มา: ${[...new Map(p.schedule.map(s=>[s.url,s])).values()].map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.source)}</a>`).join(' • ')}</p></div>`;}).join('')
  +(d.plans.tide?`<div class="dam-plan tide"><h3>น้ำทะเลหนุน</h3><p>${esc(d.plans.tide.note)}${d.plans.outlookAt?` <small>(ข้อความ ณ ${esc(day(d.plans.outlookAt))})</small>`:''}</p><p class="fc-small"><a href="${esc(d.plans.tide.url)}" target="_blank" rel="noreferrer">ที่มา</a> • สถานีริมเจ้าพระยาตอนล่างในแผนที่รวมน้ำขึ้นน้ำลงแล้ว</p></div>`:'');
}
function spark(s){
 const pts=s.path,lv=pts.flatMap(p=>[p[1],p[2]]).filter(v=>v!=null),lo=Math.min(...lv,s.bankM)-.2,hi=Math.max(...lv,s.bankM)+.2,W=160,H=46,x=h=>(h+48)/84*W,y=v=>H-(v-lo)/(hi-lo)*H;
 const line=k=>pts.filter(p=>p[k]!=null).map((p,i)=>`${i?'L':'M'}${x(p[0]).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
 return `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true"><line x1="0" x2="${W}" y1="${y(s.bankM)}" y2="${y(s.bankM)}" class="bank"/><line x1="${x(0)}" x2="${x(0)}" y1="0" y2="${H}" class="now"/><path d="${line(1)}" class="obs"/><path d="${line(2)}" class="fc"/></svg>`;
}
function chain(el,nodes,d){
 const by=new Map(d.stations.map(s=>[s.code,s]));
 el.innerHTML=nodes.map(([code,label],k)=>{const s=by.get(code);if(!s)return '';
  const arrow=k&&s.lagH!=null&&s.method==='flow'&&s.up?`<div class="arrow"><b>~${s.lagH} ชม.</b>${s.speedKmh?`<small>${s.speedKmh} กม./ชม.</small>`:''}</div>`:k?'<div class="arrow"><b></b></div>':'';
  const chips=[12,24,36].map(h=>{const v=s.forecast[h];return `<span style="--c:${FL.pctColor(v?.pct)}">+${h} <b>${v?.pct??'–'}%</b></span>`;}).join('');
  return `${arrow}<div class="node" data-code="${esc(code)}"><small>${esc(label)} • ${esc(code)}</small><b style="color:${FL.pctColor(s.pctNow)}">${s.pctNow}%</b><span class="lv">${f2(s.levelNow)} ม.รทก.${s.qNow?` • ${num(s.qNow)} ลบ.ม./วิ`:''}</span>${spark(s)}<div class="chips">${chips}</div></div>`;}).join('');
 for(const n of el.querySelectorAll('.node'))n.onclick=()=>{const s=by.get(n.dataset.code);map.setView([s.lat,s.lng],11);L.popup({maxWidth:340}).setLatLng([s.lat,s.lng]).setContent(FL.stationPopup(s)).openOn(map);$('fc-map').scrollIntoView({behavior:'smooth'});};
}
function damRows(d){
 $('dam-rows').innerHTML=d.dams.filter(x=>x.storagePct!=null).map(x=>`<tr><td>${esc(x.name)}</td><td><span class="bar"><i style="width:${Math.min(100,x.storagePct)}%;--c:${x.storagePct>=100?'#a51111':x.storagePct>=90?'#e03131':x.storagePct>=80?'#f76707':'#4c9be8'}"></i></span> ${x.storagePct}%</td><td>${num(x.inflowM3s)}</td><td>${num(x.releaseM3s)}</td><td>${x.spillM3s?num(x.spillM3s):'–'}</td></tr>`).join('');
}
function canals(d){
 const c=d.canals;if(!c){$('canal-note').textContent='ยังไม่มีข้อมูลคลองจาก กทม. รอบนี้';return;}
 const st=c.stations.find(s=>!s.offline);$('canal-note').innerHTML=`ข้อมูล ${esc(time(st?.at))} • ${c.stations.length} จุดวัด • <b>วิกฤต</b> = ระดับน้ำเกินระดับควบคุมของ กทม. (คลองรับน้ำได้น้อยลง ถนน/ชุมชนริมคลองระบายน้ำช้า) • กดชื่อคลองเพื่อดูบนแผนที่`;
 $('canal-tiles').innerHTML=[['วิกฤต',c.counts.critical,'red'],['เตือนภัย',c.counts.warning,'orange'],['ปกติ',c.counts.normal,'green'],['ขัดข้อง',c.counts.offline,'gray']].map(([k,v,cl])=>`<div class="fc-tile ${cl}"><small>${k}</small><b>${v}<em>จุด</em></b></div>`).join('');
 const lab={critical:'วิกฤต',warning:'เตือนภัย',normal:'ปกติ',offline:'ขัดข้อง'},maxOver=Math.max(.01,...c.canals.map(x=>x.maxOverM||0));
 $('canal-rows').innerHTML=c.canals.map((x,k)=>`<tr data-k="${k}"><td><b>${esc(x.canal)}</b></td><td><span class="chip" style="--c:${FL.CANAL[x.state][0]}">${lab[x.state]}</span></td><td>${x.critical}/${x.stations}${x.warning?` <small>(+เตือน ${x.warning})</small>`:''}</td><td>${x.maxOverM!=null?`<span class="bar"><i style="width:${Math.max(0,x.maxOverM)/maxOver*100}%;--c:${x.maxOverM>0?'#e03131':'#2f9e44'}"></i></span> ${sign(x.maxOverM)} ม.`:'–'}</td><td>${x.trend==null?'<small>รอข้อมูลรอบถัดไป</small>':x.trend>.01?`<b class="up">▲ ${sign(x.trend)} ม./ชม.</b>`:x.trend<-.01?`<b class="down">▼ ${sign(x.trend)} ม./ชม.</b>`:'ทรงตัว'}</td><td><small>${esc(x.districts.join(', '))}</small></td></tr>`).join('');
 for(const tr of $('canal-rows').querySelectorAll('tr'))tr.onclick=()=>{const x=c.canals[tr.dataset.k],pts=c.stations.filter(s=>s.canal===x.canal).flatMap(s=>[[s.lat,s.lng],...(s.line||[]).flat()]);if(!pts.length)return;$('t-canal').checked=true;paintMap();map.fitBounds(L.latLngBounds(pts).pad(.3),{maxZoom:14});$('fc-map').scrollIntoView({behavior:'smooth'});};
}
function rain(d){
 const cell=w=>`<td><b style="color:${w.mm>=35?'#c92a2a':w.mm>=10?'#e67700':'inherit'}">${w.mm}</b> <small>(${w.probPct}%)</small></td>`;
 $('rain-rows').innerHTML=(d.rain||[]).map(r=>`<tr><td>${esc(r.name)}</td>${[12,24,36].map(h=>cell(r.windows[h])).join('')}</tr>`).join('')||'<tr><td colspan="4">ดึงพยากรณ์ฝนไม่สำเร็จรอบนี้</td></tr>';
}

async function start(){
 initMap();map.createPane('flood').style.zIndex=360;map.getPane('flood').style.pointerEvents='none';
 const mp=loadModel();
 try{await FL.load();}catch{$('fc-issued').textContent='โหลดข้อมูลคาดการณ์ไม่สำเร็จ • ลองรีเฟรชอีกครั้ง';return;}
 const d=FL.data;
 $('fc-issued').innerHTML=`ออกเมื่อ <b>${esc(time(d.issuedAt))}</b> • ${d.stations.length} สถานีวัดระดับน้ำ ภาคกลาง ตะวันออก ตะวันตก • ค่าที่ +12/+24/+36 ชม. คือ<b>ระดับสูงสุด</b>ในช่วง 12 ชม. นั้น • อัปเดตทุก 30 นาที`;
 $('fc-status').innerHTML=`<i></i> ออก ${esc(time(d.issuedAt))}`;$('footer-updated').textContent='• ข้อมูลล่าสุด '+time(d.issuedAt);
 tiles(d);damPlans(d);chain($('chain-cp'),CHAIN_CP,d);chain($('chain-ps'),CHAIN_PS,d);damRows(d);canals(d);rain(d);
 const setH=h=>{horizon=h;for(const b of document.querySelectorAll('.fc-seg button'))b.classList.toggle('on',+b.dataset.h===h);paintMap();riskList(d);if(model)inund();};
 for(const b of document.querySelectorAll('.fc-seg button'))b.onclick=()=>setH(+b.dataset.h);
 for(const id of ['t-river','t-canal','t-dam','t-rain','t-flood'])$(id).onchange=paintMap;
 $('t-variant').onchange=()=>{paintMap();if(model)inund();};
 mp.then(()=>{inund();paintMap();});
 setH(24);
 const bkk=()=>{$('t-canal').checked=true;paintMap();map.setView([13.79,100.62],11);};$('go-bkk').onclick=bkk;$('go-all').onclick=()=>map.setView([14.1,100.55],8);
 if(new URLSearchParams(location.search).get('view')==='bkk')bkk();
}
start();
