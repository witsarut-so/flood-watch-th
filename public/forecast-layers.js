// River stations coloured by level as % of bank (now or forecast +12/24/36 h) and Bangkok canals coloured by BMA status
// (now, or the gauge's trend carried forward), from /live/forecast.json. Used by main.js.
const FL=(()=>{
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const time=t=>t?new Date(t).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'short',timeStyle:'short'}):'–';
 const f2=v=>v==null?'–':Number(v).toFixed(2),sign=v=>v==null?'–':(v>0?'+':'')+Number(v).toFixed(2);
 // % of bank: blue < 80, yellow 80–90 watch, orange 90–100 near bank, red ≥ 100 over bank, dark red ≥ 115
 const PCT=[[115,'#a51111','ล้นตลิ่งมาก (≥115%)'],[100,'#e03131','ล้นตลิ่ง (≥100%)'],[90,'#f76707','ใกล้ล้นตลิ่ง (90–100%)'],[80,'#f5b400','เฝ้าระวัง (80–90%)'],[-1e9,'#4c9be8','ปกติ (<80%)']];
 const pctColor=p=>p==null?'#adb5bd':PCT.find(([t])=>p>=t)[1],pctLabel=p=>p==null?'ไม่มีข้อมูล':PCT.find(([t])=>p>=t)[2];
 const CANAL={critical:['#e03131','วิกฤต (เกินระดับควบคุม)'],warning:['#f59f00','เตือนภัย'],normal:['#2f9e44','ปกติ'],offline:['#adb5bd','ขัดข้อง/ไม่มีข้อมูลล่าสุด']};
 const METHOD={flow:'ส่งต่ออัตราการไหลจากต้นน้ำ',regress:'เทียบกับน้ำต้นทางย้อนหลัง 10 วัน',trend:'แนวโน้มล่าสุด'};
 let data=null,pending=null;
 async function load(force){
  if(data&&!force)return data;if(pending)return pending;
  pending=fetch('/live/forecast.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error(r.status);return r.json();}).then(d=>data=d).finally(()=>pending=null);
  return pending;}
 const valueAt=(s,h)=>h?s.forecast[h]:{level:s.levelNow,pct:s.pctNow,q:s.qNow};
 function stationPopup(s){
  const rows=[['ตอนนี้',{level:s.levelNow,pct:s.pctNow,q:s.qNow}],...[12,24,36].map(h=>['+'+h+' ชม.',s.forecast[h]])].map(([k,v])=>`<tr><td>${k}</td><td><b style="color:${pctColor(v?.pct)}">${f2(v?.level)}</b></td><td>${v?.pct??'–'}%</td><td>${v?.q?v.q.toLocaleString('th-TH'):''}</td>${v?.high?`<td><small>สูง ${f2(v.high.level)}</small></td>`:'<td></td>'}</tr>`).join('');
  const err=s.hindcastErrorM?.[24];
  return `<b>${esc(s.name)}</b> <small>${esc(s.code)} • ${esc([s.tambon&&'ต.'+s.tambon,s.amphoe&&'อ.'+s.amphoe,s.province].filter(Boolean).join(' '))}</small>
   <table class="fl-pop"><tr><th></th><th>ม.รทก.</th><th>% ตลิ่ง</th><th>ลบ.ม./วิ</th><th></th></tr>${rows}</table>
   <small>ตลิ่ง ${f2(s.bankM)} ม.รทก. • ค่าที่ +12/24/36 ชม. = ระดับสูงสุดในช่วง 12 ชม. นั้น • วิธี: ${esc(METHOD[s.method]||s.method)}${s.lagH!=null&&s.method!=='trend'?` (เวลาเดินทางของน้ำ ~${s.lagH} ชม.${s.speedKmh?`, ~${s.speedKmh} กม./ชม.`:''})`:''}${s.tidal?' • มีน้ำขึ้นน้ำลง':''}
   ${err!=null?`<br>ทดสอบย้อนหลัง (พยากรณ์จาก 36 ชม. ก่อน): คลาด ${err} ม. ที่ +24 ชม.${err>.5?' <b style="color:#c92a2a">ความเชื่อมั่นต่ำ</b>':''}`:''}
   <br>${esc(s.agency)} ผ่าน ThaiWater • วัดล่าสุด ${esc(time(s.at))}</small>`;
 }
 function riverLayer(horizon,{onClick}={}){
  const g=L.layerGroup();if(!data)return g;
  for(const s of [...data.stations].sort((a,b)=>(valueAt(a,horizon)?.pct??0)-(valueAt(b,horizon)?.pct??0))){const v=valueAt(s,horizon);if(!v)continue;
   const p=v.pct,rise=horizon&&s.forecast[horizon]?s.forecast[horizon].level-s.levelNow:0;
   const m=L.circleMarker([s.lat,s.lng],{pane:'evidence',radius:p>=100?8:p>=90?7:5.5,color:rise>.15?'#212529':'#fff',weight:rise>.15?2.2:1.4,fillColor:pctColor(p),fillOpacity:.95});
   m.bindPopup(()=>stationPopup(s),{maxWidth:340});m.bindTooltip(`${s.name} ${p??'–'}%${horizon&&rise?` (${sign(rise)} ม.)`:''}`,{direction:'top'});if(onClick)m.on('click',()=>onClick(s));m.addTo(g);}
  return g;
 }
 function canalPopup(s){
  const tr=s.trendMPerH==null?'':s.trendMPerH>.01?` <b style="color:#c92a2a">▲ ${sign(s.trendMPerH)} ม./ชม.</b>`:s.trendMPerH<-.01?` <b style="color:#2b8a3e">▼ ${sign(s.trendMPerH)} ม./ชม.</b>`:' ทรงตัว';
  const ahead=s.forecast?`<table class="fl-pop"><tr><th></th><th>ม.รทก.</th><th>สถานะ</th></tr><tr><td>ตอนนี้</td><td>${f2(s.levelM)}</td><td>${esc(CANAL[s.state][1])}</td></tr>${[12,24,36].map(h=>{const v=s.forecast[h];return v?`<tr><td>+${h} ชม.</td><td>${f2(v.levelM)}</td><td style="color:${CANAL[v.state][0]}">${esc(CANAL[v.state][1].split(' ')[0])}</td></tr>`:'';}).join('')}</table><small>+12/24/36 ชม. = แนวโน้ม ~3 ชม. ล่าสุดต่อไปแบบหน่วงลง ไม่รวมการสูบน้ำหรือฝนที่จะตก</small>`:'';
  return `<b>${esc(s.name)}</b><br><small>${esc(s.canal)} • เขต${esc(s.district)} • ${esc(s.code)}</small><br>สถานะ กทม.: <b style="color:${CANAL[s.state][0]}">${esc(s.status)}</b>
   <br>ระดับน้ำ ${f2(s.levelM)} ม.รทก.${tr}${s.criticalM!=null?`<br>ระดับเตือน ${f2(s.warningM)} • ระดับควบคุม ${f2(s.criticalM)} • ตลิ่ง ${f2(s.bankM)} ม.รทก.<br>${s.overM>0?`<b>เกินระดับควบคุม ${f2(s.overM)} ม.</b>`:`ต่ำกว่าระดับควบคุม ${f2(-s.overM)} ม.`}${s.bankM!=null&&s.levelM!=null?` • ห่างตลิ่ง ${f2(s.bankM-s.levelM)} ม.`:''}`:''}
   ${ahead}<br><small>สำนักการระบายน้ำ กทม. (now.bangkok.go.th) • ${esc(time(s.at))}</small>`;
 }
 const canalState=(s,h)=>h&&s.forecast?.[h]?s.forecast[h].state:s.state;
 function canalLayer({horizon=0,alertOnly=false,onClick}={}){
  const g=L.layerGroup(),c=data?.canals;if(!c)return g;const rank={offline:0,normal:1,warning:2,critical:3};
  for(const s0 of [...c.stations].sort((a,b)=>rank[canalState(a,horizon)]-rank[canalState(b,horizon)])){const s={...s0,state:canalState(s0,horizon),status:horizon?`${CANAL[canalState(s0,horizon)][1]} (แนวโน้ม +${horizon} ชม.) • ตอนนี้: ${s0.status}`:s0.status};
   if(alertOnly&&!(s.state==='critical'||s.state==='warning'))continue;const col=CANAL[s.state][0];
   for(const l of s.line||[]){L.polyline(l,{pane:'mentions',color:'#fff',weight:s.state==='critical'?9:7,opacity:.9,interactive:false}).addTo(g);L.polyline(l,{pane:'mentions',color:col,weight:s.state==='critical'?5.5:4,opacity:s.state==='offline'?.5:.95}).addTo(g);}
   const m=L.circleMarker([s.lat,s.lng],{pane:'evidence',radius:s.state==='critical'?6.5:s.state==='warning'?5.5:4,color:'#fff',weight:1.6,fillColor:col,fillOpacity:s.state==='offline'?.6:1});
   m.bindPopup(()=>canalPopup(s0),{maxWidth:320});m.bindTooltip(`${s.name}: ${CANAL[s.state][1]}`,{direction:'top'});if(onClick)m.on('click',()=>onClick(s));m.addTo(g);}
  return g;
 }
 return {load,get data(){return data},PCT,CANAL,METHOD,pctColor,pctLabel,riverLayer,canalLayer,canalState,stationPopup,canalPopup,esc,time,f2,sign};
})();
