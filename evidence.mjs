// Nationwide flood evidence from public sources, normalised to one shape and grouped by province.
// Kinds: citizen (Traffy Fondue), social (Bluesky), sensor (road flood sensors, heavy-rain gauges),
// official (dams, canal flow, canal levels, water gates), news (RSS). Each item may carry `geo`: named roads,
// sois, villages, canals, bridges or junctions resolved from its text (see named-match.mjs).
// Nothing is interpolated; every item keeps its own timestamp, source and location precision.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {buildNamedIndex,matchNamed} from './named-match.mjs';
import {normalize} from './model-inputs.mjs';
import {parseRss,stripTags,relevance,extractPlaces,extractDepth,extractFacts,redact,buildGazetteer,titleKey} from './evidence-text.mjs';

const TW='https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
const TRAFFY='https://publicapi.traffy.in.th/share/teamchadchart/search';
const UA={'User-Agent':'Mozilla/5.0 (thai-flood-watch prototype; +http://localhost)'};
const q=s=>encodeURIComponent(s);
const GNEWS=t=>`https://news.google.com/rss/search?q=${q(t+' when:3d')}&hl=th&gl=TH&ceid=TH:th`;
export const FEEDS=[
 {name:'มติชน',url:'https://www.matichon.co.th/feed'},{name:'ข่าวสด',url:'https://www.khaosod.co.th/feed'},{name:'ประชาชาติธุรกิจ',url:'https://www.prachachat.net/feed'},
 {name:'ไทยรัฐ',url:'https://www.thairath.co.th/rss/news'},{name:'เดลินิวส์',url:'https://www.dailynews.co.th/feed/'},
 {name:'Bangkok Post',url:'https://www.bangkokpost.com/rss/data/topstories.xml'},{name:'Bangkok Post',url:'https://www.bangkokpost.com/rss/data/thailand.xml'},
 ...['น้ำท่วม','น้ำป่า','อุทกภัย','น้ำท่วมขัง','ระบายน้ำ เขื่อน','ดินโคลนถล่ม'].map(t=>({name:'Google News: '+t,url:GNEWS(t),google:true})),
 {name:'Google News: Thailand flood',url:'https://news.google.com/rss/search?q=Thailand+flood+when:3d&hl=en-TH&gl=TH&ceid=TH:en',google:true},
];
const HOURS=72,TRAFFY_HOURS=24,ARTICLE_LIMIT=40;
const FLOOD_CITIZEN=/ท่วม|น้ำขัง|น้ำเอ่อ|ระบายน้ำไม่|น้ำล้น|รอการระบาย/;

async function get(url,type='json',timeout=25000){const r=await fetch(url,{headers:UA,signal:AbortSignal.timeout(timeout),redirect:'follow'});if(!r.ok)throw Error(`HTTP ${r.status} ${new URL(url).host}`);return type==='json'?r.json():r.text();}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;try{out[i]=await fn(items[i]);}catch{out[i]=null;}}}));return out;}
const bkkTime=s=>s?new Date(s.replace(' ','T')+'+07:00').toISOString():null;

