// River forecast for the next 12/24/36 h at ThaiWater water-level stations in the central, western and eastern basins,
// plus dam releases, Bangkok canal status and a rain outlook. Output: public/live/forecast.json.
// Methods (named per station in the output, never mixed silently):
//  flow    – stations with discharge: an upstream flow change arrives after a travel time (Chao Phraya Dam release plan
//            at C.13, Pa Sak Dam plan at S.9, measured flow further down); level read off the station's own recent
//            level–discharge pairs.
//  regress – level = a + b·(upstream flow, lagged) [+ tide harmonics where the river is tidal], fitted on the last 10 days.
//  trend   – everything else: slope of the last 6 h, damped (e-folding 12 h); tidal stations keep their tide harmonics.
// Every station is also hindcast from 36 h ago (upstream flows as measured) and its mean absolute error is published.
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';

const TW='https://api-v3.thaiwater.net/api/v1/thaiwater30/public/';
const UA={'User-Agent':'Mozilla/5.0 (thai-flood-watch prototype)'};
export const HORIZONS=[12,24,36];
const HIST_H=240,AHEAD=36,BOX=[98.4,12.4,102.6,16.6],MIN_PCT=60,MAX_STATIONS=170,HINDCAST=36;
const PLANS=new URL('./forecast-plans.json',import.meta.url);
const ALWAYS_PROV=/^(กรุงเทพมหานคร|นนทบุรี|ปทุมธานี|พระนครศรีอยุธยา|สมุทรปราการ|นครปฐม)$/;

async function get(url,timeout=30000){const r=await fetch(url,{headers:UA,signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error(`HTTP ${r.status} ${new URL(url).host}`);return r.json();}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;try{out[i]=await fn(items[i]);}catch{out[i]=null;}}}));return out;}
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const bkk=s=>Date.parse(String(s).replace(' ','T')+'+07:00');
const kmBetween=(a,b)=>{const r=Math.PI/180,x=(b[1]-a[1])*r*Math.cos((a[0]+b[0])/2*r),y=(b[0]-a[0])*r;return 6371*Math.hypot(x,y);};
const round=(v,d=2)=>v==null||!Number.isFinite(v)?null:+v.toFixed(d);

// Upstream drivers. Stations with discharge on these reaches are routed (flow); the rest regress on the summed flow.
// Order matters: a station's drivers are forecast before it.
const FLOW={
 'C.13':{dam:'chaophraya'},
 'C.3':{up:['C.13'],lag:[3,16]},'HDA006':{up:['C.13'],lag:[3,16]},'C.7A':{up:['C.13'],lag:[6,24]},
 'S.9':{dam:'pasak'},'S.26':{up:['S.9'],lag:[6,30]},
 'C.35':{up:['C.7A'],lag:[6,30]},'C.36':{up:['C.7A'],lag:[4,24]},'C.37':{up:['C.7A'],lag:[4,24]},
};
// Which summed flow a level-only station regresses on, and the physically plausible travel time (h), by basin and
// latitude. A lower bound keeps the fit from pairing two rivers that merely rose together.
function driversFor(s){
 const b=s.basin||'';
 if(/^(คลอง|ค\.|ปตร|ทรบ|สถานีสูบ|ประตูระบาย)/.test(s.name))return {up:[],lag:null};  // canals and gates follow rain, pumps and gate operation
 if(/ป่าสัก/.test(b))return s.lat>=14.6?{up:['S.9'],lag:[0,24]}:{up:['S.26'],lag:[0,18]};
 if(/เจ้าพระยา/.test(b))return s.lat>=14.45?{up:['C.13'],lag:[0,30]}:s.lat>=14.15?{up:['C.7A','S.26'],lag:[0,24]}:{up:['C.7A','S.26'],lag:[12,48]};
 if(/ท่าจีน/.test(b))return {up:['C.13'],lag:[12,48]};
 return {up:[],lag:null};
}

// --- small linear algebra: ridge least squares -------------------------------------------------------------
function lstsq(X,y,ridge=1e-6){
 const n=X[0].length,A=Array.from({length:n},()=>new Array(n).fill(0)),v=new Array(n).fill(0);
 for(let r=0;r<X.length;r++){const x=X[r];for(let i=0;i<n;i++){v[i]+=x[i]*y[r];for(let j=0;j<n;j++)A[i][j]+=x[i]*x[j];}}
 for(let i=1;i<n;i++)A[i][i]+=ridge*X.length;  // no penalty on the intercept
 for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(A[r][c])>Math.abs(A[p][c]))p=r;[A[c],A[p]]=[A[p],A[c]];[v[c],v[p]]=[v[p],v[c]];
  if(Math.abs(A[c][c])<1e-12)return null;for(let r=0;r<n;r++){if(r===c)continue;const f=A[r][c]/A[c][c];for(let k=c;k<n;k++)A[r][k]-=f*A[c][k];v[r]-=f*v[c];}}
 return v.map((x,i)=>x/A[i][i]);
}
const TIDE=[1/12.4206,1/23.9345,1/25.8193,2/12.4206];  // M2, K1, O1, M4 (cycles/hour); S2 is not separable in 10 days
const tideRow=h=>TIDE.flatMap(f=>[Math.cos(2*Math.PI*f*h),Math.sin(2*Math.PI*f*h)]);

