// Local server: serves public/ exactly as Vercel does (static files only) and, unless disabled, runs the
// same jobs GitHub Actions runs in production: evidence every EVIDENCE_INTERVAL_MINUTES, model every
// MODEL_INTERVAL_MINUTES. Outputs land in public/live/.
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {readFile,stat} from 'node:fs/promises';
import {extname,normalize,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runEvidenceJob,runModelJob} from './jobs.mjs';

const HOST=process.env.HOST||'127.0.0.1',PORT=Number(process.env.PORT)||3000;
const MODEL_EVERY=Number(process.env.MODEL_INTERVAL_MINUTES??120),EVIDENCE_EVERY=Number(process.env.EVIDENCE_INTERVAL_MINUTES??10);
const PUBLIC=fileURLToPath(new URL('./public/',import.meta.url));
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.geojson':'application/geo+json','.gz':'application/gzip','.svg':'image/svg+xml','.png':'image/png'};
const TEXT=new Set(['.html','.js','.css','.json','.geojson','.svg']);

http.createServer(async (req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');let path=decodeURIComponent(url.pathname);if(path.endsWith('/'))path+='index.html';
  const file=normalize(PUBLIC+path);if(!file.startsWith(PUBLIC)||file.includes(sep+'.'))return res.writeHead(404).end();
  const s=await stat(file).catch(()=>null);if(!s?.isFile())return res.writeHead(404,{'Content-Type':'text/plain'}).end('Not found');
  const ext=extname(file),live=path.startsWith('/live/');let body=await readFile(file);
  const headers={'Content-Type':TYPES[ext]||'application/octet-stream','Cache-Control':live?'no-cache':'public, max-age=300','X-Content-Type-Options':'nosniff'};
  if(TEXT.has(ext)&&/\bgzip\b/.test(req.headers['accept-encoding']||'')){headers['Content-Encoding']='gzip';body=gzipSync(body);}
  res.writeHead(200,headers);res.end(body);
 }catch(err){console.error(err);res.writeHead(500).end();}
}).listen(PORT,HOST,()=>console.log(`Flood Watch: http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}`));

const quiet=(name,p)=>p.then(r=>console.log(`[${name}]`,r)).catch(e=>console.error(`[${name}]`,e.message));
if(EVIDENCE_EVERY>0){quiet('evidence',runEvidenceJob());setInterval(()=>quiet('evidence',runEvidenceJob()),EVIDENCE_EVERY*60000).unref();}
if(MODEL_EVERY>0){quiet('model',runModelJob({ifOlderThanMinutes:MODEL_EVERY*.9}));setInterval(()=>quiet('model',runModelJob({ifOlderThanMinutes:MODEL_EVERY*.9})),10*60000).unref();}
