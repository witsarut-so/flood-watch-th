import test from 'node:test';
import assert from 'node:assert/strict';
import {routeFlow,trend,canalSummary} from '../forecast.mjs';

test('a branch receives only its share of the upstream change, after the travel time', () => {
 const up=[1000,1000,1000,1000,1300,1300,1300,1300,1300,1300],q=[500,500,500,500,500,null,null,null,null,null];
 const out=routeFlow(q,up,2,4,9);
 assert.equal(out[5],500);           // upstream 2 h earlier (i=3) unchanged
 assert.equal(out[6],650);           // share 500/1000 of +300
 assert.equal(out[9],650);
});

test('trend is damped and capped by the largest 36 h change seen', () => {
 const lvl=new Array(300).fill(null);for(let i=0;i<=250;i++)lvl[i]=10+(i>=244?(i-244)*.5:0);  // a jump of 3 m in the last 6 h
 const out=trend(lvl,250,286);
 const cap=3;assert.ok(out[286]-lvl[250]<=cap+1e-9);
 assert.ok(out[251]>lvl[250]&&out[260]>out[251]);
});

test('canal summary ranks canals by worst live station', () => {
 const mk=(code,canal,state,overM,offline=false)=>({subkind:'bma-canal',code,canal,state,overM,offline,title:code+': x',district:'เขต',lat:13.8,lng:100.6,at:'2026-09-30T05:00:00Z',source:'BMA',levelM:1,trendMPerH:.02});
 const s=canalSummary({items:[mk('A1','คลองเอ','normal',-.3),mk('B1','คลองบี','critical',.4),mk('B2','คลองบี','offline',null,true),mk('C1','คลองซี','warning',-.05)]});
 assert.deepEqual(s.canals.map(c=>c.canal),['คลองบี','คลองซี','คลองเอ']);
 assert.equal(s.canals[0].critical,1);assert.equal(s.counts.offline,1);
});
