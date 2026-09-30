// Jobs shared by the local server and GitHub Actions. Outputs are static files under public/live/:
//   evidence.json, waterlevels.json, forecast.json (runEvidenceJob)
//   model/latest.json, model/<runId>/*.bin.gz  (runModelJob)
// CLI: node jobs.mjs evidence | model [--force] | thai [--no-upload]
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,readdir,rm,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {modelInputs} from './model-inputs.mjs';
import {getEvidence,bmaFloodAlert,bmaCanals,traffyDirect,textContext} from './evidence.mjs';
import {buildForecast} from './forecast.mjs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {getWater} from './live-water.mjs';

const run=promisify(execFile),root=fileURLToPath(new URL('.',import.meta.url));
const LIVE=root+'public/live/',RUNS=root+'data/runs/';
const PYTHON=process.env.PYTHON||root+'.venv/bin/python',KEEP_RUNS=Number(process.env.KEEP_RUNS)||2;
const readJson=async p=>JSON.parse(await readFile(p,'utf8'));
async function writeAtomic(path,text){await writeFile(path+'.tmp',text);await rename(path+'.tmp',path);}

export async function runEvidenceJob(){
 await mkdir(LIVE,{recursive:true});
 const ev=await getEvidence({wait:true});const {refreshing,...clean}=ev;
 await writeAtomic(LIVE+'evidence.json',JSON.stringify(clean));
 await writeAtomic(LIVE+'evidence-lite.json',JSON.stringify(liteEvidence(clean)));
 try{const w=await getWater();await writeAtomic(LIVE+'waterlevels.json',JSON.stringify(w));}catch(e){console.error('[waterlevels]',e.message);}
 try{await writeAtomic(LIVE+'forecast.json',JSON.stringify(await buildForecast({evidence:clean})));}catch(e){console.error('[forecast]',e.message);}
 return {fetchedAt:ev.fetchedAt,items:ev.items.length,errors:ev.errors.map(e=>e.source)};
}

// Thai relay (run on a machine in Thailand, e.g. by launchd every 30 min): fetch the sources that only answer from
// Thai networks and upload data/evidence/thai.json.gz to release "live". A source that fails this round keeps its
// previous successful part, so one bad pull never blanks the map.
const RELAY_REPO=process.env.RELAY_REPO||'witsarut-so/flood-watch-th',RELAY_GH_USER=process.env.RELAY_GH_USER||'witsarut-so';
// Start the evidence workflow unless one is queued/running, and the model workflow when the last one started
// MODEL_EVERY_H or more ago. Both share the concurrency group live-data, so they never overlap.
const MODEL_EVERY_H=2;
async function dispatchWorkflows(env){
 const list=async wf=>JSON.parse((await run('gh',['run','list','-R',RELAY_REPO,'-w',wf,'-L','1','--json','status,createdAt'],{env})).stdout)[0];
 const out=[];
 for(const wf of ['evidence.yml','model.yml']){
  const last=await list(wf),busy=last&&last.status!=='completed',age=last?(Date.now()-Date.parse(last.createdAt))/3600000:Infinity;
  if(busy||(wf==='model.yml'&&age<MODEL_EVERY_H-.1))continue;
  await run('gh',['workflow','run',wf,'-R',RELAY_REPO],{env});out.push(wf);}
 return out;}

export async function runThaiJob({upload=true}={}){
 const {gaz,idx}=await textContext(),file=root+'data/evidence/thai.json.gz',now=new Date().toISOString();
 let prev={};try{prev=JSON.parse(gunzipSync(await readFile(file)));}catch{}
 const out={fetchedAt:now,bma:prev.bma||null,traffy:prev.traffy||null,canals:prev.canals||null},errors=[],report={};
 try{const items=await bmaFloodAlert(gaz,idx);if(!items.length)throw Error('no items');out.bma={ok:true,fetchedAt:now,items};report.bma=items.length;}catch(e){report.bma='failed: '+e.message;}
 try{const items=await bmaCanals();if(!items.length)throw Error('no items');out.canals={ok:true,fetchedAt:now,items};report.canals=items.length;}catch(e){report.canals='failed: '+e.message;}
 try{const items=await traffyDirect(errors,idx);if(!items.length||items[0].stale)throw Error(errors.at(-1)?.error||'no fresh items');out.traffy={ok:true,fetchedAt:now,items};report.traffy=items.length;}catch(e){report.traffy='failed: '+String(e.message).slice(0,120);}
 await mkdir(root+'data/evidence',{recursive:true});await writeFile(file,gzipSync(JSON.stringify(out)));
 if(upload){const token=(await run('gh',['auth','token','-u',RELAY_GH_USER])).stdout.trim();
  const env={...process.env,GH_TOKEN:token};await run('gh',['release','upload','live',file,'--clobber','-R',RELAY_REPO],{env});report.uploaded=true;
  // GitHub's cron often runs late or skips; while this Mac is on it is the clock. Cron stays as the fallback.
  try{report.dispatched=await dispatchWorkflows(env);}catch(e){report.dispatched='failed: '+String(e.message).slice(0,120);}}
 return {fetchedAt:now,...report};
}

