// Forecast page: map of river stations by forecast horizon, areas expected over bank, dam plans, the Chao Phraya / Pa Sak
// chain with travel times, dam table, Bangkok canals and the rain outlook. Data: /live/forecast.json (forecast.mjs).
const $=id=>document.getElementById(id),{esc,time,f2,sign}=FL;
const num=v=>v==null?'–':Number(v).toLocaleString('th-TH');
let map=null,horizon=24,layers={};
const CHAIN_CP=[['C.2','นครสวรรค์'],['C.13','ท้ายเขื่อนเจ้าพระยา'],['C.3','สิงห์บุรี'],['C.7A','อ่างทอง'],['C.35','อยุธยา (บ้านป้อม)'],['CPY012','บางปะอิน'],['CPY014','นนทบุรี (ปากเกร็ด)'],['C.12','กทม. สามเสน'],['CPY015','กทม. สะพานกรุงเทพ']];
const CHAIN_PS=[['S.9','สระบุรี (บ้านป่า)'],['S.26','ท้ายเขื่อนพระราม 6'],['PAS008','ท่าเรือ'],['S.5','อยุธยา (สะพานปรีดี)']];

function initMap(){
 map=L.map('map',{zoomControl:false}).setView([14.1,100.55],8);L.control.zoom({position:'topright'}).addTo(map);L.control.scale({position:'bottomright',imperial:false}).addTo(map);
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
 $('map').classList.add('muted-base');
 for(const [name,z] of [['mentions',380],['evidence',450]])map.createPane(name).style.zIndex=z;
}
function paintMap(){
 for(const l of Object.values(layers))l.remove();layers={};const d=FL.data;
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
  return `<div class="dam-plan"><h3>${esc(p.name)}</h3><div class="steps">${p.schedule.map(s=>{const past=Date.parse(s.from)<=Date.now();return `<div class="step${past?' past':''}"><i style="height:${Math.max(6,s.m3s/max*64)}px"></i><b>${num(s.m3s)}</b><small>${new Date(s.from).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small></div>`;}).join('')}${p.high?`<div class="step high"><i style="height:${p.high.m3s/max*64}px"></i><b>${num(p.high.m3s)}?</b><small>สมมติฐานสูง</small></div>`:''}</div>
   <p>${esc(p.outlook||'')}${p.high?`<br><small>${esc(p.high.why)}</small>`:''}</p><p class="fc-small">ที่มา: ${[...new Map(p.schedule.map(s=>[s.url,s])).values()].map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.source)}</a>`).join(' • ')}</p></div>`;}).join('')
  +(d.plans.tide?`<div class="dam-plan tide"><h3>น้ำทะเลหนุน</h3><p>${esc(d.plans.tide.note)}</p><p class="fc-small"><a href="${esc(d.plans.tide.url)}" target="_blank" rel="noreferrer">ที่มา</a> • สถานีริมเจ้าพระยาตอนล่างในแผนที่รวมน้ำขึ้นน้ำลงแล้ว</p></div>`:'');
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
 initMap();
 try{await FL.load();}catch{$('fc-issued').textContent='โหลดข้อมูลคาดการณ์ไม่สำเร็จ • ลองรีเฟรชอีกครั้ง';return;}
 const d=FL.data;
 $('fc-issued').innerHTML=`ออกเมื่อ <b>${esc(time(d.issuedAt))}</b> • ${d.stations.length} สถานีวัดระดับน้ำ ภาคกลาง ตะวันออก ตะวันตก • ค่าที่ +12/+24/+36 ชม. คือ<b>ระดับสูงสุด</b>ในช่วง 12 ชม. นั้น • อัปเดตทุก 30 นาที`;
 $('fc-status').innerHTML=`<i></i> ออก ${esc(time(d.issuedAt))}`;$('footer-updated').textContent='• ข้อมูลล่าสุด '+time(d.issuedAt);
 tiles(d);damPlans(d);chain($('chain-cp'),CHAIN_CP,d);chain($('chain-ps'),CHAIN_PS,d);damRows(d);canals(d);rain(d);
 const setH=h=>{horizon=h;for(const b of document.querySelectorAll('.fc-seg button'))b.classList.toggle('on',+b.dataset.h===h);paintMap();riskList(d);};
 for(const b of document.querySelectorAll('.fc-seg button'))b.onclick=()=>setH(+b.dataset.h);
 for(const id of ['t-river','t-canal','t-dam','t-rain'])$(id).onchange=paintMap;
 setH(24);
 const bkk=()=>{$('t-canal').checked=true;paintMap();map.setView([13.79,100.62],11);};$('go-bkk').onclick=bkk;$('go-all').onclick=()=>map.setView([14.1,100.55],8);
 if(new URLSearchParams(location.search).get('view')==='bkk')bkk();
}
start();