// --- series ---------------------------------------------------------------------------------------------------
// Hourly grid shared by all stations: index 0 = HIST_H hours ago, NOW = the current hour, NOW+AHEAD = end of forecast.
function grid(now){const base=Math.floor(now/3600000)-HIST_H;return {base,NOW:HIST_H,N:HIST_H+AHEAD+1,idx:t=>Math.floor(t/3600000)-base,time:i=>new Date((base+i)*3600000).toISOString()};}
function toSeries(g,graph,field){
 const a=new Array(g.N).fill(null);
 for(const p of graph||[]){const v=num(p[field]);if(v===null)continue;const i=g.idx(bkk(p.datetime));if(i>=0&&i<=g.NOW)a[i]=v;}
 // sensor dropouts/spikes (e.g. a reading at the river bed between normal readings): > 1 m (levels) or 30 % (flows)
 // away from the median of the surrounding ±12 h (flows ±3 h) are removed; dropouts can last several hours
 // long dropouts: a level jump > 2.5 m that comes back to within 0.5 m of the level before it within 48 h
 if(field==='value')for(let i=1,prev=null;i<=g.NOW;i++){if(a[i]===null)continue;if(prev!==null&&Math.abs(a[i]-prev)>2.5){let j=i+1;while(j<=Math.min(g.NOW,i+48)&&!(a[j]!==null&&Math.abs(a[j]-prev)<=.5))j++;if(j<=Math.min(g.NOW,i+48)){for(let k=i;k<j;k++)a[k]=null;i=j-1;continue;}}prev=a[i];}
 const raw=a.slice(),R=field==='value'?12:3;for(let i=0;i<=g.NOW;i++){if(raw[i]===null)continue;const w=raw.slice(Math.max(0,i-R),i+R+1).filter(v=>v!==null).sort((x,y)=>x-y);if(w.length<3)continue;const m=w[w.length>>1];if(Math.abs(raw[i]-m)>(field==='value'?1.5:Math.max(30,.3*Math.abs(m))))a[i]=null;}
 for(let i=1,gap=0;i<=g.NOW;i++){if(a[i]===null&&a[i-1]!==null&&gap<3){a[i]=a[i-1];gap++;}else if(a[i]!==null)gap=0;}  // bridge gaps up to 3 h
 return a;
}
const lastIdx=(a,upto)=>{for(let i=upto;i>=0;i--)if(a[i]!==null)return i;return -1;};
// Tidal = low-lying station near the coast whose level swings > 35 cm within two days (a flashy hill river also swings).
function tidal(lvl,end,st){if(!(st.lat<14.3&&st.bank<6))return false;const w=lvl.slice(Math.max(0,end-48),end+1).filter(v=>v!==null);if(w.length<30)return false;return Math.max(...w)-Math.min(...w)>.35;}