// Traffy's public API is slow under load: small pages, one retry-free pass, and the last good pull is reused (with its age) on failure.
const TRAFFY_CACHE=new URL('./data/evidence/traffy-last-good.json',import.meta.url);
async function traffy(errors,idx){
 const cutoff=Date.now()-TRAFFY_HOURS*3600000,out=[];let complete=false;
 try{
  for(let page=0;page<40;page++){
   const d=await get(`${TRAFFY}?limit=250&offset=${page*250}`,'json',60000);const rows=d.results||[];
   for(const r of rows){const at=Date.parse((r.timestamp||'').replace(' ','T').replace(/\+00$/,'Z'));if(!(at>=cutoff))continue;const text=r.description||'';if(!FLOOD_CITIZEN.test(text))continue;
    const lng=Number(r.coords?.[0]),lat=Number(r.coords?.[1]);if(!(lat>=5&&lat<=21&&lng>=97&&lng<=106))continue;const depth=extractDepth(text)[0];
    out.push({id:'traffy:'+r.ticket_id,kind:'citizen',source:'Traffy Fondue (กทม.)',sourceUrl:'https://www.traffy.in.th/',lat,lng,precision:'point',at:new Date(at).toISOString(),title:redact(text).slice(0,160),address:r.address||'',province:/กรุงเทพ/.test(r.address||'')?'กรุงเทพฯ':(r.address||'').replace(/^.*จังหวัด/,'').trim()||null,depthCm:depth?.cm??null,depthEstimated:depth?.estimated??null,photo:/^https:\/\/storage\.googleapis\.com\/traffy_public_bucket\//.test(r.photo_url||'')?r.photo_url:null,status:r.state||null,ticket:r.ticket_id,geo:matchNamed(text,idx,{lat,lng})});}
   const oldest=Date.parse((rows.at(-1)?.timestamp||'').replace(' ','T').replace(/\+00$/,'Z'));if(rows.length<250||oldest<cutoff){complete=true;break;}
  }
 }catch(e){
  if(out.length)errors.push({source:'traffy',error:'ดึงได้บางส่วน: '+e.message});
  else{try{const last=JSON.parse(await readFile(TRAFFY_CACHE));errors.push({source:'traffy',error:`${e.message} • ใช้ข้อมูลที่ดึงสำเร็จล่าสุดเมื่อ ${last.fetchedAt}`});return last.items.map(i=>({...i,stale:true,fetchedAt:last.fetchedAt}));}catch{throw e;}}
 }
 if(out.length)await writeFile(TRAFFY_CACHE,JSON.stringify({fetchedAt:new Date().toISOString(),complete,items:out}));
 return out;
}

async function roadSensors(){
 const d=await get(TW+'flood_road');if(d.result!=='OK')throw Error('flood_road response');
 return d.data.filter(r=>r.floodroad_datetime&&Date.now()-Date.parse(bkkTime(r.floodroad_datetime))<48*3600000).map(r=>{const s=r.station||{};return {id:'floodroad:'+s.id,kind:'sensor',source:'สำนักการระบายน้ำ กทม. ผ่าน ThaiWater',sourceUrl:TW+'flood_road',lat:Number(s.floodroad_lat),lng:Number(s.floodroad_long),precision:'point',at:bkkTime(r.floodroad_datetime),title:'เซนเซอร์น้ำท่วมถนน '+(s.floodroad_name?.th||'').trim(),province:r.geocode?.province_name?.th==='กรุงเทพมหานคร'?'กรุงเทพฯ':r.geocode?.province_name?.th,depthCm:Number(r.floodroad_value)||0,depthEstimated:false};}).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lng));
}

async function heavyRain(){
 const all=normalize(await get(TW+'rain_24h'),'rain',[97,5,106,21]);
 // TMD classes: 35.1-90 mm/24h heavy, >90 very heavy
 return all.filter(s=>s.rain24hMm>35&&s.observedAt&&Date.now()-Date.parse(s.observedAt)<6*3600000).map(s=>({id:'rain:'+s.id,kind:'sensor',subkind:'rain',source:'สถานีฝน ThaiWater ('+(s.agency||'ไม่ระบุ')+')',sourceUrl:TW+'rain_24h',lat:s.lat,lng:s.lng,precision:'point',at:s.observedAt,title:`ฝน 24 ชม. ${s.rain24hMm} มม. (${s.rain24hMm>90?'หนักมาก':'หนัก'}) • ${s.name||''}`,rain24hMm:s.rain24hMm,province:null}));
}

async function dams(){
 const d=await get(TW+'thaiwater_main');const rows=d.dam?.data?.data||[];
 return rows.map(r=>({id:'dam:'+r.dam?.id,kind:'official',subkind:'dam',source:'กรมชลประทาน ผ่าน ThaiWater',sourceUrl:'https://www.thaiwater.net/',lat:Number(r.dam?.dam_lat),lng:Number(r.dam?.dam_long),precision:'point',at:r.dam_date?new Date(r.dam_date+'T07:00:00+07:00').toISOString():null,title:`เขื่อน${r.dam?.dam_name?.th||''} เก็บกัก ${r.dam_storage_percent??'?'}% • ไหลเข้า ${r.dam_inflow??'?'} • ระบาย ${r.dam_released??'?'} ล้าน ลบ.ม./วัน`,storagePercent:r.dam_storage_percent,inflowMcm:r.dam_inflow,releasedMcm:r.dam_released,spilledMcm:r.dam_spilled,province:null,daily:true})).filter(x=>Number.isFinite(x.lat));
}

// Drainage and water-control data from agencies (ThaiWater). Values keep their own units and timestamps.
const fresh=(t,h)=>t&&Date.now()-Date.parse(t)<h*3600000;
async function canalFlow(){
 const d=await get(TW+'flow');if(d.result!=='OK')throw Error('flow response');
 return d.data.map(r=>{const s=r.station||{},at=bkkTime(r.flow_datetime);return {id:'flow:'+s.id,kind:'official',subkind:'flow',source:(r.agency?.agency_name?.th||'ThaiWater')+' ผ่าน ThaiWater',sourceUrl:TW+'flow',lat:Number(s.flow_lat),lng:Number(s.flow_long),precision:'point',at,title:`อัตราการไหล ${s.flow_name?.th||''}: ${r.flow_value} ลบ.ม./วินาที`,flowM3s:Number(r.flow_value),province:r.geocode?.province_name?.th==='กรุงเทพมหานคร'?'กรุงเทพฯ':r.geocode?.province_name?.th};})
  .filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.flowM3s)&&fresh(x.at,24));
}
async function canalLevels(){
 return normalize(await get(TW+'canal_waterlevel'),'canal',[97,5,106,21]).filter(s=>s.levelRaw!==null&&fresh(s.observedAt,6)).map(s=>({id:'canal:'+s.id,kind:'official',subkind:'canal',source:(s.agency||'ThaiWater')+' ผ่าน ThaiWater',sourceUrl:TW+'canal_waterlevel',lat:s.lat,lng:s.lng,precision:'point',at:s.observedAt,title:`ระดับน้ำคลอง ${s.name||''}: ${s.levelRaw} ม.`,levelM:s.levelRaw,province:null}));
}
async function waterGates(){
 const d=await get(TW+'watergate_load');const rows=d.watergate_data?.data||[];
 return rows.map(r=>{const s=r.station||{},at=bkkTime(r.watergate_datetime_out||r.watergate_datetime_in);return {id:'gate:'+s.id,kind:'official',subkind:'gate',source:(r.agency?.agency_shortname?.th||'ThaiWater')+' ผ่าน ThaiWater',sourceUrl:TW+'watergate_load',lat:Number(s.tele_station_lat),lng:Number(s.tele_station_long),precision:'point',at,
  title:`${s.tele_station_name?.th||'ประตูระบายน้ำ'}: ระดับน้ำด้านใน ${r.watergate_in??'–'} • ด้านนอก ${r.watergate_out??'–'} ม.${r.pump_on!=null?` • เครื่องสูบเปิด ${r.pump_on}/${r.pump??'?'} เครื่อง`:''}${r.floodgate_open!=null?` • บานเปิด ${r.floodgate_open}/${r.floodgate??'?'}`:''}`,levelInM:r.watergate_in,levelOutM:r.watergate_out,pumpsOn:r.pump_on,pumps:r.pump,gatesOpen:r.floodgate_open,province:null};})
  .filter(x=>Number.isFinite(x.lat)&&fresh(x.at,6));
}
// Hourly rain for every fresh station: drawn as an intensity surface, not listed as evidence items.
async function rainRate(){
 return normalize(await get(TW+'rain_24h'),'rain',[97,5,106,21]).filter(s=>s.rain1hMm!==null&&s.rain1hMm>=0&&s.rain1hMm<300&&fresh(s.observedAt,2)).map(s=>[+s.lat.toFixed(4),+s.lng.toFixed(4),s.rain1hMm,s.rain24hMm??null]);
}

