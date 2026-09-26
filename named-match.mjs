// Match road / soi / village / canal / bridge / junction names in Thai text to OSM features (data/named/named.json.gz).
// A name only resolves when the context makes it unambiguous: a report's own coordinates, a province or
// district named in the text, or a name that exists in one place only. Long roads are clipped to the part
// near that context instead of drawing the whole road.
const KEYWORDS=['ถนน','ซอย','หมู่บ้าน','คลอง','แม่น้ำ','สะพาน','แยก'];
const ABBREV=[[/ถ\.\s*/g,'ถนน'],[/ซ\.\s*/g,'ซอย'],[/ม\.บ\.\s*|มบ\.\s*/g,'หมู่บ้าน'],[/สะพานข้าม/g,'สะพาน']];
// After these words a bare name ("ท่วมรามคำแหง 43/1") is tried as ถนน…/ซอย….
const LEAD=/(?:ท่วม(?:ขัง|สูง|หนัก)?|น้ำขัง|น้ำเอ่อ|ย่าน|บริเวณ|ช่วง|หน้า|ปาก)/g;
// Generic words that also occur as (odd) OSM names; never accepted as the distinctive part of a name.
const GENERIC=new Set(['หน้า','หลัง','ใน','นอก','ใหญ่','เล็ก','หลัก','ใหม่','เก่า','ข้าง','ทาง','สาย','เส้น','นี้','นั้น','กลาง','บ้าน','โรงเรียน','วัด','ตลาด','ทะเบียน','อยู่ดี','หวังว่า','เข้า','ออก','ด้วย','แล้ว','ญี่ปุ่น','จีน','ไทย','เลย','ตรง','ฝั่ง','ริม','เลียบ','คู่ขนาน','สายหลัก','สายรอง']);
export const normName=s=>s.replace(/[\s.\-–,'"“”()]/g,'').toLowerCase();

export function buildNamedIndex(features){
 const byKey=new Map();
 for(const f of features){const k=normName(f.name);if(k.length<4)continue;if(!byKey.has(k))byKey.set(k,[]);byKey.get(k).push(f);}
 let maxLen=0;for(const k of byKey.keys())if(k.length>maxLen)maxLen=k.length;
 return {byKey,maxLen:Math.min(maxLen,48)};
}
const km=(a,b,c,d)=>Math.hypot((a-c)*111.32,(b-d)*111.32*Math.cos(a*Math.PI/180));
function nearestPointDist(f,lat,lng){let best=km(f.lat,f.lng,lat,lng);for(const l of f.lines)for(const p of l){const d=km(p[0],p[1],lat,lng);if(d<best)best=d;}return best;}
// Keep only the parts of a feature's lines within r km of a point.
function clip(f,lat,lng,r){const out=[];for(const l of f.lines){let cur=[];for(const p of l){if(km(p[0],p[1],lat,lng)<=r)cur.push(p);else if(cur.length){if(cur.length>1)out.push(cur);cur=[];}}if(cur.length>1)out.push(cur);}return out;}

// Candidate names in the text: longest indexed key starting at each keyword / after each lead word.
function candidates(text,idx,opts={}){
 let t=text;for(const [re,rep] of ABBREV)t=t.replace(re,rep);
 const flat=normName(t),found=new Map();
 const tryAt=(pos,prefixes,type)=>{for(const pre of prefixes){for(let len=Math.min(idx.maxLen,flat.length-pos+pre.length);len>=pre.length+3;len--){const end=pos+len-pre.length,k=pre+flat.slice(pos,end);if(idx.byKey.has(k)&&!(/\d$/.test(k)&&/\d/.test(flat[end]||''))){const rest=k.replace(/^(ถนน|ซอย|หมู่บ้าน|คลอง|แม่น้ำ|สะพาน|แยก)/,'');if(!GENERIC.has(rest)&&rest.length>=3&&!found.has(k))found.set(k,{fs:idx.byKey.get(k),type,rest});return;}}}};
 for(const kw of KEYWORDS){let i=flat.indexOf(kw);while(i>=0){tryAt(i,[''],'keyword');i=flat.indexOf(kw,i+kw.length);}}
 for(const m of flat.matchAll(LEAD))if(!KEYWORDS.some(kw=>flat.startsWith(kw,m.index+m[0].length)))tryAt(m.index+m[0].length,['ถนน','ซอย'],'lead');
 // Bare names anywhere in a short text (headline/summary): only numbered ones ("รามคำแหง 43/1"); unnumbered words
 // are too often parts of other Thai words (มหานคร in กรุงเทพมหานคร, ปราการ in สมุทรปราการ).
 if(opts.bareScan){const head=flat.slice(0,700);for(let pos=0;pos<head.length;pos++){if(KEYWORDS.some(kw=>head.startsWith(kw,pos)))continue;
  for(const pre of ['ซอย','ถนน','หมู่บ้าน']){for(let len=Math.min(idx.maxLen,head.length-pos+pre.length);len>=pre.length+5;len--){const rest=head.slice(pos,pos+len-pre.length),k=pre+rest;
   if(idx.byKey.has(k)&&/\d/.test(rest)&&!/\d/.test(head[pos+rest.length]||'')&&![...found.keys()].some(x=>x.includes(rest))){found.set(k,{fs:idx.byKey.get(k),type:'bare',rest});pos+=rest.length-1;break;}}}}}
 return found;
}

// context: {lat,lng} for geolocated reports and/or places:[{province,short,lat,lng,precision}] from extractPlaces
export function matchNamed(text,idx,context={}){
 if(!idx)return [];
 const out=[];const provinces=new Set((context.places||[]).map(p=>p.province));
 const anchors=(context.places||[]).filter(p=>p.precision!=='province');
 const hasContext=Number.isFinite(context.lat)||provinces.size>0;
 for(const [k,{fs,type,rest}] of candidates(text,idx,{bareScan:context.bareScan})){
  // names found without an explicit ถนน/ซอย/… keyword need a number or a place context to count
  if(type!=='keyword'&&!/\d/.test(rest)&&!hasContext)continue;
  let pick=null,anchor=null;
  if(Number.isFinite(context.lat)){const near=fs.map(f=>[f,nearestPointDist(f,context.lat,context.lng)]).filter(([,d])=>d<=1.5).sort((a,b)=>a[1]-b[1]);if(near.length){pick=near[0][0];anchor={lat:context.lat,lng:context.lng,r:.4};}}
  else{
   let pool=provinces.size?fs.filter(f=>provinces.has(f.province)):fs;
   if(anchors.length){const near=pool.map(f=>[f,Math.min(...anchors.map(a=>nearestPointDist(f,a.lat,a.lng)))]).filter(([,d])=>d<=6).sort((a,b)=>a[1]-b[1]);if(near.length){pick=near[0][0];const a=anchors.reduce((b,x)=>nearestPointDist(pick,x.lat,x.lng)<nearestPointDist(pick,b.lat,b.lng)?x:b);anchor={lat:a.lat,lng:a.lng,r:3};}}
   if(!pick&&pool.length===1)pick=pool[0];
  }
  if(!pick){if(type!=='keyword')continue;const provs=[...new Set(fs.map(f=>f.province).filter(Boolean))];out.push({name:fs[0].name,kind:fs[0].kind,province:provs.length===1?provs[0]:null,ambiguous:true,candidates:provs.slice(0,5),lines:[],drawn:false});if(out.length>=8)break;continue;}
  let lines=pick.lines;
  if(anchor&&pick.lengthM>anchor.r*2000)lines=clip(pick,anchor.lat,anchor.lng,anchor.r);
  else if(!anchor&&pick.lengthM>8000)lines=[];  // a long road with no local context: list it, do not draw it all
  out.push({name:pick.name,kind:pick.kind,province:pick.province,lat:pick.lat,lng:pick.lng,lines:lines.slice(0,20).map(l=>l.length>80?l.filter((_,i)=>i%Math.ceil(l.length/80)===0||i===l.length-1):l),drawn:lines.length>0||pick.kind==='place'||pick.kind==='junction'||pick.kind==='village',clipped:!!anchor&&pick.lengthM>anchor.r*2000});
  if(out.length>=8)break;
 }
 return out;
}