// forecast-plans.json is edited by hand when RID announces a plan; between edits the plans are kept current here, every
// run, from data already fetched (added steps carry auto:true and say where they came from; a newer hand-made step wins):
//  - storage dams in the ThaiWater table (Pa Sak): the measured daily release, when it differs from the plan by ≥ 5 %;
//  - Chao Phraya Dam (a barrage, not in that table): a release figure from the news, once two outlets report it within 12 h;
//  - a high scenario whose date has passed: back to the highest release of the last 10 days at the gauge below the dam
//    (at least +10 %) within 24 h — labelled as an assumption;
//  - the latest news headlines about each dam (outlook text stays hand-written and shows its date).
const AUTO_MIN_CHANGE=.05,NEWS_AGREE_H=12,DAM_NEWS=48,DAM_WORDS={chaophraya:/เขื่อนเจ้าพระยา|ท้ายเขื่อนเจ้าพระยา/,pasak:/ป่าสัก/};
const bkkDay=d=>Date.parse(d+'T00:00:00+07:00'),changed=(a,b)=>Math.abs(a-b)>=Math.max(10,b*AUTO_MIN_CHANGE);
const round50=v=>Math.ceil(v/50)*50;
// Release steps from news that two different outlets agree on (same figure, reported within 12 h of each other):
// the latest agreed figure (dated when it takes effect if the articles say so, else at the first report) and any agreed
// step announced for later ("2,350 ใน 5 ทุ่มคืนนี้"). Plain plans/ranges ("คาดว่า 2,600-2,800") are not steps.
export function newsSteps(points,now=Date.now()){
 const pts=(points||[]).filter(p=>Number.isFinite(p.m3s)&&(p.type==='actual'||(p.type==='plan'&&p.effectiveAt&&!/\d\s*[-–]\s*\d/.test(p.phrase||''))))
  .map(p=>({...p,t:Date.parse(p.at),e:p.effectiveAt?Date.parse(p.effectiveAt):null})).filter(p=>Number.isFinite(p.t)).sort((a,b)=>a.t-b.t);
 const ok=pts.filter(p=>pts.some(o=>o!==p&&o.m3s===p.m3s&&o.source!==p.source&&Math.abs(o.t-p.t)<=NEWS_AGREE_H*3600000));
 const step=run=>{const e=run.map(p=>p.e).filter(Number.isFinite);return {m3s:run[0].m3s,from:e.length?Math.min(...e):run[0].t,first:run[0],sources:[...new Set(run.map(p=>p.source))]};};
 const out=[],nowOk=ok.filter(p=>!(p.e>now));
 if(nowOk.length){const v=nowOk.at(-1).m3s;let k=nowOk.length-1;while(k>0&&nowOk[k-1].m3s===v)k--;out.push(step(nowOk.slice(k)));}
 const later=new Map();for(const p of ok)if(p.e>now){const k=p.m3s+'@'+Math.round(p.e/3600000);if(!later.has(k))later.set(k,[]);later.get(k).push(p);}
 for(const run of later.values())out.push(step(run));
 return out.sort((a,b)=>a.from-b.from);
}
export function autoPlans(plans,{dams=[],evidence=null,gauges={},now=Date.now()}={}){
 const news=(evidence?.items||[]).filter(i=>i.kind==='news'&&now-Date.parse(i.at)<=DAM_NEWS*3600000).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
 const out={...plans,outlookAt:plans.updatedAt,dams:plans.dams.map(dam=>{
  const d={...dam,schedule:dam.schedule.map(s=>({...s}))},sched=d.schedule,cur=()=>sched.filter(s=>Date.parse(s.from)<=now).sort((a,b)=>Date.parse(a.from)-Date.parse(b.from)).at(-1)||sched[0];
  const before=t=>sched.filter(s=>Date.parse(s.from)<=t).sort((a,b)=>Date.parse(a.from)-Date.parse(b.from)).at(-1)||sched[0];
  const add=s=>{if(s.from<=Date.parse(cur().from)||s.from>now+48*3600000||sched.some(x=>Math.abs(Date.parse(x.from)-s.from)<3*3600000)||(s.measured?!changed(s.m3s,before(s.from).m3s):s.m3s===before(s.from).m3s))return;
   sched.push({from:new Date(s.from).toISOString(),m3s:s.m3s,source:s.source,url:s.url,auto:true});sched.sort((a,b)=>Date.parse(a.from)-Date.parse(b.from));};
  const word=DAM_WORDS[d.id]||new RegExp(d.name.split(' ')[0].replace('เขื่อน',''));
  const row=dams.find(x=>word.test(x.name));
  if(row&&Number.isFinite(row.releaseM3s)&&row.date)add({from:bkkDay(row.date),m3s:row.releaseM3s,measured:true,source:`อัตโนมัติ: ระบายจริงเฉลี่ยวันที่ ${row.date} (กรมชลประทาน ผ่าน ThaiWater) • เก็บกัก ${row.storagePct}%`,url:'https://www.thaiwater.net/water/dam/large'});
  else if(d.id==='chaophraya')for(const c of newsSteps(evidence?.damRelease?.points,now)){
   add({from:c.from,m3s:c.m3s,source:`อัตโนมัติจากข่าว: "${c.first.phrase}" • ${c.sources.slice(0,3).join(', ')}${c.sources.length>3?` และอีก ${c.sources.length-3} แหล่ง`:''}`,url:c.first.url});}
  const gq=gauges[d.station];
  if(gq&&Number.isFinite(gq.now)&&(!d.high||Date.parse(d.high.by)<now)){const m=Math.max(round50(gq.max10d||0),round50(gq.now*1.1));
   d.high={m3s:m,by:new Date(now+24*3600000).toISOString(),auto:true,why:`สมมติฐานสูง (อัตโนมัติ): ระบายเพิ่มเป็น ${m.toLocaleString('en-US')} ลบ.ม./วินาที ภายใน 24 ชม. (สูงสุด 10 วันที่ ${d.station} ${Math.round(gq.max10d).toLocaleString('en-US')} หรือ +10% จากตอนนี้) — ไม่ใช่ประกาศ`};}
  d.news=news.filter(i=>word.test(i.title)).filter((i,k,a)=>a.findIndex(o=>o.title===i.title)===k).slice(0,3).map(i=>({at:i.at,title:i.title,source:i.source,url:i.sourceUrl}));
  return d;})};
 return out;
}

// Dam release plan → hourly release (m3/s).
function planSeries(g,dam,scenario){
 const pts=[...dam.schedule].map(p=>({t:Date.parse(p.from),m3s:p.m3s})).sort((a,b)=>a.t-b.t),a=new Array(g.N).fill(null);
 for(let i=0;i<g.N;i++){const t=(g.base+i)*3600000;let v=pts[0].m3s;for(const p of pts)if(p.t<=t)v=p.m3s;a[i]=v;}
 if(scenario==='high'&&dam.high){const t1=Date.parse(dam.high.by),t0=g.NOW;const i1=Math.min(g.N-1,g.idx(t1));for(let i=t0;i<g.N;i++){const f=i1>t0?Math.min(1,(i-t0)/(i1-t0)):1;a[i]=Math.max(a[i],a[t0]+(dam.high.m3s-a[t0])*f);}}
 return a;
}

