// Model layer for all domains from /live/model/latest.json.
// zoom < 12: each domain's frame painted into a lat/lng-aligned image (via /data/overview index rasters)
// zoom >= 12: at-grade road pieces of the visible 0.25 deg tiles, coloured by their cell's depth
let modelRun=null,paintToken=0,modelTimeTouched=false;
const floodGroup=typeof L!=='undefined'?L.layerGroup():null,roadRenderer=typeof L!=='undefined'?L.canvas({padding:.3,pane:'flood'}):null;
const frameCache=new Map(),overviewCache=new Map(),roadTileCache=new Map();
// Modeled cell-average depth bins (cm). Purple so flooded roads never read as rivers/canals (blue) or roads (orange).
const depthBins=[[2,10,'#e599f7',[229,153,247]],[10,30,'#cc5de8',[204,93,232]],[30,50,'#9c36b5',[156,54,181]],[50,Infinity,'#5f0f7a',[95,15,122]]];
const roadWeight=()=>{const z=map?.getZoom()??11;return z<=12?2:z<=13?2.5:z<=15?4:6;};
const binOf=d=>depthBins.findIndex(([lo,hi])=>d>=lo&&d<hi);
const liveDomains=()=>modelRun?.domains.filter(d=>!d.skipped)||[];
const scenarioIndex=()=>Math.max(0,modelRun.drainageScenariosMmH.map(String).indexOf($('f-scenario').value));
// Slider = hours back from each domain's latest hour, so domains with slightly different windows stay aligned.
function frameIndex(d){const back=Number($('f-time').max)-Number($('f-time').value);return Math.max(0,d.times.length-1-back);}
function lru(map,key,value,max){map.set(key,value);if(map.size>max)map.delete(map.keys().next().value);return value;}
async function depthFrame(d,k,i){const key=`${modelRun.runId}:${d}:${k}:${i}`;if(frameCache.has(key))return frameCache.get(key);return lru(frameCache,key,fetchBytes(`${modelRun.base}${d}-s${k}-f${i}.bin.gz`),24);}
// zoom <= 9 uses the 3x coarser overview (data saver); the full one from zoom 10
const loRes=()=>map.getZoom()<=9;
function overview(d,lo){const key=(lo?'lo:':'')+d;if(!overviewCache.has(key))overviewCache.set(key,fetchBytes(`/data/${lo?'overview-lo':'overview'}/${d}.bin.gz`).then(b=>new Uint32Array(b.buffer,b.byteOffset,b.byteLength/4)));return overviewCache.get(key);}
function roadTile(d,k){const key=d+k;if(!roadTileCache.has(key))lru(roadTileCache,key,fetchJson(`/data/model-roads/${d}/${k}.json.gz`).then(rows=>rows.map(p=>{let lat=p[1],lng=p[2];const pts=[[lat/1e5,lng/1e5]];for(let i=3;i<p.length;i+=2){lat+=p[i];lng+=p[i+1];pts.push([lat/1e5,lng/1e5]);}return {cell:p[0],pts};})),120);return roadTileCache.get(key);}
const domainInfo=id=>domainsInfo?.domains.find(x=>x.id===id);
const visibleDomains=()=>{const b=map.getBounds();return liveDomains().filter(d=>b.intersects([[d.bbox[1],d.bbox[0]],[d.bbox[3],d.bbox[2]]]));};

