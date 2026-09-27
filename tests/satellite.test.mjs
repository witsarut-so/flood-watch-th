import test from 'node:test';import assert from 'node:assert/strict';
import {passInfo,encodeRing,satelliteObservations,summariseSatellite} from '../satellite.mjs';

test('pass time from the GISTDA file name (Thai time)',()=>{
 assert.deepEqual(passInfo('rd2_20260926_0613'),{id:'rd2_20260926_0613',sensor:'rd2',at:'2026-09-25T23:13:00.000Z'});
 assert.equal(passInfo('odd-name').at,null);});

test('largest ring kept, delta-encoded, near-duplicate points dropped',()=>{
 const small=[[[100,14],[100.001,14],[100.001,14.001],[100,14]]],big=[[[100.5,14.5],[100.51,14.5],[100.51,14.51],[100.50001,14.50001],[100.5,14.5]]];
 const r=encodeRing({type:'MultiPolygon',coordinates:[small,big]});
 let y=0,x=0;const pts=[];for(let i=0;i<r.length;i+=2){y+=r[i];x+=r[i+1];pts.push([y/1e5,x/1e5]);}
 assert.deepEqual(pts[0],[14.5,100.5]);assert.equal(pts.length,4);});

test('observations only for well-flooded cells, at the pass time; summary per district',()=>{
 const ring=encodeRing({type:'Polygon',coordinates:[[[100,14],[100.002,14],[100.002,14.002],[100,14.002],[100,14]]]});
 const s={passes:[passInfo('rd2_20260926_0613')],admins:['ต.ก|อ.ข|จ.ค'.replace(/(ต|อ|จ)\./g,'')],features:[[0,0,50000,120,2,30,ring],[0,0,1000,0,0,0,ring]]};
 const o=satelliteObservations(s);assert.equal(o.length,1);assert.equal(o[0].at,'2026-09-25T23:13:00.000Z');assert.ok(Math.abs(o[0].lat-14.0008)<.001);
 assert.deepEqual(summariseSatellite(s),[{province:'ค',district:'ข',floodKm2:.05,roadKm:.1,buildings:2,population:30,tambons:1}]);});