// --- methods -----------------------------------------------------------------------------------------------------
// Local level–discharge slope from the last 10 days (m per m3/s), for turning a routed flow into a level.
function ratingSlope(lvl,q,end){
 const X=[],y=[];for(let i=Math.max(0,end-HIST_H);i<=end;i++)if(lvl[i]!==null&&q[i]!==null){X.push([1,q[i]]);y.push(lvl[i]);}
 if(X.length<24)return null;const qs=X.map(x=>x[1]);if(Math.max(...qs)-Math.min(...qs)<20)return null;
 const b=lstsq(X,y,0);return b&&b[1]>0&&b[1]<.02?b[1]:null;
}
// Travel time (h) from upstream to target: best correlation of 6-hourly flow changes within the physical range.
function bestLag(up,q,end,[lo,hi]){
 const d=(a,i)=>a[i]!==null&&a[i-6]!=null&&a[i-6]!==null?a[i]-a[i-6]:null;let best=null;
 for(let L=lo;L<=hi;L++){let sx=0,sy=0,sxx=0,syy=0,sxy=0,n=0;for(let i=Math.max(6+L,end-HIST_H+L);i<=end;i++){const x=d(up,i-L),y=d(q,i);if(x===null||y===null)continue;sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;n++;}
  if(n<48)continue;const r=(n*sxy-sx*sy)/Math.sqrt(Math.max(1e-9,(n*sxx-sx*sx)*(n*syy-sy*sy)));if(!best||r>best.r)best={lag:L,r};}
 return best;
}
// Routed flow: target flow now + the change the upstream flow went through one travel time earlier.
// The change is scaled by the target's share of the upstream flow (a branch such as the Noi carries only part of it).
export function routeFlow(q,upQ,lag,end,upto){const out=q.slice(),b=upQ[end-lag],share=b>0?Math.min(1,q[end]/b):1;for(let i=end+1;i<=upto;i++){const a=upQ[i-lag];out[i]=a!==null&&a!==undefined&&b!==null&&b!==undefined?q[end]+share*(a-b):q[end];}return out;}

function regress(lvl,end,upQ,{tide,lagRange}){
 const start=Math.max(0,end-HIST_H+ (lagRange?lagRange[1]:0));let best=null;
 const lags=upQ?Array.from({length:lagRange[1]-lagRange[0]+1},(_,k)=>lagRange[0]+k):[null];
 for(const L of lags){const X=[],y=[];
  for(let i=start;i<=end;i++){if(lvl[i]===null)continue;const row=[1];if(upQ){const u=upQ[i-L];if(u===null||u===undefined)continue;row.push(u/1000);}else row.push((i-end)/24);if(tide)row.push(...tideRow(i));X.push(row);y.push(lvl[i]);}
  if(X.length<72)continue;const b=lstsq(X,y,tide?1e-3:1e-6);if(!b)continue;if(upQ&&b[1]<=0)continue;
  let ss=0,st=0;const m=y.reduce((s,v)=>s+v,0)/y.length;X.forEach((r,k)=>{const f=r.reduce((s,v,j)=>s+v*b[j],0);ss+=(y[k]-f)**2;st+=(y[k]-m)**2;});
  const r2=1-ss/Math.max(st,1e-9);if(!best||r2>best.r2)best={lag:L,b,r2};}
 return best;
}
function applyRegress(fit,lvl,end,upQ,tide,upto){
 const f=i=>{const row=[1];if(upQ){const u=upQ[i-fit.lag];if(u===null||u===undefined)return null;row.push(u/1000);}else{const dt=i-end;row.push(dt<=0?dt/24:12*(1-Math.exp(-dt/12))/24);}if(tide)row.push(...tideRow(i));return row.reduce((s,v,j)=>s+v*fit.b[j],0);};
 // residual now (mean of the last tidal cycle for tidal stations), fading with a 24 h e-folding time
 let rs=0,n=0;for(let i=end-(tide?12:0);i<=end;i++){const v=f(i);if(v!==null&&lvl[i]!==null){rs+=lvl[i]-v;n++;}}const res=n?rs/n:0;
 const out=lvl.slice();for(let i=end+1;i<=upto;i++){const v=f(i);out[i]=v===null?out[i-1]:v+res*Math.exp(-(i-end)/24);}return out;
}
// Damped 6 h slope; the change is capped at the largest 36 h change this station showed in the last 10 days.
export function trend(lvl,end,upto){
 const X=[],y=[];for(let i=end-6;i<=end;i++)if(lvl[i]!==null){X.push([1,i-end]);y.push(lvl[i]);}
 let cap=0;for(let i=Math.max(36,end-HIST_H);i<=end;i++)if(lvl[i]!==null&&lvl[i-36]!==null)cap=Math.max(cap,Math.abs(lvl[i]-lvl[i-36]));
 const b=X.length>=4?lstsq(X,y,0):null,s=b?b[1]:0,out=lvl.slice();for(let i=end+1;i<=upto;i++){const d=s*12*(1-Math.exp(-(i-end)/12));out[i]=lvl[end]+Math.max(-cap,Math.min(cap,d));}return out;
}

