// Pure text processing for flood evidence: RSS parsing, relevance, Thai place extraction, facts. No network here.
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',ndash:'–',mdash:'—',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”'};
export const decode=s=>(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(+d)).replace(/&([a-z]+);/gi,(m,n)=>ENTITIES[n.toLowerCase()]??m);
export const stripTags=s=>decode(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const tag=(xml,name)=>{const m=xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,'i'));return m?m[1]:'';};

export function parseRss(xml,feed){
 return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(([item])=>{
  const title=stripTags(tag(item,'title')),link=decode(tag(item,'link')).trim()||decode((item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)||[])[1]||'').trim();
  const published=Date.parse(decode(tag(item,'pubDate'))||decode(tag(item,'dc:date')));
  const publisher=stripTags(tag(item,'source'))||feed.name;
  return {title:feed.google?title.replace(/\s+-\s+[^-]+$/,''):title,link,publishedAt:Number.isFinite(published)?new Date(published).toISOString():null,summary:stripTags(tag(item,'description')).slice(0,1500),categories:[...item.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map(m=>stripTags(m[1])),publisher,feed:feed.name,via:feed.google?'Google News':null};
 }).filter(x=>x.title&&/^https?:\/\//.test(x.link));
}

// Strong terms alone make an item relevant; weak terms need a second hit.
const STRONG=/น้ำท่วม|ท่วมขัง|ท่วมสูง|ท่วมหนัก|น้ำป่า|อุทกภัย|น้ำหลาก|น้ำล้นตลิ่ง|น้ำเอ่อ|ดินโคลนถล่ม|ดินถล่ม|พื้นที่ประสบภัย|ประกาศ(?:เขต)?(?:พื้นที่)?ภัยพิบัติ|\bfloods?\b|flooding|flooded|inundat|flash flood|landslide/gi;
const WEAK=/ฝนตกหนัก|ระดับน้ำ|ปล่อยน้ำ|ระบายน้ำ|เขื่อน|พายุ|มรสุม|ร่องมรสุม|ล้นตลิ่ง|สูบน้ำ|คันกั้นน้ำ|ประตูระบายน้ำ|ปภ\.|heavy rain|dam|downpour|monsoon|storm/gi;
const NOISE=/ท่วมท้น|ล้นหลาม|หุ้น|ตลาดหลักทรัพย์|ฟุตบอล|ละคร|น้ำท่วมปอด/;
export function relevance(text){const strong=(text.match(STRONG)||[]).length,weak=(text.match(WEAK)||[]).length;const noise=NOISE.test(text)&&strong<2;return {relevant:!noise&&(strong>=1||weak>=2),score:strong*2+weak};}

// Depth phrases. Body-part phrases are rough conventions, flagged as estimates.
const BODY=[[/ข้อเท้า/,10],[/ครึ่งแข้ง|หน้าแข้ง/,25],[/(?:ระดับ)?หัวเข่า|ระดับเข่า|ถึงเข่า/,45],[/ระดับเอว|ถึงเอว|ครึ่งตัว/,90],[/ระดับอก|ถึงอก/,120],[/มิดหลังคา|ท่วมหลังคา|มิดหัว/,250]];
export function extractDepth(text){
 const out=[];
 for(const m of text.matchAll(/(?:ท่วม|ระดับน้ำ|น้ำขัง|น้ำสูง|สูงประมาณ|สูง|ลึก)[^0-9\n]{0,18}?(\d+(?:[.,]\d+)?)\s*(?:-|–|ถึง)?\s*(\d+(?:[.,]\d+)?)?\s*(ซม\.?|เซนติเมตร|ซ\.ม\.|cm\b|เมตร|ม\.(?!\S*ค\.)|m\b)/gi)){
  const v=Number((m[2]||m[1]).replace(',','.')),metres=/เมตร|^ม\.|^m$/i.test(m[3]);const cm=metres?v*100:v;
  if(cm>0&&cm<=600)out.push({cm:Math.round(cm),phrase:m[0].slice(0,60),estimated:false});}
 if(!out.length)for(const [re,cm] of BODY){const m=text.match(re);if(m&&/ท่วม|น้ำ/.test(text.slice(Math.max(0,m.index-25),m.index+5))){out.push({cm,phrase:m[0],estimated:true});break;}}
 return out;
}

// Short numeric facts worth surfacing (kept as quoted phrases, not reinterpreted).
const FACTS=[/(\d[\d,.]*\s*(?:หมื่น|แสน|พัน)?\s*ครัวเรือน)/g,/(\d+\s*จังหวัด)/g,/(\d+\s*อำเภอ)/g,/(เสียชีวิต\s*\d+\s*(?:ราย|คน))/g,/(\d+\s*(?:ราย|คน)\s*เสียชีวิต)/g,/(ระบายน้ำ(?:ท้ายเขื่อน)?\s*(?:ในอัตรา|วันละ|อัตรา)?\s*\d[\d,.]*\s*(?:ลบ\.ม\.|ลูกบาศก์เมตร|ล้าน\s*ลบ\.ม\.)[^\s]{0,12})/g,/(\d[\d,.]*\s*ลบ\.ม\.\/วินาที)/g,/(ฝนสะสม\s*\d[\d,.]*\s*มม\.?)/g,/(\d+\s*เขต)(?=[^ก-๙]|ประกาศ|เป็น)/g];
export function extractFacts(text){const seen=new Set(),out=[];for(const re of FACTS)for(const m of text.matchAll(re)){const f=m[1].trim();if(!seen.has(f)){seen.add(f);out.push(f);}if(out.length>=8)return out;}return out;}

// Personal data is not republished: phone numbers, e-mails, Thai ID-like digit runs.
export const redact=s=>(s||'').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g,'[อีเมล]').replace(/(?:\+?66|0)[\s-]?\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4}/g,'[เบอร์โทร]').replace(/\b\d{13}\b/g,'[เลข]');