// Bangkok's official flood-alert page (now.bangkok.go.th/flood-alert.html). Its data are JS constants in the page:
// ROADS (roads where the BMA road sensors read water, with Google-traffic closure length), GEO (their segments)
// and REPORTS (district-office report file: level H/M/L, depth text, geometry matched to OSM by the BMA page).
const BMA_ALERT='https://now.bangkok.go.th/flood-alert.html';
const TH_MONTH={'ม.ค.':1,'ก.พ.':2,'มี.ค.':3,'เม.ย.':4,'พ.ค.':5,'มิ.ย.':6,'ก.ค.':7,'ส.ค.':8,'ก.ย.':9,'ต.ค.':10,'พ.ย.':11,'ธ.ค.':12};
// Read `const NAME = {...}` / `[...]` from page source: skips strings, drops comments and trailing commas, then JSON.parse.
export function jsConst(src,name){
 const m=src.match(new RegExp(`const ${name}\\s*=\\s*([\\[{])`));if(!m)return null;
 let i=m.index+m[0].length-1,depth=0,out='',q=null;
 for(;i<src.length;i++){const c=src[i];
  if(q){out+=c;if(c==='\\'){out+=src[++i];continue;}if(c===q)q=null;continue;}
  if(c==='"'||c==="'"){q=c;out+=c;continue;}
  if(c==='/'&&src[i+1]==='/'){while(i<src.length&&src[i]!=='\n')i++;continue;}
  out+=c;if(c==='['||c==='{')depth++;else if((c===']'||c==='}')&&--depth===0)break;}
 return JSON.parse(out.replace(/,\s*([}\]])/g,'$1'));
}
function thaiStamp(text){const m=text.match(/อัปเดต\s*(\d{1,2}):(\d{2})\s*น\.\s*(\d{1,2})\s*([ก-๙.]+)\s*(\d{4})/);if(!m||!TH_MONTH[m[4]])return null;const y=+m[5]-543,pad=n=>String(n).padStart(2,'0');return new Date(`${y}-${pad(TH_MONTH[m[4]])}-${pad(m[3])}T${pad(m[1])}:${m[2]}:00+07:00`).toISOString();}
// [lat,lng] | [[lat,lng],...] | [[[lat,lng],...],...] -> list of lines
function asLines(g){if(!Array.isArray(g)||!g.length)return [];if(typeof g[0]==='number')return [[g]];if(typeof g[0][0]==='number')return [g];return g.filter(l=>Array.isArray(l)&&Array.isArray(l[0]));}
// The BMA server only answers from Thai networks; elsewhere (GitHub runners) the last good pull is reused, with its time.
const BMA_CACHE=new URL('./data/evidence/bma-last-good.json',import.meta.url);
async function bmaWithFallback(g,idx,errors){
 try{const items=await bmaFloodAlert(g,idx);if(items.length){await mkdir(new URL('./data/evidence/',import.meta.url),{recursive:true});await writeFile(BMA_CACHE,JSON.stringify({fetchedAt:new Date().toISOString(),items}));}return items;}
 catch(e){try{const last=JSON.parse(await readFile(BMA_CACHE));errors.push({source:'bmaAlert',error:`${e.message} (เว็บ กทม. เข้าได้จากเครือข่ายในไทยเท่านั้น) • ใช้ข้อมูลที่ดึงสำเร็จล่าสุดเมื่อ ${last.fetchedAt}`});return last.items.map(i=>({...i,stale:true,fetchedAt:last.fetchedAt}));}catch{throw e;}}
}
export async function bmaFloodAlert(g,idx){
 const html=await get(BMA_ALERT,'text',30000);const at=thaiStamp(html.replace(/<[^>]+>/g,' '));
 const roads=jsConst(html,'ROADS')||[],geo=jsConst(html,'GEO')||{},rep=jsConst(html,'REPORTS')||{items:[]};
 const ROAD_LEVEL={R:'น้ำสูงเกิน 15 ซม.',r:'10–15 ซม.',a:'5–10 ซม.'},REP_LEVEL={H:'หนัก',M:'ปานกลาง',L:'เล็กน้อย'};
 const out=[];
 for(const r of roads){const lines=geo[r.n]||[];const p=lines[0]?.[0]||null;
  out.push({id:'bma-road:'+r.n,kind:'official',subkind:'bma-road',source:'ระบบตรวจวัดน้ำท่วมถนน กทม. (now.bangkok.go.th)',sourceUrl:BMA_ALERT,at,province:'กรุงเทพฯ',lat:p?.[0]??null,lng:p?.[1]??null,precision:'point',
   title:`${r.n}: น้ำ ${r.m} ซม. (${ROAD_LEVEL[r.l]||r.l}) • เขต${r.d}`,detail:r.s,level:r.l,depthCm:r.m,closedM:r.g||0,
   sensors:(r.k||[]).map(k=>({code:k[0],where:k[1],cm:k[2],maxCm:k[4],segment:k[6]})),lines});}
 const repAt=rep.time&&at?new Date(at.slice(0,11)+rep.time+':00+07:00').toISOString():at;
 // Reports the BMA page could not place (g=null): try our OSM name matcher within the district, else the district centre.
 const district=name=>(g?.districtsByName.get(name)||[]).find(p=>p.province==='กรุงเทพฯ');
 (rep.items||[]).forEach((x,n)=>{let lines=asLines(x.g),p=lines[0]?.[0]||null,matched=null;const dc=district(x.d);
  // "ซอยย่อย ถ.X (ถนนหลักไม่ท่วม)" means side streets, not road X itself: never draw the named road for these
  const sideStreets=/ซอยย่อย|ซอยแยก|สายรอง|ทั้งหมด|ไม่ท่วม/.test(x.n+' '+(x.seg||''));
  if(!p&&dc&&idx&&!sideStreets){matched=matchNamed(`${x.n.replace(/^ปาก/,'')} ${x.seg||''}`,idx,{places:[{province:'กรุงเทพฯ',short:x.d,lat:dc.lat,lng:dc.lng,precision:'district'}]}).find(m=>m.drawn);if(matched){lines=matched.lines;p=lines[0]?.[Math.floor(lines[0].length/2)]||[matched.lat,matched.lng];}}
  if(!p&&dc)p=[dc.lat,dc.lng];
  out.push({id:`bma-report:${n}:${x.n}`,kind:'official',subkind:'bma-report',source:`รายงานสำนักงานเขต กทม. (${rep.file||'ไฟล์สรุป'})`,sourceUrl:BMA_ALERT,at:repAt,province:'กรุงเทพฯ',lat:p?.[0]??null,lng:p?.[1]??null,precision:(x.u||(!x.g&&!matched))?'district':'point',
   title:`${x.n}${x.seg?` (${x.seg})`:''} • เขต${x.d} • ระดับ${REP_LEVEL[x.lv]||x.lv}`,depthText:x.w,level:x.lv,approximate:!!x.u||!x.g,placedBy:x.g?'bma':matched?'osm-name':'district-centre',geomKind:x.k,lines:x.k==='point'?[]:lines});});
 return out;
}

