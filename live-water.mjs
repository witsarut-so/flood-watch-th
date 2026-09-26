const endpoint='https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load';
let cache,pending;
const number=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
export function normalizeWater(data){
 if(data.waterlevel_data?.result!=='OK'||!Array.isArray(data.waterlevel_data.data))throw Error('Unexpected ThaiWater response');
 return data.waterlevel_data.data.map(r=>{const s=r.station||{};return {id:s.id,name:s.tele_station_name?.th||s.tele_station_oldcode||String(s.id),lat:number(s.tele_station_lat),lng:number(s.tele_station_long),levelMsl:number(r.waterlevel_msl),observedAt:/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(r.waterlevel_datetime||'')?r.waterlevel_datetime.replace(' ','T')+'+07:00':null,agency:r.agency?.agency_name?.th||'ไม่ระบุ',province:r.geocode?.province_name?.th||''};}).filter(s=>s.lat!==null&&s.lng!==null&&s.lat>=5&&s.lat<=21&&s.lng>=97&&s.lng<=106&&s.levelMsl!==null);
}
export async function getWater(){
 if(cache&&Date.now()-cache.cachedAt<300000)return cache.value;
 if(pending)return pending;
 pending=(async()=>{const response=await fetch(endpoint,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('ThaiWater HTTP '+response.status);const stations=normalizeWater(await response.json());const value={source:'ThaiWater / คลังข้อมูลน้ำแห่งชาติ',sourceUrl:'https://www.thaiwater.net/',fetchedAt:new Date().toISOString(),refreshSeconds:300,stations};cache={cachedAt:Date.now(),value};return value;})();
 try{return await pending;}finally{pending=null;}
}