const BKK_ALIASES=['กรุงเทพมหานคร','กรุงเทพฯ','กรุงเทพ','กทม.','กทม','ท่วมกรุง','ทั่วกรุง','ในกรุง','Bangkok'];
// Bangkok khwaeng names that are also everyday words (airport, monument, junction, a rank, a given name)
const BARE_STOP=new Set(['สนามบิน','อนุสาวรีย์','สามแยก','จอมพล','วัฒนา','ทุ่งมหาเมฆ']);
const AMBIGUOUS_PROVINCE=new Set(['เลย','ตาก','น่าน','ตรัง','แพร่','ยะลา','สตูล','พัทลุง']);
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

export function buildGazetteer(places){
 const provinces=places.filter(p=>p.level===4),byProvince=new Map(provinces.map(p=>[p.short,p]));
 const districtsByName=new Map(),subByName=new Map();
 for(const p of places){const map=p.level===6?districtsByName:p.level===8?subByName:null;if(!map)continue;if(!map.has(p.short))map.set(p.short,[]);map.get(p.short).push(p);}
 const provTerms=[];
 for(const p of provinces){const names=p.short==='กรุงเทพฯ'?BKK_ALIASES:[p.short];for(const n of names)provTerms.push([n,p]);if(p.en&&p.en.length>3)provTerms.push([p.en,p]);}
 provTerms.sort((a,b)=>b[0].length-a[0].length);
 // Bangkok district/khwaeng names are often written without เขต/แขวง; allow that only when the name is unique nationwide.
 const provs=new Map();for(const p of places)if(p.level!==4){if(!provs.has(p.short))provs.set(p.short,new Set());provs.get(p.short).add(p.province);}
 // prefer the district over a same-named khwaeng
 const bkkBare=places.filter(p=>p.level!==4&&p.province==='กรุงเทพฯ'&&p.short.length>=4&&!BARE_STOP.has(p.short)&&provs.get(p.short).size===1).sort((a,b)=>a.level-b.level).filter((p,i,a)=>a.findIndex(q=>q.short===p.short)===i).sort((a,b)=>b.short.length-a.short.length);
 const byProvDistricts=new Map();for(const p of places)if(p.level===6&&p.short.length>=4){if(!byProvDistricts.has(p.province))byProvDistricts.set(p.province,[]);byProvDistricts.get(p.province).push(p);}
 // Outside Bangkok, long district names that exist in one province only ("อรัญประเทศ") are distinctive enough without อ.
 const districtProvs=new Map();for(const p of places)if(p.level===6){if(!districtProvs.has(p.short))districtProvs.set(p.short,new Set());districtProvs.get(p.short).add(p.province);}
 const uniqueDistricts=places.filter(p=>p.level===6&&p.province!=='กรุงเทพฯ'&&p.short.length>=7&&!p.short.startsWith('บ้าน')&&!p.short.startsWith('เมือง')&&districtProvs.get(p.short).size===1).sort((a,b)=>b.short.length-a.short.length);
 return {provinces,byProvince,districtsByName,subByName,provTerms,bkkBare,byProvDistricts,uniqueDistricts};
}