// Social: Bluesky public search (no key). X, Facebook, Instagram and TikTok have no public search API;
// their posts only arrive indirectly (e.g. outlets' Facebook posts surfacing in Google News).
const BSKY='https://api.bsky.app/xrpc/app.bsky.feed.searchPosts';
async function bluesky(g,idx,errors){
 const seen=new Map(),cutoff=Date.now()-HOURS*3600000;
 for(const term of ['น้ำท่วม','ท่วมขัง','น้ำขัง','น้ำป่า','ระดับน้ำ','flood bangkok','flood thailand']){
  try{const d=await get(`${BSKY}?q=${q(term)}&limit=100&sort=latest`);
   for(const p of d.posts||[]){const text=p.record?.text||'',at=p.record?.createdAt||p.indexedAt;if(seen.has(p.uri)||!(Date.parse(at)>=cutoff)||!relevance(text).relevant)continue;
    const rkey=p.uri.split('/').pop(),places=extractPlaces(text,g),depth=extractDepth(text)[0];
    const img=(p.embed?.images||p.embed?.media?.images||[]).map(i=>i.thumb).find(u=>/^https:\/\/cdn\.bsky\.app\//.test(u||''));
    seen.set(p.uri,{id:'bsky:'+rkey,kind:'social',source:`Bluesky @${p.author?.handle||''}`,author:p.author?.displayName||p.author?.handle||'',sourceUrl:`https://bsky.app/profile/${p.author?.handle}/post/${rkey}`,at:new Date(at).toISOString(),title:redact(text).slice(0,200),places,precision:places[0]?.precision||null,lat:places[0]?.lat??null,lng:places[0]?.lng??null,province:places[0]?.province??null,depthCm:depth?.cm??null,depthEstimated:depth?.estimated??null,facts:extractFacts(text),photo:img||null,geo:matchNamed(text,idx,{places})});}  // social: keyword-anchored names only (no free scan of chatty posts)
  }catch(e){errors.push({source:'bluesky:'+term,error:e.message});}
 }
 return [...seen.values()];
}

let named;
async function namedIndex(){
 if(named!==undefined)return named;
 try{named=buildNamedIndex(JSON.parse(gunzipSync(await readFile(new URL('./data/named/named.json.gz',import.meta.url)))).features);}catch{named=null;}
 return named;
}

const articleCache=new Map();
async function article(url){
 const hit=articleCache.get(url);if(hit&&Date.now()-hit.at<6*3600000)return hit.text;
 const html=await get(url,'text',15000);
 const og=(html.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)/i)||[])[1]||'';
 const body=[...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m=>stripTags(m[1])).filter(t=>t.length>40).join(' ').slice(0,8000);
 const text=stripTags(og)+' '+body;articleCache.set(url,{at:Date.now(),text});return text;
}

