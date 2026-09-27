import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {getWater} from './live-water.mjs';
const root=new URL('./data/observations/',import.meta.url);
const base='https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const time=v=>/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v||'')?v.replace(' ','T')+'+07:00':null;
// Distance (km) from central Bangkok; used only to order stations for display.
const CENTER={lat:13.7563,lng:100.5018};
export function distance(s){const rad=x=>x*Math.PI/180;const a=rad(s.lat-CENTER.lat),b=rad(s.lng-CENTER.lng);return 12742.0176*Math.asin(Math.sqrt(Math.sin(a/2)**2+Math.cos(rad(CENTER.lat))*Math.cos(rad(s.lat))*Math.sin(b/2)**2));}
export function normalize(data,kind,bbox=DEFAULT_BBOX){if(data.result!=='OK'||!Array.isArray(data.data))throw Error('Unexpected '+kind+' response');return data.data.map(r=>{const s=r.station||{};return {id:s.id,name:kind==='rain'?s.tele_station_name?.th:s.canal_name?.th,lat:num(kind==='rain'?s.tele_station_lat:s.canal_lat),lng:num(kind==='rain'?s.tele_station_long:s.canal_long),observedAt:time(kind==='rain'?r.rainfall_datetime:r.canal_datetime),rain1hMm:kind==='rain'?num(r.rain_1h):undefined,rain24hMm:kind==='rain'?num(r.rain_24h):undefined,levelRaw:kind==='canal'?num(r.canal_value):undefined,agency:r.agency?.agency_name?.th||'',source:base+(kind==='rain'?'rain_24h':'canal_waterlevel')};}).filter(s=>s.lat!==null&&s.lng!==null&&inBox(s,bbox,PAD)).map(s=>({...s,distanceKm:distance(s)})).sort((a,b)=>a.distanceKm-b.distanceKm);}
async function fetchData(path){const res=await fetch(base+path,{signal:AbortSignal.timeout(25000)});if(!res.ok)throw Error('HTTP '+res.status);return res.json();}
// Stations are kept inside the model domains plus ~16 km, so rain at the edges is interpolated rather than extrapolated.
const DEFAULT_BBOX=[100.3165,13.4669,100.9495,13.9663],PAD=.15;
const inBox=(s,[w,so,e,n],pad)=>s.lat>=so-pad&&s.lat<=n+pad&&s.lng>=w-pad&&s.lng<=e+pad;
// One fresh station per ~9 km bucket, at most 16 per domain, so the rain field covers each domain instead of clustering downtown.
export function spreadStations(rain,bbox,now=Date.now()){const seen=new Set(),out=[];for(const s of rain){if(!inBox(s,bbox,.05)||s.rain1hMm===null||s.rain1hMm<0)continue;const age=now-Date.parse(s.observedAt);if(!(age>=-300000&&age<=3*3600000))continue;const key=Math.floor(s.lat/.08)+':'+Math.floor(s.lng/.08);if(seen.has(key))continue;seen.add(key);out.push(s);if(out.length===16)break;}return out;}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;try{out[i]={status:'fulfilled',value:await fn(items[i])};}catch(reason){out[i]={status:'rejected',reason};}}}));return out;}
let cached,pending;
// archive=true (model runs only) also keeps timestamped raw/normalised copies; public page loads just refresh latest.json.
export async function modelInputs({archive=false}={}){if(cached&&Date.now()-Date.parse(cached.fetchedAt)<120000)return cached;if(pending)return pending;
 pending=(async()=>{const domains=await domainMetadata(),bbox=unionBbox(domains.map(d=>d.bbox));const raw=await Promise.allSettled([fetchData('rain_24h'),fetchData('canal_waterlevel'),getWater()]);const bundle={fetchedAt:new Date().toISOString(),rain:[],canal:[],river:[],errors:[],nowcastReady:false,missing:['DTM/ระดับถนนและ datum ที่ตรวจสอบแล้ว','เครือข่ายท่อ หน้าตัดคลอง และจุดเชื่อมทางน้ำ','ประวัติฝนก่อนเหตุการณ์และสภาพน้ำเริ่มต้น','สถานะปั๊ม ประตู และอัตราการปล่อยน้ำที่เชื่อมถึงพื้นที่','การสอบเทียบและทดสอบกับเหตุการณ์อิสระ']};
 for(let i=0;i<raw.length;i++){const name=['rain','canal','river'][i];if(raw[i].status==='rejected'){bundle.errors.push({source:name,error:raw[i].reason.message});continue;}try{bundle[name]=i<2?normalize(raw[i].value,name,bbox):raw[i].value.stations.filter(s=>inBox(s,bbox,PAD)).map(s=>({...s,distanceKm:distance(s)})).sort((a,b)=>a.distanceKm-b.distanceKm);}catch(err){bundle.errors.push({source:name,error:err.message});}}
 bundle.rainHistory=[];
 bundle.domainBbox=bbox;const ids=new Set(),candidates=[];for(const d of domains)for(const st of spreadStations(bundle.rain,d.bbox))if(!ids.has(st.id)){ids.add(st.id);candidates.push(st);}
 const histories=await mapLimit(candidates,4,s=>fetchData('rain_24h_graph?station_id='+encodeURIComponent(s.id)));
 for(let i=0;i<histories.length;i++){const h=histories[i];if(h.status==='fulfilled'&&h.value.result==='OK'&&Array.isArray(h.value.data)){bundle.rainHistory.push({...candidates[i],samples:h.value.data.map(r=>({observedAt:time(r.rainfall_datetime),mm:num(r.rainfall_value)}))});}else bundle.errors.push({source:'rain_history',error:'Unable to load history for station '+candidates[i].id});}
 bundle.riverGauges=await riverGauges(domains).catch(err=>{bundle.errors.push({source:'river_gauges',error:err.message});return [];});
 bundle.canalLimits=raw[1].status==='fulfilled'?canalLimits(raw[1].value,bbox):[];
 bundle.waterwayLimits=await fetchData('waterlevel_load').then(d=>waterwayLimits(d,bbox)).catch(err=>{bundle.errors.push({source:'waterway_limits',error:err.message});return [];});
 await mkdir(root,{recursive:true});const stamp=bundle.fetchedAt.replace(/[:.]/g,'-');const rawJson=JSON.stringify({feeds:raw.map(r=>r.status==='fulfilled'?r.value:{error:r.reason.message}),histories:histories.map(r=>r.status==='fulfilled'?r.value:{error:r.reason.message})});bundle.rawSha256=createHash('sha256').update(rawJson).digest('hex');if(archive){await writeFile(new URL(stamp+'-raw.json',root),rawJson);await writeFile(new URL(stamp+'-normalized.json',root),JSON.stringify(bundle));}await writeFile(new URL('latest.json',root),JSON.stringify(bundle));cached=bundle;return bundle;})();
 try{return await pending;}finally{pending=null;}
}
// BMA canal levels with their control thresholds (ThaiWater canal_waterlevel: m MSL; warning_level, critical_level =
// BMA control level, bank). Only readings from the last 3 h. run.py turns them into how much a district can drain.
export function canalLimits(data,bbox,now=Date.now()){
 const out=[];
 for(const r of data?.data||[]){const s=r.station||{},v=wlNum(r.canal_value),crit=wlNum(s.critical_level),warn=wlNum(s.warning_level),bank=wlNum(s.bank);
  const lat=wlNum(s.canal_lat),lng=wlNum(s.canal_long),at=time(r.canal_datetime);
  if(v===null||crit===null||lat===null||lng===null||!at||!(now-Date.parse(at)<=3*3600000))continue;
  if(!inBox({lat,lng},bbox,PAD))continue;
  out.push({id:s.id,name:s.canal_name?.th||'',lat,lng,at,levelM:v,warningM:warn,criticalM:crit,bankM:bank});}
 return out;}