// Returns places mentioned, most specific first; ambiguous district/subdistrict names need their province in the text.
export function extractPlaces(text,g){
 const found=new Map(),provHits=new Set();let rest=text;
 for(const [term,p] of g.provTerms){
  const thai=/[ก-๙]/.test(term);
  // a province name right after ถนน/ถ. is a road (ถ.เพชรบุรี in Bangkok), not the province
  const re=thai?(AMBIGUOUS_PROVINCE.has(term)?new RegExp(`(?:จ\\.|จังหวัด|ชาว|เมือง)\\s*${esc(term)}`,'g'):new RegExp(`(?<!(?:ถนน|ถ\\.)\\s*)${esc(term)}`,'g')):new RegExp(`\\b${esc(term)}\\b`,'gi');
  if(re.test(rest)){provHits.add(p.short);rest=rest.replace(re,' ');}
 }
 const pick=(cands,level)=>{const inProv=cands.filter(c=>provHits.has(c.province));if(inProv.length)return inProv[0];if(cands.length===1)return cands[0];return null;};
 for(const m of text.matchAll(/(?:อ\.|อำเภอ|เขต)\s*([ก-๙]{2,30})/g)){for(let n=m[1].length;n>=2;n--){const c=g.districtsByName.get(m[1].slice(0,n))||g.districtsByName.get('เมือง'+m[1].slice(0,n));if(c){const p=pick(c,6);if(p)found.set('d'+p.id,{...p,precision:'district'});break;}}}
 for(const p of g.bkkBare)if(rest.includes(p.short)){const k=(p.level===6?'d':'s')+p.id;if(!found.has(k))found.set(k,{...p,precision:p.level===6?'district':'subdistrict'});provHits.add('กรุงเทพฯ');}
 for(const p of g.uniqueDistricts||[])if(rest.includes(p.short)&&!found.has('d'+p.id)){found.set('d'+p.id,{...p,precision:'district'});provHits.add(p.province);}
 for(const name of provHits)for(const p of g.byProvDistricts.get(name)||[])if(rest.includes(p.short)&&!found.has('d'+p.id))found.set('d'+p.id,{...p,precision:'district'});
 for(const m of text.matchAll(/(?:ต\.|ตำบล|แขวง)\s*([ก-๙]{2,30})/g)){for(let n=m[1].length;n>=2;n--){const c=g.subByName.get(m[1].slice(0,n));if(c){const p=pick(c,8);if(p)found.set('s'+p.id,{...p,precision:'subdistrict'});break;}}}
 const covered=new Set([...found.values()].map(p=>p.province));
 for(const name of provHits)if(!covered.has(name)){const p=g.byProvince.get(name);found.set('p'+p.id,{...p,precision:'province'});}
 const rank={subdistrict:0,district:1,province:2};
 return [...found.values()].sort((a,b)=>rank[a.precision]-rank[b.precision]).slice(0,25).map(p=>({name:p.name,short:p.short,province:p.province,lat:p.lat,lng:p.lng,precision:p.precision}));
}

// Social posts: hashtags such as #น้ำท่วมกทม are generic campaign tags, not where the post is about. Use the body first,
// and hashtags only when the body names no place at all.
export function extractPlacesSocial(text,g){const body=text.replace(/#\S+/g,' ');const p=extractPlaces(body,g);return p.length?p:extractPlaces(text,g);}

export const titleKey=t=>t.toLowerCase().replace(/[\s"'“”‘’!?,.:;()\-–—|]/g,'').slice(0,48);

// Chao Phraya Dam release figures in news text. Each hit keeps its phrase and a type:
//  actual  "ระบาย 1,950 ลบ.ม./วินาที", "เพิ่มจาก 1,750 เป็น 1,850" (the new value)
//  cap     "ไม่เกิน 2,000", "คุมไม่ให้เกิน"
//  plan    "จะ/คาดว่า/เตรียม/อาจ … 2,400", or a range (2,000-2,500)
// Only numbers within ~80 characters after a mention of the dam are read; plausible range 100-6,000 m3/s.
const DAM=/เขื่อนเจ้าพระยา|ท้ายเขื่อน(?:เจ้าพระยา)?/g;
export function extractDamRelease(text){
 const out=[],seen=new Set();
 for(const m of text.matchAll(DAM)){
  const win=text.slice(m.index,m.index+160);
  const from=win.match(/จาก\s*(\d[\d,]*)\s*(?:ลบ\.ม\.|ลูกบาศก์เมตร)?[^\d]{0,12}?เป็น\s*(\d[\d,]*)/);
  const cands=from?[[from[2],'actual',from[0]]]:[...win.matchAll(/((?:ไม่เกิน|ไม่ให้เกิน|สูงสุด|จะ|คาดว่า|คาดการณ์|เตรียม|อาจ|ปรับ(?:เพิ่ม)?(?:การระบาย)?(?:น้ำ)?เป็น|เพิ่ม(?:การระบาย)?(?:น้ำ)?เป็น|ระบาย(?:น้ำ)?|เขื่อนเจ้าพระยา)[^\d\n]{0,25}?)(\d[\d,]*)(?:\s*[-–]\s*(\d[\d,]*))?\s*(?:ลบ\.ม\.|ลูกบาศก์เมตร)/g)].map(x=>{
   const lead=x[1],v=x[3]||x[2];const type=/ไม่เกิน|ไม่ให้เกิน|สูงสุด/.test(lead)?'cap':(/จะ|คาดว่า|คาดการณ์|เตรียม|อาจ/.test(lead)||x[3])?'plan':'actual';return [v,type,x[0]];});
  for(const [v,type,phrase] of cands){const n=Number(String(v).replace(/,/g,''));if(!(n>=100&&n<=6000))continue;const k=n+type;if(seen.has(k))continue;seen.add(k);out.push({m3s:n,type,phrase:phrase.trim().slice(0,90)});}
 }
 return out;
}