async function news(g,errors,idx){
 const lists=await mapLimit(FEEDS,4,async f=>{try{return parseRss(await get(f.url,'text'),f);}catch(e){errors.push({source:f.name,error:e.message});return [];}});
 const cutoff=Date.now()-HOURS*3600000,seen=new Map();
 for(const item of lists.flat()){if(!item?.publishedAt||Date.parse(item.publishedAt)<cutoff)continue;const text=item.title+' '+item.summary;const rel=relevance(text);if(!rel.relevant)continue;
  const key=titleKey(item.title);const prev=seen.get(key);
  if(prev){prev.alsoIn=[...new Set([...(prev.alsoIn||[]),item.publisher])].filter(p=>p!==prev.publisher);continue;}
  seen.set(key,{...item,score:rel.score});}
 const items=[...seen.values()].sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
 // Detail pass: read the article page of direct-outlet items (Google links are redirects) for places, depths, figures.
 const direct=items.filter(i=>!i.via).slice(0,ARTICLE_LIMIT);
 const bodies=await mapLimit(direct,3,i=>article(i.link));direct.forEach((i,n)=>{i.body=bodies[n]||'';i.articleRead=!!bodies[n];});
 return items.map(i=>{const text=`${i.title} ${i.summary} ${i.body||''}`;const places=extractPlaces(text,g),depth=extractDepth(text);
  return {id:'news:'+titleKey(i.title),kind:'news',source:i.publisher,via:i.via,feed:i.feed,sourceUrl:i.link,at:i.publishedAt,title:i.title,excerpt:(i.summary||stripTags(i.body||'')).slice(0,280),places,precision:places[0]?.precision||null,lat:places[0]?.lat??null,lng:places[0]?.lng??null,province:places[0]?.province??null,depthCm:depth.length?Math.max(...depth.map(d=>d.cm)):null,depthEstimated:depth.length?depth.every(d=>d.estimated):null,depthPhrases:depth.map(d=>d.phrase).slice(0,3),facts:extractFacts(text),alsoIn:i.alsoIn||[],articleRead:!!i.articleRead,relevance:i.score,geo:matchNamed(text,idx,{places,bareScan:true})};});
}

