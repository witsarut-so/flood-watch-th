import test from 'node:test';import assert from 'node:assert/strict';
import {parseRangsitWatch,rangsitReports,parsePakkret} from '../evidence.mjs';

test('Rangsit watch points come out of the Next.js payload with their flag level', () => {
 const watch=(id,name,lat,lng,w)=>`{"id":${id},"name":"${name}","description":null,"latitude":${lat},"longitude":${lng},"watch":${JSON.stringify(w).replace('"updatedAt":"','"updatedAt":"$D')}}`;
 const payload='x:'+watch(151,'สะพานแดง',13.986,100.626,{label:'คลองรังสิตประยูรศักดิ์ (สะพานแดง)',level:'CRITICAL',updatedAt:'2026-10-07T17:06:15.097Z',mode:'AUTO',cvLevel:null,cvReason:'หาเสาเข็มไม่เจอ'})
  +','+watch(152,'เมืองปทุม',14.023,100.536,{label:'จังหวัดปทุมธานี (เมืองปทุม)',level:'NEAR_CRITICAL',updatedAt:'2026-10-07T17:06:15.205Z',mode:'AUTO',cvLevel:'NEAR_CRITICAL',cvReason:'ผิวน้ำ ≈2.53 ม.รทก. ค่ากลาง 15 ภาพ'});
 const html=`<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
 const pts=parseRangsitWatch(html);
 assert.deepEqual(pts.map(p=>[p.state,p.levelM,p.at]),[['critical',null,'2026-10-07T17:06:15.097Z'],['warning',2.53,'2026-10-07T17:06:15.205Z']]);
 assert.match(pts[0].how,/อ่านไม่ได้/);
});

test('Rangsit reports: last 72 h only, depth from the class', () => {
 const now=Date.parse('2026-10-08T00:00:00Z');
 const r=rangsitReports([{code:'WVZAJAUDTU',latitude:14.0,longitude:100.62,waterLevel:'KNEE',locationName:'ตำบลคลองหนึ่ง',description:null,createdAt:'2026-10-07T06:15:38Z'},
  {code:'OLDOLDOLD1',latitude:14.0,longitude:100.62,waterLevel:'WAIST',locationName:'x',createdAt:'2026-10-01T00:00:00Z'}],now);
 assert.equal(r.length,1);assert.equal(r[0].depthCm,40);assert.equal(r[0].kind,'citizen');assert.match(r[0].photo,/api\/flood\/image\/WVZAJAUDTU$/);
});

test('Pak Kret sensor: level, time and the municipal flag thresholds', () => {
 const g=parsePakkret('<div>Sensor วัดระดับน้ำ(หัวถนน)</div><p>2026-10-08 00:05:06.000</p><p>ระดับน้ำ: 2.15 เมตร รทก.</p><b>เฝ้าระวัง</b>')[0];
 assert.equal(g.levelM,2.15);assert.equal(g.state,'watch');assert.equal(g.at,'2026-10-07T17:05:06.000Z');
 assert.equal(parsePakkret('2026-10-08 00:05:06 ระดับน้ำ: 2.31 เมตร')[0].state,'critical');
 assert.deepEqual(parsePakkret('ไม่มีข้อมูล'),[]);
});
