// Vercel build step (Git integration): fetch the data that is not in the repo, then serve public/.
//   release data-v1 / prepared-data.tar.gz -> public/data   (prepared map data, rarely changes)
//   release live    / live.tar.gz          -> public/live   (latest evidence + model, updated by GitHub Actions)
// A missing live asset is not fatal: the site then shows "no data yet" until the first Actions run.
import {execSync} from 'node:child_process';
import {mkdirSync,existsSync,rmSync} from 'node:fs';
const repo=process.env.DATA_REPO||'witsarut-so/flood-watch-th';
const url=(tag,file)=>`https://github.com/${repo}/releases/download/${tag}/${file}`;
const sh=cmd=>execSync(cmd,{stdio:'inherit',shell:'/bin/bash'});

rmSync('public/reports',{recursive:true,force:true});  // never publish local-only photos
mkdirSync('.data-tmp',{recursive:true});
sh(`curl -fsSL --retry 3 "${url('data-v1','prepared-data.tar.gz')}" | tar xz -C .data-tmp public/data`);
rmSync('public/data',{recursive:true,force:true});sh('mv .data-tmp/public/data public/data');
try{sh(`curl -fsSL --retry 3 "${url('live','live.tar.gz')}" | tar xz public/live`);}
catch{console.warn('No live data release yet; deploying without /live');mkdirSync('public/live',{recursive:true});}
rmSync('.data-tmp',{recursive:true,force:true});
console.log('data:',existsSync('public/data/domains.json'),'live:',existsSync('public/live/evidence.json'),existsSync('public/live/model/latest.json'));