function nearestProvince(g,lat,lng){let best=null,d=Infinity;for(const p of g.provinces){const e=(p.lat-lat)**2+((p.lng-lng)*Math.cos(lat*Math.PI/180))**2;if(e<d){d=e;best=p;}}return best?.short||null;}

export function summarise(items,g){
 const by=new Map();
 const add=(prov,item)=>{if(!prov)return;const p=g.byProvince.get(prov);if(!p)return;if(!by.has(prov))by.set(prov,{province:prov,lat:p.lat,lng:p.lng,counts:{citizen:0,social:0,sensor:0,rain:0,news:0,official:0},latestAt:null,maxDepthCm:null,headlines:[]});const s=by.get(prov);
  const k=item.subkind==='rain'?'rain':item.kind;s.counts[k]++;if(!s.latestAt||item.at>s.latestAt)s.latestAt=item.at;
  // max depth only from measured road sensors; free-text depths (reports, news) stay on the item itself
  if(item.kind==='sensor'&&!item.subkind&&item.depthCm>0&&(s.maxDepthCm===null||item.depthCm>s.maxDepthCm))s.maxDepthCm=item.depthCm;
  if(item.kind==='news'&&s.headlines.length<4)s.headlines.push({title:item.title,url:item.sourceUrl,source:item.source,at:item.at});};
 for(const it of items){if(it.kind==='news'||it.kind==='social'){for(const prov of new Set(it.places.map(p=>p.province)))add(prov,it);}else if(it.subkind!=='dam')add(it.province||nearestProvince(g,it.lat,it.lng),it);}
 return [...by.values()].map(s=>({...s,evidence:s.counts.citizen+s.counts.news+s.counts.social+(s.counts.sensor?1:0)+(s.counts.rain?1:0)})).sort((a,b)=>b.evidence-a.evidence);
}

