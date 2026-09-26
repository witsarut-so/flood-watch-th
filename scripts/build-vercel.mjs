// Assemble a Vercel prebuilt deployment (Build Output API v3) from public/: the page, /data (prepared
// static data) and /live (latest job outputs). Deploy with: vercel deploy --prebuilt --prod
import {cp,mkdir,rm,writeFile,readdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),out=root+'.vercel/output/';
const SKIP=new Set(['reports']);  // never publish the local-only photo folder
const CSP=["default-src 'self'","script-src 'self' https://unpkg.com","style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com","font-src https://fonts.gstatic.com","img-src 'self' data: blob: https://unpkg.com https://tile.openstreetmap.org https://storage.googleapis.com https://cdn.bsky.app","connect-src 'self'","frame-ancestors 'none'","base-uri 'self'","form-action 'self'"].join('; ');

await rm(out,{recursive:true,force:true});await mkdir(out+'static',{recursive:true});
for(const name of await readdir(root+'public'))if(!SKIP.has(name))await cp(root+'public/'+name,out+'static/'+name,{recursive:true});
await writeFile(out+'config.json',JSON.stringify({version:3,routes:[
 {src:'/(.*)',headers:{'Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Permissions-Policy':'geolocation=(self), camera=(), microphone=()'},continue:true},
 {src:'/live/model/[^/]+/(.*)',headers:{'Cache-Control':'public, max-age=86400, immutable'},continue:true},
 {src:'/live/(.*)',headers:{'Cache-Control':'public, max-age=0, must-revalidate'},continue:true},
 {src:'/data/(.*)',headers:{'Cache-Control':'public, max-age=3600'},continue:true},
 {handle:'filesystem'},
]},null,1));
let files=0,bytes=0;async function walk(d){for(const e of await readdir(d,{withFileTypes:true})){const p=d+'/'+e.name;if(e.isDirectory())await walk(p);else{files++;bytes+=(await stat(p)).size;}}}
await walk(out+'static');console.log(JSON.stringify({files,megabytes:+(bytes/1e6).toFixed(1)}));
