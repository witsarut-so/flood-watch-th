import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileReports} from '../evidence.mjs';

const now=Date.parse('2026-09-27T03:40:00Z');
const road=[[13.840,100.5696],[13.8467,100.5696],[13.853,100.5696]];  // ~1.4 km north-south through the sensor
const report=(at,extra={})=>({subkind:'bma-report',at,lat:13.8467,lng:100.5696,lines:[road.map(p=>[...p])],...extra});
const sensor=(at,cm)=>({kind:'sensor',at,lat:13.8467,lng:100.5696,depthCm:cm,title:'เซนเซอร์น้ำท่วมถนน ถ.งามวงศ์วาน ช่วงแยกเกษตร'});

test('reports older than 12 h are expired',()=>{
 const items=[report('2026-09-26T10:43:00Z')];assert.deepEqual(reconcileReports(items,now),{expired:1,clipped:0});assert.equal(items[0].expired,true);});

test('a newer dry sensor cuts the report line around it',()=>{
 const items=[report('2026-09-27T01:00:00Z'),sensor('2026-09-27T03:25:00Z',0)];
 assert.deepEqual(reconcileReports(items,now),{expired:0,clipped:1});const r=items[0];
 assert.equal(r.lines.length,2);  // north and south pieces remain
 for(const l of r.lines)for(const q of l)assert.ok(Math.abs(q[0]-13.8467)*111.32>.29);
 assert.ok(Math.abs(r.lat-13.8467)*111.32>.29);assert.equal(r.dryNow.length,1);
 const alone=[report('2026-09-27T01:00:00Z',{lines:[]}),sensor('2026-09-27T03:25:00Z',0)];reconcileReports(alone,now);assert.equal(alone[0].lat,null);});

test('wet or older sensors leave the report alone',()=>{
 const items=[report('2026-09-27T01:00:00Z'),sensor('2026-09-27T03:25:00Z',20),sensor('2026-09-27T00:30:00Z',0)];
 assert.deepEqual(reconcileReports(items,now),{expired:0,clipped:0});assert.equal(items[0].lines[0].length,3);});