// Rivers/canals outside the BMA network (ThaiWater waterlevel_load: storage_percent = level as % of bank height),
// last 3 h. Used for provinces without BMA canal data: a nearly full waterway means the land around it drains poorly.
export function waterwayLimits(data,bbox,now=Date.now()){
 const out=[];
 for(const r of data?.waterlevel_data?.data||[]){const st=r.station||{},lat=wlNum(st.tele_station_lat),lng=wlNum(st.tele_station_long),pct=wlNum(r.storage_percent),at=time(r.waterlevel_datetime);
  if(lat===null||lng===null||pct===null||!at||!(now-Date.parse(at)<=3*3600000)||!inBox({lat,lng},bbox,PAD))continue;
  out.push({id:st.id,code:st.tele_station_oldcode||'',name:st.tele_station_name?.th||'',lat,lng,at,fullPct:pct});}
 return out;}
// Water-level gauges along modelled rivers (ThaiWater waterlevel_load: level m MSL, bank levels, discharge) with their
// hourly history (waterlevel_graph). Python keeps only those next to the river channel.
const wlNum=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
async function riverGauges(domains){
 const cfg=JSON.parse(await readFile(new URL('./model/domains.json',import.meta.url))).domains.filter(d=>d.river);if(!cfg.length)return [];
 const rows=(await fetchData('waterlevel_load')).waterlevel_data?.data||[],out=[];
 for(const c of cfg){const meta=domains.find(m=>m.id===c.id);if(!meta)continue;const [w,s,e,n]=meta.bbox,re=new RegExp(c.river.gaugeCodes);
  const pick=rows.filter(r=>{const st=r.station||{},lat=wlNum(st.tele_station_lat),lng=wlNum(st.tele_station_long);return re.test(st.tele_station_oldcode||'')&&lat>=s&&lat<=n&&lng>=w&&lng<=e;});
  const hist=await mapLimit(pick,4,r=>fetchData('waterlevel_graph?station_type=tele_waterlevel&station_id='+encodeURIComponent(r.station.id)));
  pick.forEach((r,i)=>{const st=r.station,g=hist[i].status==='fulfilled'?hist[i].value?.data?.graph_data||[]:[];
   out.push({domain:c.id,code:st.tele_station_oldcode,name:st.tele_station_name?.th||'',lat:wlNum(st.tele_station_lat),lng:wlNum(st.tele_station_long),agency:r.agency?.agency_shortname?.th||'',
    bankM:wlNum(st.min_bank)??Math.min(...[wlNum(st.left_bank),wlNum(st.right_bank)].filter(v=>v!==null)),groundM:wlNum(st.ground_level),
    series:g.map(x=>({at:time(x.datetime),wl:wlNum(x.value),q:wlNum(x.discharge)})).filter(x=>x.at&&(x.wl!==null||x.q!==null))});});
 }
 return out;
}

// Model domains prepared by model/prepare_terrain.py (data/domains/<id>/metadata.json).
export async function domainMetadata(){const list=JSON.parse(await readFile(new URL('./model/domains.json',import.meta.url))).domains;const out=[];for(const d of list){try{out.push(JSON.parse(await readFile(new URL(`./data/domains/${d.id}/metadata.json`,import.meta.url))));}catch{}}return out;}
const unionBbox=bs=>bs.length?[Math.min(...bs.map(b=>b[0])),Math.min(...bs.map(b=>b[1])),Math.max(...bs.map(b=>b[2])),Math.max(...bs.map(b=>b[3]))]:DEFAULT_BBOX;
export async function terrainMetadata(){const d=await domainMetadata();return d.length?{bbox:unionBbox(d.map(x=>x.bbox)),domains:d.map(x=>({id:x.id,shape:x.shape,cellSizeM:x.cellSizeM}))}:null;}
