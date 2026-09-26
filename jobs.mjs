// Jobs shared by the local server and GitHub Actions. Outputs are static files under public/live/:
//   evidence.json, waterlevels.json            (runEvidenceJob)
//   model/latest.json, model/<runId>/*.bin.gz  (runModelJob)
// CLI: node jobs.mjs evidence | model [--force]
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,readdir,rm,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {modelInputs} from './model-inputs.mjs';
import {getEvidence} from './evidence.mjs';
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
 try{const w=await getWater();await writeAtomic(LIVE+'waterlevels.json',JSON.stringify(w));}catch(e){console.error('[waterlevels]',e.message);}
 return {fetchedAt:ev.fetchedAt,items:ev.items.length,errors:ev.errors.map(e=>e.source)};
}

let running=null;
export async function runModelJob({force=false,ifOlderThanMinutes=0}={}){
 if(running)return {skipped:'already running'};
 let last=null;try{last=await readJson(LIVE+'model/latest.json');}catch{}
 if(!force&&last&&ifOlderThanMinutes&&Date.now()-Date.parse(last.issuedAt)<ifOlderThanMinutes*60000)return {skipped:'recent run',runId:last.runId};
 running=(async()=>{
  const runId=new Date().toISOString().replace(/[:.]/g,'-');
  const data={...await modelInputs()};
  // Point observations for validation only (not assimilated): citizen flood reports and road sensors.
  try{const ev=await readJson(LIVE+'evidence.json');data.observations=ev.items.filter(i=>i.kind==='citizen'||(i.kind==='sensor'&&!i.subkind)).map(i=>({kind:i.kind,lat:i.lat,lng:i.lng,at:i.at,wet:i.kind==='citizen'||i.depthCm>=5}));data.evidenceFetchedAt=ev.fetchedAt;}
  catch{data.observations=[];}
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
 const task=job==='evidence'?runEvidenceJob():job==='model'?runModelJob({force:flag==='--force'}):Promise.reject(Error('usage: node jobs.mjs evidence|model [--force]'));
 task.then(r=>{console.log(JSON.stringify(r));process.exit(0);}).catch(e=>{console.error(e.stderr||e.message);process.exit(1);});
}