// Forecast one station from data up to `end` (NOW for the real forecast, NOW-36 for the hindcast).
function forecastStation(st,g,end,flows,plans,scenario,hind){
 const upto=Math.min(g.N-1,end+AHEAD+ (hind?0:g.NOW-end)),last=lastIdx(st.lvl,end);if(last<0||end-last>6)return null;
 const route=FLOW[st.code];let q=null,method,info={};
 if(route&&st.q&&st.q[last]!==null){
  let upQ,lag;
  if(route.dam){const dam=plans.dams.find(d=>d.id===route.dam);upQ=planSeries(g,dam,scenario);lag=route.dam==='pasak'?(dam.travelToStationH?.[st.code]??15):0;
   // the gauge below the dam is the truth up to now: plan steps dated before the last reading only apply if the gauge agrees
   if(route.dam==='chaophraya'&&!hind){q=st.q.slice();const next=dam.schedule.map(p=>g.idx(Date.parse(p.from))).filter(i=>i>last).sort((a,b)=>a-b)[0]??Infinity;
    for(let i=last+1;i<=upto;i++)q[i]=i<next&&scenario!=='high'?st.q[last]:i<next?Math.max(st.q[last],upQ[i]+st.q[last]-upQ[last]):upQ[i];}
   else if(route.dam==='chaophraya'){q=st.q.slice();for(let i=last+1;i<=upto;i++)q[i]=st.q[i]??st.q[i-1];}  // hindcast: release as measured
   info={dam:dam.name,lagH:lag};}
  else{upQ=route.up.map(c=>flows[c]).reduce((s,a)=>a&&s?s.map((v,i)=>v===null||a[i]===null||a[i]===undefined?null:v+a[i]):null,new Array(g.N).fill(0));
   if(upQ){const bl=bestLag(upQ,st.q,last,route.lag);lag=bl&&bl.r>.3?bl.lag:Math.round((route.lag[0]+route.lag[1])/2);
    const u=route.up.map(c=>flows.meta[c]).filter(Boolean);const km=u.length?kmBetween([u[0].lat,u[0].lng],[st.lat,st.lng])*1.3:null;
    info={up:route.up,lagH:lag,lagFrom:bl&&bl.r>.3?'correlation':'default',distanceKm:round(km,0),speedKmh:km&&lag?round(km/lag,1):null};}}
  if(!q&&upQ){if(hind){const obs=upQ.map((v,i)=>i<=end?v:v);q=routeFlow(st.q,obs,lag,last,upto);}else q=routeFlow(st.q,upQ,lag,last,upto);}
  const slope=q?ratingSlope(st.lvl,st.q,last):null;
  if(q&&slope){const out=st.lvl.slice();for(let i=last+1;i<=upto;i++)out[i]=st.lvl[last]+slope*(q[i]-st.q[last]);method='flow';return {lvl:out,q,method,info,last};}
 }
 const tide=tidal(st.lvl,last,st),dr=driversFor(st),drivers=dr.up,upQ=drivers.length?drivers.map(c=>flows[c]).reduce((s,a)=>a&&s?s.map((v,i)=>v===null||a[i]===null||a[i]===undefined?null:v+a[i]):null,new Array(g.N).fill(0)):null;
 if(upQ){const fit=regress(st.lvl,last,upQ,{tide,lagRange:dr.lag});
  if(fit&&fit.r2>.5){method='regress';return {lvl:applyRegress(fit,st.lvl,last,upQ,tide,upto),method,info:{up:drivers,lagH:fit.lag,r2:round(fit.r2,2),tidal:tide},last};}}
 if(tide){const fit=regress(st.lvl,last,null,{tide:true});if(fit&&fit.r2>.7)return {lvl:applyRegress(fit,st.lvl,last,null,true,upto),method:'trend',info:{tidal:true,r2:round(fit.r2,2)},last};}
 return {lvl:trend(st.lvl,last,upto),method:'trend',info:{},last};
}

const pctOf=(st,v)=>v==null?null:round((v-st.ground)/(st.bank-st.ground)*100,1);
// Peak level in each horizon window (h-12, h] after `from`.
function windows(st,lvl,from){return Object.fromEntries(HORIZONS.map(h=>{let m=-Infinity;for(let i=from+h-11;i<=from+h&&i<lvl.length;i++)if(lvl[i]!==null&&lvl[i]>m)m=lvl[i];return [h,Number.isFinite(m)?{level:round(m),pct:pctOf(st,m)}:null];}));}

