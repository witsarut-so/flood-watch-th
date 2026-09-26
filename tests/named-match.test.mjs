import test from 'node:test';import assert from 'node:assert/strict';
import {buildNamedIndex,matchNamed} from '../named-match.mjs';
const F=[{name:'ซอยรามคำแหง 43/1',kind:'road',province:'กรุงเทพฯ',lat:13.76,lng:100.6,lengthM:900,lines:[[[13.76,100.6],[13.761,100.601]]]},
 {name:'ถนนพหลโยธิน',kind:'road',province:'กรุงเทพฯ',lat:13.85,lng:100.56,lengthM:30000,lines:[[[13.80,100.55],[13.85,100.56],[13.90,100.57]]]},
 {name:'ถนนพหลโยธิน',kind:'road',province:'สระบุรี',lat:14.5,lng:100.9,lengthM:60000,lines:[[[14.3,100.8],[14.5,100.9],[14.7,101.0]]]},
 {name:'หมู่บ้านพฤกษา 5',kind:'village',province:'ปทุมธานี',lat:14.0,lng:100.6,lengthM:500,lines:[[[14.0,100.6],[14.001,100.6]]]}];
const idx=buildNamedIndex(F);
test('abbreviations and village names resolve when unique',()=>{const m=matchNamed('น้ำเข้ามบ.พฤกษา 5 สูง 40 ซม.',idx);assert.equal(m[0].name,'หมู่บ้านพฤกษา 5');assert.ok(m[0].drawn);});
test('bare soi names are found in headlines',()=>{assert.equal(matchNamed('เปิด 20 จุดน้ำท่วมกรุง รามคำแหง 43/1',idx,{bareScan:true})[0].name,'ซอยรามคำแหง 43/1');});
test('ambiguous road is listed but not drawn',()=>{const m=matchNamed('น้ำท่วม ถ.พหลโยธิน',idx);assert.equal(m[0].ambiguous,true);assert.equal(m[0].drawn,false);});
test('province context picks the right cluster; long road without local anchor is not drawn whole',()=>{const m=matchNamed('น้ำท่วม ถ.พหลโยธิน จ.สระบุรี',idx,{places:[{province:'สระบุรี',precision:'province'}]});assert.equal(m[0].province,'สระบุรี');assert.equal(m[0].drawn,false);});
test('a report position clips a long road to the nearby part',()=>{const m=matchNamed('น้ำท่วมถนนพหลโยธิน',idx,{lat:13.851,lng:100.561});assert.equal(m[0].province,'กรุงเทพฯ');assert.ok(m[0].clipped);assert.ok(m[0].lines.every(l=>l.every(p=>Math.abs(p[0]-13.85)<.01)));});
test('a soi number is not matched to a shorter number',()=>{const i2=buildNamedIndex([{name:'ซอยรามอินทรา 6',kind:'road',province:'กรุงเทพฯ',lat:13.87,lng:100.63,lengthM:600,lines:[[[13.87,100.63],[13.871,100.631]]]}]);assert.equal(matchNamed('น้ำท่วมซอยรามอินทรา 68 แยก 5',i2,{lat:13.87,lng:100.63}).length,0);});
test('unnumbered words inside other words are not bare-matched',()=>{const i2=buildNamedIndex([{name:'ถนนมหานคร',kind:'road',province:'กรุงเทพฯ',lat:13.7,lng:100.5,lengthM:900,lines:[[[13.7,100.5],[13.701,100.5]]]}]);assert.equal(matchNamed('ฝนตกหนักทั่วกรุงเทพมหานคร',i2,{bareScan:true,places:[{province:'กรุงเทพฯ',precision:'province'}]}).length,0);});
