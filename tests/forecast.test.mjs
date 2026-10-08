import test from 'node:test';
import assert from 'node:assert/strict';
import {routeFlow,trend,canalSummary,newsSteps,autoPlans,combineRain,canalAhead} from '../forecast.mjs';

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

const pt=(at,m3s,source)=>({at,m3s,source,type:'actual',phrase:`${m3s}`,url:'https://x.test/'+source});
test('news release counts once two outlets agree; a lone figure is ignored; announced later steps are kept', () => {
 const now=Date.parse('2026-10-07T12:00Z');
 const [c]=newsSteps([pt('2026-10-06T00:00Z',2500,'A'),pt('2026-10-06T05:00Z',2500,'B'),pt('2026-10-07T01:00Z',2400,'C'),pt('2026-10-07T03:00Z',2400,'D'),pt('2026-10-07T09:00Z',1700,'E')],now);
 assert.equal(c.m3s,2400);assert.equal(new Date(c.from).toISOString(),'2026-10-07T01:00:00.000Z');assert.deepEqual(c.sources,['C','D']);
 assert.deepEqual(newsSteps([pt('2026-10-07T01:00Z',2400,'C'),pt('2026-10-07T03:00Z',2400,'C')],now),[]);  // same outlet twice
 const at23={effectiveAt:'2026-10-07T16:00:00.000Z'};
 const s=newsSteps([pt('2026-10-07T06:00Z',2400,'A'),pt('2026-10-07T07:00Z',2400,'B'),{...pt('2026-10-07T10:00Z',2350,'C'),...at23},{...pt('2026-10-07T11:00Z',2350,'D'),...at23},pt('2026-10-07T11:30Z',2400,'E')],now);
 assert.deepEqual(s.map(x=>[x.m3s,new Date(x.from).toISOString()]),[['2400','2026-10-07T06:00:00.000Z'],['2350','2026-10-07T16:00:00.000Z']].map(([v,t])=>[+v,t]));
});

test('auto plans: measured dam release and agreed news add steps, a stale high scenario is renewed, newer hand steps win', () => {
 const now=Date.parse('2026-10-08T12:00:00+07:00');
 const plans={updatedAt:'2026-10-07T20:30:00+07:00',dams:[
  {id:'chaophraya',name:'เขื่อนเจ้าพระยา (ชัยนาท)',station:'C.13',schedule:[{from:'2026-10-07T13:00:00+07:00',m3s:2400}],high:{m3s:2500,by:'2026-10-08T00:00:00+07:00',why:'old'}},
  {id:'pasak',name:'เขื่อนป่าสักชลสิทธิ์ (ลพบุรี)',schedule:[{from:'2026-10-03T00:00:00+07:00',m3s:500}]}]};
 const evidence={damRelease:{points:[pt('2026-10-08T01:00Z',2200,'A'),pt('2026-10-08T02:00Z',2200,'B')]},
  items:[{kind:'news',at:'2026-10-08T03:00Z',title:'เขื่อนเจ้าพระยาลดระบายเหลือ 2,200',source:'A',sourceUrl:'u1'},{kind:'news',at:'2026-10-08T02:00Z',title:'ฝนตกหนักภาคใต้',source:'B',sourceUrl:'u2'}]};
 const dams=[{name:'เขื่อนป่าสักชลสิทธิ์',date:'2026-10-08',releaseM3s:350,storagePct:104}];
 const p=autoPlans(plans,{dams,evidence,gauges:{'C.13':{now:2210,max10d:2520}},now});
 const cp=p.dams[0],ps=p.dams[1];
 assert.deepEqual(cp.schedule.map(s=>[s.m3s,!!s.auto]),[[2400,false],[2200,true]]);
 assert.equal(cp.high.m3s,2550);assert.ok(cp.high.auto);assert.equal(cp.news.length,1);
 assert.deepEqual(ps.schedule.map(s=>[s.m3s,!!s.auto]),[[500,false],[350,true]]);
 assert.equal(plans.dams[0].schedule.length,1);  // input untouched
 // a hand-made step newer than the reports wins; a release within 5 % of the plan adds nothing
 const q=autoPlans({...plans,dams:[{...plans.dams[0],schedule:[{from:'2026-10-08T10:00:00+07:00',m3s:2300}]},plans.dams[1]]},{dams:[{...dams[0],releaseM3s:510}],evidence,now});
 assert.equal(q.dams[0].schedule.length,1);assert.equal(q.dams[1].schedule.length,1);
 // an agreed step announced for tonight is added ahead of time
 const ev2={damRelease:{points:[pt('2026-10-08T01:00Z',2400,'A'),pt('2026-10-08T02:00Z',2400,'B'),{...pt('2026-10-08T03:00Z',2350,'C'),effectiveAt:'2026-10-08T16:00:00.000Z'},{...pt('2026-10-08T04:00Z',2350,'D'),effectiveAt:'2026-10-08T16:00:00.000Z'}]},items:[]};
 const f=autoPlans(plans,{evidence:ev2,now});
 assert.deepEqual(f.dams[0].schedule.map(s=>[s.from,s.m3s]),[['2026-10-07T13:00:00+07:00',2400],['2026-10-08T16:00:00.000Z',2350]]);
});

test('rain: model mean, models that agree, Google first where it has the hour', () => {
 const now=Date.parse('2026-10-08T05:00:00Z'),times=[],mk=v=>Array.from({length:40},()=>v);
 for(let i=0;i<40;i++)times.push(now-5*3600000+i*3600000);  // totals ending at each hour
 const om=[{times,models:{ECMWF:{mm:mk(1),prob:mk(50),code:mk(95)},GFS:{mm:mk(0),prob:mk(10),code:mk(3)}}}];
 const [r]=combineRain(om,null,now,[['x',13.7,100.5]]);
 assert.equal(r.windows[12].mm,6);assert.deepEqual(r.windows[12].models,{ECMWF:12,GFS:0});assert.equal(r.windows[12].wetModels,1);
 assert.equal(r.windows[12].condition,'ฝนเล็กน้อย');  // one model with thunder is not enough
 const gw={points:[Array.from({length:37},(_,i)=>({t:now+i*3600000,mm:3,prob:90,thunder:40,text:'ฝนฟ้าคะนอง'}))]};
 const [g]=combineRain(om,gw,now,[['x',13.7,100.5]]);
 assert.equal(g.windows[12].mm,36);assert.equal(g.windows[12].condition,'ฝนฟ้าคะนอง');assert.equal(g.windows[12].thunderPct,40);
});

test('canal ahead: trend carried forward, damped and capped; BMA status kept when thresholds disagree', () => {
 const s={levelM:.3,trendMPerH:.05,warningM:.35,criticalM:.5,state:'normal'};
 const f=canalAhead(s);assert.ok(f[12].levelM>.3&&f[36].levelM<=.8+1e-9);assert.equal(f[36].state,'critical');
 assert.equal(canalAhead({...s,state:'critical'})[12].state,'critical');  // thresholds say normal now: BMA status stands
 assert.equal(canalAhead({...s,offline:true}),null);
});
