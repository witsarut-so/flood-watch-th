// Colour overlay on a muted basemap: only water (blue/cyan) and roads (orange/amber) keep colour.
// National rivers/major roads everywhere; inside the model domains, detailed 0.25 deg tiles (zoom >= 11)
// and minor-road 0.05 deg tiles (zoom >= 14) are fetched for the visible area only.
const basemapStyle={
 area:{fillColor:'#a5d8ff'},river:{color:'#1c7ed6',fillColor:'#74c0fc'},canal:{color:'#0c8599'},drain:{color:'#3bc9db'},stream:{color:'#4dabf7'},
 major:{color:'#f76707'},secondary:{color:'#f59f00'},minor:{color:'#e0b25c'},
};
const basemapFilter={river:'f-riverline',stream:'f-riverline',canal:'f-canalway',drain:'f-drain',area:'f-waterarea',major:'f-road-major',secondary:'f-road-secondary',minor:'f-road-minor'};
const basemap={national:null,main:new Map(),minor:new Map(),loading:new Set(),layers:{},renderers:{}};
if(map)for(const name of ['waterAreas','waterLines','roadsBase']){basemap.renderers[name]=L.canvas({pane:name,padding:.2});basemap.layers[name]=L.layerGroup().addTo(map);}
function decodeRows(rows,withClass=true){return rows.map(r=>{const off=withClass?1:0;let lat=r[off],lng=r[off+1];const pts=[[lat/1e5,lng/1e5]];let s=lat,n=lat,w=lng,e=lng;for(let i=off+2;i<r.length;i+=2){lat+=r[i];lng+=r[i+1];pts.push([lat/1e5,lng/1e5]);if(lat<s)s=lat;if(lat>n)n=lat;if(lng<w)w=lng;if(lng>e)e=lng;}return {cls:withClass?r[0]:'minor',pts,box:[s/1e5,w/1e5,n/1e5,e/1e5]};});}
function decodeAreas(rows){return rows.map(r=>{const rings=r.slice(1).map(x=>decodeRows([x],false)[0]);const box=rings.reduce((b,x)=>[Math.min(b[0],x.box[0]),Math.min(b[1],x.box[1]),Math.max(b[2],x.box[2]),Math.max(b[3],x.box[3])],[90,180,-90,-180]);return {cls:r[0],rings:rings.map(x=>x.pts),box};});}
const inView=(box,b)=>box[2]>=b.getSouth()&&box[0]<=b.getNorth()&&box[3]>=b.getWest()&&box[1]<=b.getEast();
const shown=cls=>$(basemapFilter[cls])?.checked!==false;
function weight(cls,z){const t={river:[1.2,2.5,5],canal:[.8,2,3.5],drain:[0,1,2],stream:[.6,1.2,2],major:[.8,2.5,4.5],secondary:[0,1.6,3],minor:[0,0,1.8]}[cls]||[1,1,1];return z<=10?t[0]:z<=13?t[1]:t[2];}
function tileKeys(b,t,available){const keys=[];for(let i=Math.floor(b.getSouth()/t);i<=Math.floor(b.getNorth()/t);i++)for(let j=Math.floor(b.getWest()/t);j<=Math.floor(b.getEast()/t);j++){const k=`${i}_${j}`;if(!available||available.has(k))keys.push(k);}return keys;}
let mainAvail=null,minorAvail=null;
document.addEventListener('domains',e=>{mainAvail=new Set(e.detail.mainTiles);minorAvail=new Set(e.detail.minorTiles);drawBasemap();});
async function loadTiles(kind,keys){
 const store=basemap[kind],need=keys.filter(k=>!store.has(k)&&!basemap.loading.has(kind+k)).slice(0,24);if(!need.length)return;
 need.forEach(k=>basemap.loading.add(kind+k));
 await Promise.all(need.map(async k=>{try{const d=await fetchJson(`/data/basemap/${kind}/${k}.json.gz`);store.set(k,kind==='main'?{waterways:decodeRows(d.waterways),roads:decodeRows(d.roads),waterAreas:decodeAreas(d.waterAreas)}:decodeRows(d,false));}catch{store.set(k,null);}finally{basemap.loading.delete(kind+k);}}));
 drawBasemap();
}
function drawBasemap(){
 if(!map)return;for(const g of Object.values(basemap.layers))g.clearLayers();
 const z=map.getZoom(),b=map.getBounds().pad(.15),lines={},areas={};
 const add=(pane,cls,pts)=>{((lines[pane]??={})[cls]??=[]).push(pts);};
 const mainKeys=z>=11&&mainAvail?tileKeys(b,domainsInfo?.mainTileDeg||.25,mainAvail):[];
 const covered=new Set(mainKeys);const inDetail=box=>covered.has(`${Math.floor(box[0]/.25)}_${Math.floor(box[1]/.25)}`)&&covered.has(`${Math.floor(box[2]/.25)}_${Math.floor(box[3]/.25)}`);
 if(basemap.national)for(const f of basemap.national)if(shown(f.cls)&&inView(f.box,b)&&!inDetail(f.box))add(f.cls==='river'?'waterLines':'roadsBase',f.cls,f.pts);
 for(const k of mainKeys){const t=basemap.main.get(k);if(!t)continue;
  for(const f of t.waterAreas)if(shown('area')&&inView(f.box,b))(areas[f.cls==='river'?'river':'area']??=[]).push(f.rings);
  for(const f of t.waterways)if(shown(f.cls)&&weight(f.cls,z)>0&&inView(f.box,b))add('waterLines',f.cls,f.pts);
  for(const f of t.roads)if(shown(f.cls)&&weight(f.cls,z)>0&&inView(f.box,b))add('roadsBase',f.cls,f.pts);}
 loadTiles('main',mainKeys);
 if(z>=14&&shown('minor')&&minorAvail){const keys=tileKeys(b,domainsInfo?.minorTileDeg||.05,minorAvail);for(const k of keys){const t=basemap.minor.get(k);if(t)for(const f of t)if(inView(f.box,b))add('roadsBase','minor',f.pts);}loadTiles('minor',keys);}
 for(const [cls,polys] of Object.entries(areas))L.polygon(polys,{renderer:basemap.renderers.waterAreas,stroke:false,fillOpacity:.85,interactive:false,...basemapStyle[cls]}).addTo(basemap.layers.waterAreas);
 for(const [pane,byCls] of Object.entries(lines))for(const cls of ['minor','stream','drain','secondary','canal','major','river'])if(byCls[cls])L.polyline(byCls[cls],{renderer:basemap.renderers[pane],weight:weight(cls,z),opacity:.95,interactive:false,lineCap:'round',lineJoin:'round',dashArray:cls==='drain'&&z>=14?'4 3':null,...basemapStyle[cls]}).addTo(basemap.layers[pane]);
}
function setMuted(){map?.getContainer().classList.toggle('muted-base',$('f-muted').checked);}
if(map){
 map.on('moveend',drawBasemap);onFilter(Object.values(basemapFilter),drawBasemap);onFilter(['f-muted'],setMuted);setMuted();
 // Data saver: simplified national layer first; full detail once the viewer zooms in to 9+.
 const loadNational=file=>fetchJson(`/data/basemap/${file}`).then(n=>{basemap.national=[...decodeRows(n.rivers),...decodeRows(n.roads)];drawBasemap();});
 let fullNational=false;loadNational('national-lite.json.gz').catch(()=>{fullNational=true;return loadNational('national.json.gz');}).catch(()=>{});
 map.on('zoomend',()=>{if(!fullNational&&map.getZoom()>=9){fullNational=true;loadNational('national.json.gz').catch(()=>{fullNational=false;});}});
}