// First-load version for phones: citizen reports from the last LITE_HOURS only (the default filter), and fields the page
// never shows removed. The page fetches the full evidence.json only when a longer report window is chosen.
const LITE_HOURS=6,DROP=['excerpt','depthPhrases','feed','relevance','articleRead','precisionNote'];
export function liteEvidence(ev){
 const cutoff=Date.now()-LITE_HOURS*3600000;
 const items=ev.items.filter(i=>i.kind!=='citizen'||Date.parse(i.at)>=cutoff).map(i=>{const o={...i};for(const k of DROP)delete o[k];if(o.kind==='news'&&o.places)o.places=o.places.slice(0,5);return o;});
 return {...ev,items,lite:{citizenHours:LITE_HOURS,citizenTotal:ev.items.filter(i=>i.kind==='citizen').length}};
}

let running=null;
export async function runModelJob({force=false,ifOlderThanMinutes=0}={}){
 if(running)return {skipped:'already running'};
 let last=null;try{last=await readJson(LIVE+'model/latest.json');}catch{}
 if(!force&&last&&ifOlderThanMinutes&&Date.now()-Date.parse(last.issuedAt)<ifOlderThanMinutes*60000)return {skipped:'recent run',runId:last.runId};
 running=(async()=>{
  const runId=new Date().toISOString().replace(/[:.]/g,'-');
  const data={...await modelInputs()};
  // Point observations for validation only (not assimilated): open citizen reports (resolved tickets say nothing about the water now), BMA official flooded roads/reports (wet), road sensors (0 = dry).
  // News-outlet social posts that name a specific road (resolved to OSM) add wet points at that road.
  try{const ev=await readJson(LIVE+'evidence.json');data.observations=ev.items.filter(i=>(i.kind==='citizen'&&i.status!=='เสร็จสิ้น')||(i.kind==='sensor'&&!i.subkind)||((i.subkind==='bma-road'||i.subkind==='bma-report')&&!i.expired&&i.precision==='point'&&Number.isFinite(i.lat))).map(i=>({kind:i.subkind?.startsWith('bma')?'bma':i.kind,lat:i.lat,lng:i.lng,at:i.at,wet:i.kind==='citizen'||i.subkind?.startsWith('bma')||i.depthCm>=5}));for(const i of ev.items)if(i.subkind==='media')for(const g of i.geo||[])if(g.drawn&&g.lines?.[0]?.length){const p=g.lines[0][Math.floor(g.lines[0].length/2)];data.observations.push({kind:'media',lat:p[0],lng:p[1],at:i.at,wet:true});}data.damRelease=ev.damRelease||null;data.evidenceFetchedAt=ev.fetchedAt;}
  catch{data.observations=[];}
  // forward run: routed inflows (dam release plans) and rain forecast from forecast.json when it is fresh (< 3 h)
  try{const fc=await readJson(LIVE+'forecast.json');if(Date.now()-Date.parse(fc.issuedAt)<3*3600000&&fc.modelDrivers)data.forecast={...fc.modelDrivers,issuedAt:fc.issuedAt,plans:fc.plans.dams.map(d=>({id:d.id,name:d.name,schedule:d.schedule,high:d.high||null}))};}catch{}
  // ThaiWater's BMA canal readings can stall; then use the live BMA levels (with ThaiWater thresholds) from the evidence feed
  if(!data.canalLimits?.length)try{const ev=await readJson(LIVE+'evidence.json');data.canalLimits=ev.items.filter(i=>i.subkind==='bma-canal'&&!i.offline&&i.criticalM!=null&&Date.now()-Date.parse(i.at)<=3*3600000).map(i=>({id:i.code,name:i.canal,lat:i.lat,lng:i.lng,at:i.at,levelM:i.levelM,warningM:i.warningM,criticalM:i.criticalM,bankM:i.bankM}));}catch{}
  await mkdir(RUNS,{recursive:true});const input=RUNS+runId+'-input.json',out=LIVE+'model/'+runId+'/';
  await writeFile(input,JSON.stringify(data));
  await run(PYTHON,[root+'model/run.py',input,out],{cwd:root,timeout:3*3600000,maxBuffer:1e6});
  const result=await readJson(out+'result.json');
  await writeAtomic(LIVE+'model/latest.json',JSON.stringify({...result,runId,base:`/live/model/${runId}/`}));
  // keep the newest KEEP_RUNS run folders (the one just published plus the previous, for clients mid-load)
  const dirs=(await readdir(LIVE+'model',{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
  for(const d of dirs.slice(0,Math.max(0,dirs.length-KEEP_RUNS)))await rm(LIVE+'model/'+d,{recursive:true,force:true});
  const inputs=(await readdir(RUNS)).filter(n=>n.endsWith('-input.json')).sort();for(const n of inputs.slice(0,Math.max(0,inputs.length-12)))await rm(RUNS+n,{force:true});
  return {runId,domains:Object.fromEntries(result.domains.map(d=>[d.id,d.skipped?'skipped: '+d.skipped:d.endAt]))};
 })();
 try{return await running;}finally{running=null;}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [job,flag]=process.argv.slice(2);
 const task=job==='evidence'?runEvidenceJob():job==='thai'?runThaiJob({upload:flag!=='--no-upload'}):job==='model'?runModelJob({force:flag==='--force'}):Promise.reject(Error('usage: node jobs.mjs evidence | model [--force] | thai [--no-upload]'));
 task.then(r=>{console.log(JSON.stringify(r));process.exit(0);}).catch(e=>{console.error(e.stderr||e.message);process.exit(1);});
}
