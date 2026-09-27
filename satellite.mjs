// Satellite-detected flood areas from GISTDA (Disaster Platform, api-gateway.gistda.or.th), for the model domains.
// Each GISTDA feature is the flooded part of one H3 cell (~0.1 km2) from one satellite pass, with the tambon and
// counts of roads/buildings/people inside. Needs a free API key (env GISTDA_API_KEY). Not real time: passes are
// a few times a week per area and radar misses shallow water on city streets.
//
// Output (compact, for the web page): passes [{id,sensor,at}], admin names table, and per feature
//   [passIndex, adminIndex, floodM2, roadM, buildings, population, ring (delta ints of 1e-5 deg, lat,lng pairs)]
const API='https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/';
const PAGE=1000,MAX_PAGES=60;

async function page(url){
 for(let attempt=0;;attempt++){
  try{const r=await fetch(url,{signal:AbortSignal.timeout(90000)});if(!r.ok)throw Error(`HTTP ${r.status} GISTDA`);return await r.json();}
  catch(e){if(attempt>=2||/HTTP 4/.test(e.message))throw e;await new Promise(res=>setTimeout(res,3000*(attempt+1)));}}}

// "rd2_20260926_0613" -> sensor code and the acquisition time in the file name (read as Thai time)
export function passInfo(name){
 const m=/^([a-z0-9]+)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/i.exec(name||'');if(!m)return {id:name,sensor:null,at:null};
 return {id:name,sensor:m[1],at:new Date(`${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:00+07:00`).toISOString()};}

// Largest outer ring of a (Multi)Polygon, thinned to ~10 m steps, delta-encoded at 1e-5 degrees.
export function encodeRing(geom){
 const polys=geom?.type==='Polygon'?[geom.coordinates]:geom?.type==='MultiPolygon'?geom.coordinates:[];
 let ring=[],best=-1;
 for(const p of polys){const r=p[0]||[];let a=0;for(let i=0,j=r.length-1;i<r.length;j=i++)a+=(r[j][0]-r[i][0])*(r[j][1]+r[i][1]);if(Math.abs(a)>best){best=Math.abs(a);ring=r;}}
 const out=[];let plat=0,plng=0,last=null;
 for(const [lng,lat] of ring){const y=Math.round(lat*1e5),x=Math.round(lng*1e5);if(last&&Math.abs(y-last[0])+Math.abs(x-last[1])<10)continue;out.push(y-plat,x-plng);plat=y;plng=x;last=[y,x];}
 return out;}

export async function gistdaFlood({key,bbox,window='3days'}){
 if(!key)throw Error('ไม่มี GISTDA_API_KEY');
 const passes=new Map(),admins=new Map(),features=[];let matched=null;
 for(let n=0;n<MAX_PAGES;n++){
  const d=await page(`${API}${window}?api_key=${encodeURIComponent(key)}&bbox=${bbox.join(',')}&limit=${PAGE}&offset=${n*PAGE}`);
  matched??=d.numberMatched;const fs=d.features||[];
  for(const f of fs){const p=f.properties||{};
   if(!passes.has(p.file_name))passes.set(p.file_name,passes.size);
   const admin=[p.tb_tn,p.ap_tn,p.pv_tn].map(s=>String(s||'').replace(/^(ต\.|อ\.|จ\.)/,'')).join('|');if(!admins.has(admin))admins.set(admin,admins.size);
   const ring=encodeRing(f.geometry);if(ring.length<6)continue;
   features.push([passes.get(p.file_name),admins.get(admin),Math.round(p.f_area||0),Math.round(p.length_road||0),p.building||0,Math.round(p.population||0),ring]);}
  if(fs.length<PAGE||!(d.links||[]).some(l=>l.rel==='next'))break;}
 return {source:'GISTDA Disaster Platform (สทอภ.)',sourceUrl:'https://disaster.gistda.or.th/',window,bbox,matched,
  passes:[...passes.keys()].map(passInfo),admins:[...admins.keys()],fields:['pass','admin','floodM2','roadM','buildings','population','ring'],features};}

// Totals per province and district (for the situation section)
export function summariseSatellite(s){
 const by=new Map();
 for(const [,a,m2,road,bld,pop] of s.features){const [tb,ap,pv]=s.admins[a].split('|');const k=pv+'|'+ap;
  const x=by.get(k)||{province:pv,district:ap,floodKm2:0,roadKm:0,buildings:0,population:0,tambons:new Set()};
  x.floodKm2+=m2/1e6;x.roadKm+=road/1e3;x.buildings+=bld;x.population+=pop;x.tambons.add(tb);by.set(k,x);}
 return [...by.values()].map(x=>({...x,floodKm2:+x.floodKm2.toFixed(2),roadKm:+x.roadKm.toFixed(1),tambons:x.tambons.size})).sort((a,b)=>b.floodKm2-a.floodKm2);}

// Wet observations for model validation: the centre of each feature whose flooded area is at least minM2 (a
// quarter of the ~0.12 km2 H3 cell by default), at the pass time. Radar sees open water, so these are "flooded
// here", never "dry here" (no footprint of what was imaged but dry is published).
export function satelliteObservations(s,minM2=30000){
 const out=[];
 for(const [pi,,m2,,,,ring] of s.features){if(m2<minM2)continue;const at=s.passes[pi]?.at;if(!at)continue;
  let y=0,x=0,sy=0,sx=0,n=0;for(let i=0;i<ring.length;i+=2){y+=ring[i];x+=ring[i+1];sy+=y;sx+=x;n++;}
  out.push({kind:'satellite',lat:sy/n/1e5,lng:sx/n/1e5,at,wet:true});}
 return out;}
