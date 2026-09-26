import test from 'node:test';import assert from 'node:assert/strict';
import {parseRss,relevance,extractDepth,extractFacts,extractPlaces,extractPlacesSocial,buildGazetteer,redact,titleKey} from '../evidence-text.mjs';
const g=buildGazetteer([
 {id:1,level:4,short:'กรุงเทพฯ',en:'Bangkok',province:'กรุงเทพฯ',lat:13.75,lng:100.5,name:'กรุงเทพมหานคร'},
 {id:2,level:4,short:'นนทบุรี',en:'Nonthaburi',province:'นนทบุรี',lat:13.86,lng:100.51,name:'จังหวัดนนทบุรี'},
 {id:3,level:4,short:'เลย',en:'Loei',province:'เลย',lat:17.49,lng:101.72,name:'จังหวัดเลย'},
 {id:4,level:6,short:'ลาดกระบัง',en:'',province:'กรุงเทพฯ',lat:13.72,lng:100.78,name:'เขตลาดกระบัง'},
 {id:5,level:6,short:'บางบัวทอง',en:'',province:'นนทบุรี',lat:13.91,lng:100.42,name:'อำเภอบางบัวทอง'},
 {id:6,level:6,short:'เมือง',en:'',province:'เลย',lat:17.5,lng:101.7,name:'อำเภอเมือง'},
 {id:8,level:4,short:'สระแก้ว',en:'Sa Kaeo',province:'สระแก้ว',lat:13.8,lng:102.07,name:'จังหวัดสระแก้ว'},
 {id:9,level:6,short:'อรัญประเทศ',en:'',province:'สระแก้ว',lat:13.69,lng:102.5,name:'อำเภออรัญประเทศ'},
 {id:7,level:8,short:'สนามบิน',en:'',province:'กรุงเทพฯ',district:'ดอนเมือง',lat:13.9,lng:100.6,name:'แขวงสนามบิน'},
]);
test('parses RSS items and strips Google publisher suffix',()=>{
 const xml='<rss><channel><item><title><![CDATA[น้ำท่วมหนัก - Thai PBS]]></title><link>https://x.test/a</link><pubDate>Sat, 26 Sep 2026 03:00:00 GMT</pubDate><description>&lt;p&gt;ระดับน้ำ&lt;/p&gt;</description><source url="https://thaipbs">Thai PBS</source></item></channel></rss>';
 const [i]=parseRss(xml,{name:'G',google:true});
 assert.equal(i.title,'น้ำท่วมหนัก');assert.equal(i.publisher,'Thai PBS');assert.equal(i.summary,'ระดับน้ำ');assert.equal(i.publishedAt,'2026-09-26T03:00:00.000Z');
});
test('relevance needs a strong term or two weak ones, and ignores idioms',()=>{
 assert.ok(relevance('น้ำท่วมถนนสุขุมวิท').relevant);assert.ok(relevance('ฝนตกหนัก ระดับน้ำเพิ่ม').relevant);
 assert.ok(!relevance('ฝนตกหนัก').relevant);assert.ok(!relevance('แฟนบอลท่วมท้นสนาม').relevant);
});
test('depth: numbers with units, ranges, metres, body-part estimates',()=>{
 assert.equal(extractDepth('น้ำท่วมขังสูงประมาณ 30-40 ซม.')[0].cm,40);
 assert.equal(extractDepth('ระดับน้ำสูง 1.2 เมตร')[0].cm,120);
 const e=extractDepth('น้ำท่วมระดับเข่า');assert.equal(e[0].cm,45);assert.equal(e[0].estimated,true);
 assert.equal(extractDepth('ฝนตก 30 มม.').length,0);
});
test('facts keep quoted figures',()=>{assert.deepEqual(extractFacts('น้ำท่วม 21 จังหวัด กระทบ 2.7 หมื่นครัวเรือน'),['2.7 หมื่นครัวเรือน','21 จังหวัด']);});
test('places: prefixed district resolved by province, Bangkok aliases, ambiguous words need prefix',()=>{
 const a=extractPlaces('น้ำท่วม อ.บางบัวทอง จ.นนทบุรี',g);assert.equal(a[0].short,'บางบัวทอง');assert.equal(a[0].precision,'district');
 assert.equal(extractPlaces('น้ำท่วมลาดกระบัง',g)[0].short,'ลาดกระบัง');
 assert.equal(extractPlaces('น้ำท่วมกรุง',g)[0].short,'กรุงเทพฯ');
 assert.equal(extractPlaces('ไม่ท่วมเลย',g).length,0);
 assert.equal(extractPlaces('น้ำท่วม จ.เลย',g)[0].short,'เลย');
 assert.ok(!extractPlaces('สนามบินปิด',g).some(p=>p.short==='สนามบิน'));
 assert.equal(extractPlaces('Floods hit Bangkok',g)[0].short,'กรุงเทพฯ');
});
test('redacts phone numbers and e-mails',()=>{assert.equal(redact('โทร 081-234-5678 a@b.co'),'โทร [เบอร์โทร] [อีเมล]');});
test('title key collapses punctuation and spacing',()=>{assert.equal(titleKey('น้ำท่วม, "หนัก"!'),titleKey('น้ำท่วม หนัก'));});
test('social posts: body places beat generic hashtags; unique long district names need no prefix',()=>{
 const p=extractPlacesSocial('อรัญประเทศอ่วมหนัก มวลน้ำเข้าท่วม #น้ำท่วม #น้ำท่วมกทม',g);assert.equal(p[0].short,'อรัญประเทศ');assert.ok(!p.some(x=>x.short==='กรุงเทพฯ'));
 assert.equal(extractPlacesSocial('ฝนตกหนักมาก #น้ำท่วมกทม',g)[0].short,'กรุงเทพฯ');
});
test('a road named after a province is not that province',()=>{assert.ok(!extractPlaces('น้ำท่วม ถ.เพชรบุรี และ ถนนนนทบุรี',buildGazetteer([{id:1,level:4,short:'นนทบุรี',en:'',province:'นนทบุรี',lat:13.8,lng:100.5,name:'จังหวัดนนทบุรี'}])).length);});