function describeModel(){
 const k=scenarioIndex(),mm=modelRun.drainageScenariosMmH[k],ref=visibleDomains()[0]||liveDomains()[0];if(!ref)return;
 const t=ref.times[frameIndex(ref)];$('f-time-label').textContent=`${thaiTime(t)} (${ref.name})`;
 $('map-chip').hidden=!$('f-model').checked;$('map-chip').textContent=`แบบจำลอง ${thaiTime(t)} • ระบาย ${mm} มม./ชม.`;
 const rows=[];for(const d of liveDomains()){const sc=d.scenarios[k],f=sc.frames[frameIndex(d)];for(const [p,km2] of Object.entries(f.provincesKm2))rows.push([p,km2,d]);}
 const tb=$('model-provinces');tb.replaceChildren();
 for(const [p,km2,d] of rows.sort((a,b)=>b[1]-a[1])){const tr=document.createElement('tr');for(const c of [p,km2.toLocaleString('th-TH',{maximumFractionDigits:1}),`${d.cellSizeM} ม.`,thaiTime(d.times[frameIndex(d)])]){const td=document.createElement('td');td.textContent=c;tr.append(td);}tb.append(tr);}
 const v=liveDomains().map(d=>[d,d.scenarios[k].validation]).filter(([,x])=>x?.positives),pct=x=>x==null?'–':Math.round(x*100)+'%';
 $('model-validation').textContent=v.length?'ความน่าเชื่อถือ (เทียบรายงานประชาชน/เซนเซอร์ในช่วงเวลาเดียวกัน): '+v.map(([d,x])=>`${d.name}: ${x.positives.toLocaleString('th-TH')} จุด แบบจำลองมีน้ำในระยะ ~1 เซลล์ ${pct(x.hitRate)} (สุ่ม ${pct(x.baseRate)})${x.negatives?` • เซนเซอร์แห้งแต่แบบจำลองเปียก ${pct(x.falseAlarmRate)}`:''}${d.bestScenario!=null?` • สมมติฐานที่ตรงที่สุด ${d.bestScenario} มม./ชม.`:''}`).join(' | '):'ยังไม่มีรายงานประชาชนหรือเซนเซอร์ในพื้นที่/ช่วงเวลาจำลองสำหรับตรวจสอบ';
 const skipped=modelRun.domains.filter(d=>d.skipped);
 $('model-balance').textContent=liveDomains().map(d=>`${d.name}: ฝนเฉลี่ยสะสม ${d.scenarios[k].rainMeanTotalMm.toFixed(0)} มม. ใน ${d.times.length} ชม. จาก ${d.rainStations.length} สถานี • น้ำไหลออกขอบพื้นที่ ${(d.scenarios[k].balance.boundaryOutflowM3/1e6).toFixed(1)} ล้าน ลบ.ม. • สมดุลน้ำคลาดเคลื่อน ${(d.scenarios[k].balance.relativeResidual*100).toExponential(0)}%`).join(' | ')+(skipped.length?' | ไม่ได้คำนวณ: '+skipped.map(d=>`${d.name} (${d.skipped})`).join(', '):'');
}
async function paintSimulation(){
 const token=++paintToken;if(!modelRun||!map)return;describeModel();
 if(!$('f-model').checked){floodGroup.clearLayers();return;}
 const k=scenarioIndex(),minCm=Number($('f-mindepth').value)||2,z=map.getZoom(),doms=visibleDomains(),layers=[];
 try{
  if(z<12){
   for(const d of doms){const info=domainInfo(d.id);if(!info)continue;const lo=loRes()&&!!info.overviewLo;const [idx,depth]=await Promise.all([overview(d.id,lo),depthFrame(d.id,k,frameIndex(d))]);if(token!==paintToken)return;
    const {width:W,height:H,bounds:[w,s,e,n]}=lo?info.overviewLo:info.overview,cv=document.createElement('canvas');cv.width=W;cv.height=H;const ctx=cv.getContext('2d'),img=ctx.createImageData(W,H),px=img.data;
    for(let p=0;p<idx.length;p++){const c=idx[p];if(c===0xFFFFFFFF)continue;const dv=depth[c];if(dv<minCm)continue;const [,,,[r,g,b]]=depthBins[binOf(dv)];const o=p*4;px[o]=r;px[o+1]=g;px[o+2]=b;px[o+3]=210;}
    ctx.putImageData(img,0,0);layers.push(L.imageOverlay(cv.toDataURL(),[[s,w],[n,e]],{pane:'flood',opacity:.85,interactive:false,className:'pixelated'}));}
  }else{
   const b=map.getBounds().pad(.1),bins=depthBins.map(()=>[]);
   for(const d of doms){const info=domainInfo(d.id);if(!info)continue;const avail=new Set(info.roadTiles),keys=[];
    for(let i=Math.floor(b.getSouth()/.25);i<=Math.floor(b.getNorth()/.25);i++)for(let j=Math.floor(b.getWest()/.25);j<=Math.floor(b.getEast()/.25);j++)if(avail.has(`${i}_${j}`))keys.push(`${i}_${j}`);
    const [depth,...tiles]=await Promise.all([depthFrame(d.id,k,frameIndex(d)),...keys.map(key=>roadTile(d.id,key))]);if(token!==paintToken)return;
    for(const pieces of tiles)for(const p of pieces){const dv=depth[p.cell];if(dv<minCm)continue;const q=p.pts[0];if(q[0]<b.getSouth()||q[0]>b.getNorth()||q[1]<b.getWest()||q[1]>b.getEast())continue;bins[binOf(dv)].push(p.pts);}}
   bins.forEach((lines,i)=>{if(lines.length)layers.push(L.polyline(lines,{renderer:roadRenderer,color:depthBins[i][2],weight:roadWeight(),opacity:.9,interactive:false,lineCap:'round'}));});
  }
  if(token!==paintToken)return;floodGroup.clearLayers();layers.forEach(l=>floodGroup.addLayer(l));floodGroup.addTo(map);
 }catch(err){$('model-job-status').textContent='วาดผลแบบจำลองไม่ได้: '+err.message;}
}
async function pollModel(){
 try{const run=await fetchJson('/live/model/latest.json',{cache:'no-cache'});
  if(modelRun?.runId!==run.runId){modelRun=run;const maxF=Math.max(1,...liveDomains().map(d=>d.times.length));$('f-time').max=maxF-1;if(!modelTimeTouched)$('f-time').value=maxF-1;$('model-results').hidden=false;paintSimulation();}
  $('model-job-status').textContent=`ผลล่าสุดคำนวณเมื่อ ${thaiTime(run.issuedAt)} (${ago(run.issuedAt)}) • รันใหม่ทุก 2 ชั่วโมง • ${liveDomains().length}/${run.domains.length} พื้นที่`;
 }catch(err){$('model-job-status').textContent='ยังไม่มีผลแบบจำลอง หรือโหลดไม่ได้';}
 setTimeout(pollModel,document.hidden?600000:300000);
}
$('f-time').oninput=()=>{modelTimeTouched=true;paintSimulation();};
onFilter(['f-model','f-scenario','f-mindepth'],paintSimulation);
if(map){let t;map.on('moveend',()=>{clearTimeout(t);t=setTimeout(paintSimulation,150);});}
document.addEventListener('domains',paintSimulation);
pollModel();