let cache,pending,gaz;
const LATEST=new URL('./data/evidence/latest.json',import.meta.url);
// Stale-while-revalidate: a full pull takes minutes (Traffy paging, article reads), so older data is served with its fetch time while a refresh runs.
export async function getEvidence({wait=false}={}){
 if(cache&&Date.now()-Date.parse(cache.fetchedAt)<600000)return cache;
 if(!cache){try{gaz??=buildGazetteer(JSON.parse(await readFile(new URL('./data/gazetteer/th-admin.json',import.meta.url))).places);cache=JSON.parse(await readFile(LATEST));cache.provinces=summarise(cache.items,gaz);}catch{}}
 const job=pending||refresh();job.catch(()=>{});  // background refresh failures are reported via errors on the next call, never as an unhandled rejection
 if(cache&&!wait)return {...cache,refreshing:true};
 return job;
}
function refresh(){
 pending=(async()=>{
  gaz??=buildGazetteer(JSON.parse(await readFile(new URL('./data/gazetteer/th-admin.json',import.meta.url))).places);
  const errors=[],fetchedAt=new Date().toISOString(),idx=await namedIndex();
  if(!idx)errors.push({source:'named',error:'ยังไม่มีฐานชื่อถนน/หมู่บ้าน (รัน model/build_static.py)'});
  const tasks={bmaAlert:()=>bmaWithFallback(gaz,idx,errors),traffy:()=>traffy(errors,idx),roadSensors,heavyRain,dams,canalFlow,canalLevels,waterGates,social:()=>bluesky(gaz,idx,errors),news:()=>news(gaz,errors,idx)};
  const results=await Promise.allSettled(Object.values(tasks).map(f=>f()));const sources={};const items=[];
  Object.keys(tasks).forEach((name,i)=>{const r=results[i];if(r.status==='fulfilled'){items.push(...r.value);sources[name]={ok:true,count:r.value.length};}else{sources[name]={ok:false,count:0,error:r.reason.message};errors.push({source:name,error:r.reason.message});}});
  let rain=[];try{rain=await rainRate();sources.rainRate={ok:true,count:rain.length};}catch(e){sources.rainRate={ok:false,count:0,error:e.message};errors.push({source:'rainRate',error:e.message});}
  const out={fetchedAt,windowHours:{news:HOURS,social:HOURS,citizen:TRAFFY_HOURS,roadSensors:48},sources,errors,provinces:summarise(items,gaz),items,rainRate:{fields:['lat','lng','mm1h','mm24h'],stations:rain},
   notes:['รายงานประชาชน (Traffy) เป็นเรื่องร้องเรียน ไม่ได้ตรวจสอบภาคสนาม และครอบคลุมกรุงเทพฯ เป็นหลัก','ข่าวถูกจัดตำแหน่งจากชื่อสถานที่ในข้อความ ละเอียดสุดระดับตำบล/แขวง ไม่ใช่จุดเกิดเหตุจริง','ความลึกจากข่าว/รายงานเป็นตัวเลขที่ผู้เขียนระบุ หรือประมาณจากคำอย่าง "ระดับเข่า" (ทำเครื่องหมายว่าประมาณ)','เซนเซอร์ถนนและเขื่อนอาจล่าช้า ดูเวลาของแต่ละรายการ','ชื่อถนน/ซอย/หมู่บ้านถูกจับคู่กับ OSM เฉพาะเมื่อบริบทชัดเจน ถนนยาวถูกตัดเฉพาะช่วงใกล้พื้นที่ที่ระบุ','โซเชียล: Bluesky เท่านั้น (X, Facebook, Instagram, TikTok ไม่มี API ค้นหาสาธารณะ)','ถนนน้ำท่วมทางการของ กทม. มาจาก now.bangkok.go.th (จุดวัด + รายงานสำนักงานเขต) อัปเดตตามรอบของ กทม.','อัตราการสูบของสถานีสูบน้ำไม่มีข้อมูลสาธารณะ แสดงเฉพาะอัตราการไหลในคลองและระดับน้ำประตูระบายน้ำ']};
  await mkdir(new URL('./data/evidence/',import.meta.url),{recursive:true});await writeFile(new URL('./data/evidence/latest.json',import.meta.url),JSON.stringify(out));
  cache=out;return out;})().finally(()=>{pending=null;});
 return pending;
}