// --- inputs ------------------------------------------------------------------------------------------------------
async function stations(g){
 const d=await get(TW+'waterlevel_load',40000),rows=d.waterlevel_data?.data||[],now=Date.now();
 const pick=rows.map(r=>{const s=r.station||{},lat=num(s.tele_station_lat),lng=num(s.tele_station_long),wl=num(r.waterlevel_msl),pct=num(r.storage_percent),bank=num(s.min_bank),t=bkk(r.waterlevel_datetime);
  let ground=num(s.ground_level);if(wl!==null&&pct!==null&&bank!==null&&Math.abs(pct-100)>.5){const gd=(wl-pct/100*bank)/(1-pct/100);if(Number.isFinite(gd)&&gd<bank)ground=gd;}
  return {id:s.id,code:s.tele_station_oldcode||String(s.id),name:s.tele_station_name?.th||'',lat,lng,basin:r.basin?.basin_name?.th||'',agency:r.agency?.agency_shortname?.th||'',province:r.geocode?.province_name?.th||'',amphoe:r.geocode?.amphoe_name?.th||'',tambon:r.geocode?.tumbon_name?.th||'',
   levelNow:wl,pctNow:pct,qNow:num(r.discharge),bank,ground,at:Number.isFinite(t)?new Date(t).toISOString():null,fresh:Number.isFinite(t)&&now-t<6*3600000};})
  .filter(s=>s.lat!==null&&s.lng>=BOX[0]&&s.lng<=BOX[2]&&s.lat>=BOX[1]&&s.lat<=BOX[3]&&s.fresh&&s.bank!==null&&s.ground!==null&&s.bank>s.ground&&s.pctNow!==null);
 // always kept: the routed chain and every station in the central flood-model provinces (few, and the ones people
 // there look for, e.g. the Pathum Thani / Nonthaburi canals), whatever their level; elsewhere only fuller rivers
 const must=new Set([...Object.keys(FLOW),'C.12','CPY015','CPY014','BKC002']),keep=s=>must.has(s.code)||ALWAYS_PROV.test(s.province);
 const chosen=pick.filter(s=>keep(s)||s.pctNow>=MIN_PCT).sort((a,b)=>(keep(b)-keep(a))||b.pctNow-a.pctNow).slice(0,MAX_STATIONS);
 const start=new Date((g.base)*3600000+7*3600000).toISOString().slice(0,10),end=new Date(Date.now()+7*3600000+86400000).toISOString().slice(0,10);
 const hist=await mapLimit(chosen,6,s=>get(`${TW}waterlevel_graph?station_type=tele_waterlevel&station_id=${s.id}&start_date=${start}&end_date=${end}`));
 return chosen.map((s,i)=>{const gd=hist[i]?.data?.graph_data;if(!gd)return null;return {...s,lvl:toSeries(g,gd,'value'),q:gd.some(p=>num(p.discharge)!==null)?toSeries(g,gd,'discharge'):null};}).filter(Boolean);
}
async function dams(){
 const d=await get(TW+'thaiwater_main');const rows=d.dam?.data?.data||[];const m3s=v=>v==null?null:round(Number(v)*1e6/86400,0);
 return rows.map(r=>({id:r.dam?.id,name:'เขื่อน'+(r.dam?.dam_name?.th||''),lat:num(r.dam?.dam_lat),lng:num(r.dam?.dam_long),date:r.dam_date,storagePct:num(r.dam_storage_percent),inflowM3s:m3s(r.dam_inflow),releaseM3s:m3s(r.dam_released),spillM3s:m3s(r.dam_spilled),inflowMcm:num(r.dam_inflow),releaseMcm:num(r.dam_released)})).filter(x=>x.lat!==null).sort((a,b)=>(b.storagePct??0)-(a.storagePct??0));
}
// Rain outlook (Open-Meteo, blend of global weather models): accumulated mm in each horizon window at a few places.
const RAIN_POINTS=[['กรุงเทพฯ ฝั่งตะวันออก',13.78,100.72],['กรุงเทพฯ ชั้นใน',13.75,100.52],['กรุงเทพฯ ฝั่งธนบุรี',13.72,100.43],['นนทบุรี',13.86,100.5],['ปทุมธานี',14.02,100.6],['สมุทรปราการ',13.6,100.6],['พระนครศรีอยุธยา',14.35,100.57],['อ่างทอง',14.59,100.45],['ลพบุรี',14.8,100.65],['สระบุรี',14.53,100.91],['นครนายก',14.2,101.21],['ปราจีนบุรี',14.05,101.37],['ฉะเชิงเทรา',13.69,101.07],['สุพรรณบุรี',14.47,100.12],['นครปฐม',13.82,100.06],['กาญจนบุรี',14.02,99.53],['ชัยนาท',15.19,100.12],['นครสวรรค์',15.7,100.12]];
async function rainOutlook(){
 const lat=RAIN_POINTS.map(p=>p[1]).join(','),lng=RAIN_POINTS.map(p=>p[2]).join(',');
 const d=await get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation,precipitation_probability&past_hours=6&forecast_hours=${AHEAD+1}&timezone=Asia%2FBangkok`);
 // hourly totals ending at each timestamp (Asia/Bangkok); the 6 past hours bridge the gap to the flood model's last rain hour
 return (Array.isArray(d)?d:[d]).map((r,k)=>{const all=r.hourly.precipitation,times=r.hourly.time.map(t=>Date.parse(t+':00+07:00')),i0=Math.max(0,times.findIndex(t=>t>=Math.floor(Date.now()/3600000)*3600000));
  const p=all.slice(i0),pp=(r.hourly.precipitation_probability||[]).slice(i0);
  return {name:RAIN_POINTS[k][0],lat:RAIN_POINTS[k][1],lng:RAIN_POINTS[k][2],windows:Object.fromEntries(HORIZONS.map(h=>[h,{mm:round(p.slice(h-12,h).reduce((s,v)=>s+(v||0),0),1),probPct:Math.max(0,...pp.slice(h-12,h).filter(v=>v!=null))}])),
   hourly:{startAt:new Date(times[0]).toISOString(),mm:all.map(v=>v==null?null:round(v,1))}};});
}

// --- job ----------------------------------------------------------------------------------------------------------
export async function buildForecast({evidence}={}){
 const now=Date.now(),g=grid(now),errors=[];
 const manual=JSON.parse(await readFile(PLANS,'utf8'));
 const [stR,damR,rainR]=await Promise.allSettled([stations(g),dams(),rainOutlook()]);
 if(stR.status==='rejected')throw Error('ThaiWater water levels: '+stR.reason.message);
 const sts=stR.value;if(damR.status==='rejected')errors.push({source:'dams',error:damR.reason.message});if(rainR.status==='rejected')errors.push({source:'rain',error:rainR.reason.message});
 const gauges={};for(const d of manual.dams){const s=d.station&&sts.find(x=>x.code===d.station),q=s?.q?.slice(0,g.NOW+1).filter(v=>v!==null);if(q?.length)gauges[d.station]={now:q.at(-1),max10d:Math.max(...q)};}
 const plans=autoPlans(manual,{dams:damR.status==='fulfilled'?damR.value:[],evidence,gauges,now});
 const byCode=new Map(sts.map(s=>[s.code,s])),order=[...Object.keys(FLOW).filter(c=>byCode.has(c)),...sts.map(s=>s.code).filter(c=>!FLOW[c])];
 const run=(scenario,end,hind)=>{const flows={meta:{}},res=new Map();
  for(const c of order){const st=byCode.get(c),f=forecastStation(st,g,end,flows,plans,scenario,hind);if(!f)continue;res.set(c,f);
   if(FLOW[c]){flows[c]=f.q||st.q;flows.meta[c]=st;if(hind&&st.q){const obs=st.q.slice();flows[c]=obs;}}}  // hindcast drivers: measured flow
  return res;};
 const base=run('base',g.NOW,false),high=run('high',g.NOW,false),hind=run('base',g.NOW-HINDCAST,true);
 const out=[];
 for(const st of sts){const f=base.get(st.code);if(!f)continue;const hi=high.get(st.code),hc=hind.get(st.code);
  // hindcast error: forecast made 36 h ago vs what was measured, at each horizon
  // (window peaks, as published: the highest level forecast vs measured in each 12 h window)
  let err=null;if(hc){const from=g.NOW-HINDCAST,wp=windows(st,hc.lvl,from),wo=windows(st,st.lvl,from);err=Object.fromEntries(HORIZONS.map(h=>[h,wp[h]&&wo[h]?round(Math.abs(wp[h].level-wo[h].level),2):null]));}
  const fc=windows(st,f.lvl,g.NOW),fh=hi?windows(st,hi.lvl,g.NOW):null;
  const qAt=h=>f.q?.[g.NOW+h]!=null?round(f.q[g.NOW+h],0):null;
  // hourly path for charts: last 48 h measured + 36 h forecast, every 2 h
  const path=[];for(let i=g.NOW-48;i<=g.NOW+AHEAD;i+=2)path.push([i-g.NOW,i<=f.last?round(st.lvl[i]):null,i>=f.last?round(f.lvl[i]):null]);
  out.push({code:st.code,name:st.name,province:st.province,amphoe:st.amphoe,tambon:st.tambon,basin:st.basin,agency:st.agency,lat:st.lat,lng:st.lng,
   at:st.at,levelNow:st.levelNow,pctNow:st.pctNow,qNow:st.qNow,bankM:st.bank,groundM:round(st.ground),method:f.method,...f.info,
   forecast:Object.fromEntries(HORIZONS.map(h=>[h,fc[h]?{...fc[h],q:qAt(h),high:fh?.[h]&&Math.abs(fh[h].level-fc[h].level)>=.01?fh[h]:undefined}:null])),
   hindcastErrorM:err,path});}
 const risk=Object.fromEntries(HORIZONS.map(h=>[h,out.filter(s=>s.forecast[h]?.pct>=100).map(s=>({code:s.code,name:s.name,province:s.province,amphoe:s.amphoe,tambon:s.tambon,pct:s.forecast[h].pct,riseM:round(s.forecast[h].level-s.levelNow),newly:s.pctNow<100})).sort((a,b)=>b.pct-a.pct)]));
 return {issuedAt:new Date(now).toISOString(),horizons:HORIZONS,plans,stations:out.sort((a,b)=>(b.forecast[36]?.pct??0)-(a.forecast[36]?.pct??0)),risk,
  dams:damR.status==='fulfilled'?damR.value:[],rain:rainR.status==='fulfilled'?rainR.value:[],canals:await withCanalLines(canalSummary(evidence)),errors,
  modelDrivers:modelDrivers(g,byCode,base,high,rainR.status==='fulfilled'?rainR.value:[]),
  method:{stations:out.length,note:'ระดับสูงสุดในแต่ละช่วง 12 ชม. • flow = ส่งต่ออัตราการไหลจากต้นน้ำตามเวลาเดินทาง • regress = ระดับน้ำเทียบกับอัตราการไหลต้นน้ำย้อนหลัง 10 วัน (+น้ำขึ้นน้ำลง) • trend = แนวโน้ม 6 ชม. ล่าสุด หน่วงลง • ค่าคลาดเคลื่อนย้อนหลัง = พยากรณ์จาก 36 ชม. ก่อน เทียบค่าที่วัดได้จริง (ใช้น้ำต้นทางที่วัดจริง)'}};
}

// Hourly inputs for the 2D flood model's forward run (model/run.py): routed discharge at the stations where rivers enter
// the central domain (base and high dam-release scenarios; measured for the past hours) and the hourly rain forecast.
const MODEL_INFLOWS=['C.7A','S.26'];
function modelDrivers(g,byCode,base,high,rain){
 const from=g.NOW-24,series=(res,c)=>{const f=res.get(c),st=byCode.get(c);if(!st?.q)return null;let last=null;const out=[];
  for(let i=from;i<=g.NOW+AHEAD;i++){const v=f?.q?.[i]??st.q[i]??null;if(v!=null)last=v;out.push(last==null?null:round(last,0));}return out;};
 const q={};for(const c of MODEL_INFLOWS){const b=series(base,c);if(b)q[c]={base:b,high:series(high,c)||b,method:base.get(c)?.method||null};}
 return {startAt:g.time(from),stepH:1,q,rain:rain.filter(r=>r.hourly).map(r=>({name:r.name,lat:r.lat,lng:r.lng,...r.hourly}))};
}

// Bangkok canals from the evidence feed (BMA): per station, plus per canal the worst station.
export function canalSummary(ev){
 const items=(ev?.items||[]).filter(i=>i.subkind==='bma-canal');if(!items.length)return null;
 const st=items.map(i=>({code:i.code,name:i.title.split(':')[0],canal:i.canal,district:i.district,lat:i.lat,lng:i.lng,at:i.at,state:i.state,status:i.status,levelM:i.levelM,warningM:i.warningM,criticalM:i.criticalM,bankM:i.bankM,overM:i.overM,trendMPerH:i.trendMPerH,offline:i.offline}));
 const rank={critical:3,warning:2,normal:1,offline:0},by=new Map();
 for(const s of st){if(!by.has(s.canal))by.set(s.canal,[]);by.get(s.canal).push(s);}
 const canals=[...by].map(([canal,list])=>{const live=list.filter(s=>!s.offline),worst=live.sort((a,b)=>rank[b.state]-rank[a.state]||(b.overM??-9)-(a.overM??-9))[0];
  return {canal,state:worst?.state||'offline',stations:list.length,critical:live.filter(s=>s.state==='critical').length,warning:live.filter(s=>s.state==='warning').length,maxOverM:worst?.overM??null,districts:[...new Set(list.map(s=>s.district))],trend:(t=>t.length?round(t.reduce((a,v)=>a+v,0)/t.length,3):null)(live.map(s=>s.trendMPerH).filter(v=>v!=null))};})
  .sort((a,b)=>rank[b.state]-rank[a.state]||b.critical-a.critical||(b.maxOverM??-9)-(a.maxOverM??-9));
 return {fetchedAt:items[0].fetchedAt||items[0].at,source:items[0].source,counts:Object.fromEntries(['critical','warning','normal','offline'].map(k=>[k,st.filter(s=>s.state===k).length])),canals,stations:st};
}

// The stretch of each canal around its gauge (OSM waterway with the same name, points within CANAL_REACH_KM), so the
// map can colour the canal itself, not just a dot. Names that do not match an OSM canal keep only the dot.
const CANAL_REACH_KM=1.2;
export async function withCanalLines(sum){
 if(!sum)return sum;let feats;try{feats=JSON.parse(gunzipSync(await readFile(new URL('./data/named/named.json.gz',import.meta.url)))).features.filter(f=>f.kind==='canal'||f.kind==='river');}catch{return sum;}
 const byName=new Map();for(const f of feats){if(!byName.has(f.name))byName.set(f.name,[]);byName.get(f.name).push(f);}
 const cut=(line,p)=>{const runs=[];let cur=[];for(const q of line){if(kmBetween(q,p)<=CANAL_REACH_KM)cur.push(q);else{if(cur.length>1)runs.push(cur);cur=[];}}if(cur.length>1)runs.push(cur);return runs;};
 for(const s of sum.stations){const cands=byName.get(s.canal)||byName.get((s.canal||'').replace(/^คลอง/,'คลอง').split(' ')[0])||[];
  const p=[s.lat,s.lng];let best=null;
  for(const f of cands)for(const l of f.lines||[]){let dmin=Infinity;for(const q of l)dmin=Math.min(dmin,kmBetween(q,p));if(dmin<=.6&&(!best||dmin<best.d))best={d:dmin,f};}
  if(best)s.line=best.f.lines.flatMap(l=>cut(l,p)).map(r=>r.map(q=>[round(q[0],5),round(q[1],5)]));}
 return sum;
}
