"""Build static map data from the OSM tile cache and domain grids (run after osm_tiles.py and prepare_terrain.py).

public/data/
  domains.json                      domain list + overview raster geometry + tile index
  provinces.geojson, places.json    province outlines, admin gazetteer for search
  basemap/national.json.gz          national rivers + major roads (from prepare_basemap.py output)
  basemap/main/<i>_<j>.json.gz      0.25 deg: waterways, water areas, major + secondary roads (incl. bridges)
  basemap/minor/<i>_<j>.json.gz     0.05 deg: minor roads (zoom >= 14)
  model-roads/<domain>/<i>_<j>.json.gz 0.25 deg: at-grade road pieces keyed by model cell index
  overview/<domain>.bin.gz          uint32 cell index per ~0.002 deg lat/lng pixel (0xFFFFFFFF = none)
data/named/named.json.gz            named roads/sois/villages/canals/bridges/junctions for text matching
Lines are [class, lat0, lng0, dlat, dlng, ...] in integer 1e-5 degrees. Data (c) OpenStreetMap contributors.
"""
import gzip,json,math,shutil
from collections import defaultdict
from pathlib import Path
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import transform

ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'public/data';CACHE=ROOT/'data/osm-cache'
MAIN_TILE=.25;MINOR_TILE=.05;OVERVIEW_DEG=.002;OVERVIEW_LO_DEG=.006  # lo-res overview for zoom <= 9 (9x fewer pixels)
ROAD_GROUP={'motorway':'major','trunk':'major','primary':'major','motorway_link':'major','trunk_link':'major','primary_link':'major','secondary':'secondary','secondary_link':'secondary','tertiary':'secondary','tertiary_link':'secondary','unclassified':'minor','residential':'minor','living_street':'minor'}
MODEL_ROADS=set(ROAD_GROUP)
WATERWAYS={'river':'river','canal':'canal','drain':'drain','ditch':'drain','stream':'stream'}

def dump(path,obj):
    """Write JSON; paths ending in .gz are gzip-compressed (the browser inflates them itself)."""
    path.parent.mkdir(parents=True,exist_ok=True);text=json.dumps(obj,ensure_ascii=False,separators=(',',':'))
    if path.suffix=='.gz':
        with gzip.open(path,'wt',encoding='utf-8',compresslevel=9) as f:f.write(text)
    else:path.write_text(text)
def thin(c,tol):
    if len(c)<=2:return c
    out=[c[0]];k=math.cos(math.radians(c[0][0]))
    for p in c[1:-1]:
        q=out[-1]
        if math.hypot((p[0]-q[0])*111320,(p[1]-q[1])*111320*k)>=tol:out.append(p)
    out.append(c[-1]);return out
def enc(c):
    a=[round(x*1e5) for x,_ in c];b=[round(y*1e5) for _,y in c];row=[a[0],b[0]]
    for i in range(1,len(a)):row+=[a[i]-a[i-1],b[i]-b[i-1]]
    return row
def decode(row):
    lat,lng=row[0],row[1];out=[(lat/1e5,lng/1e5)]
    for i in range(2,len(row),2):lat+=row[i];lng+=row[i+1];out.append((lat/1e5,lng/1e5))
    return out
def geom(el):return [(p['lat'],p['lon']) for p in el.get('geometry',[]) if p]
def key(lat,lng,t):return f'{math.floor(lat/t)}_{math.floor(lng/t)}'
def at_grade(t):
    if t.get('bridge','no')!='no' or t.get('tunnel','no')!='no':return False
    try:return float(t.get('layer','0').split(';')[0])<=0
    except ValueError:return False
def rings(ways):
    pool=[list(w) for w in ways if len(w)>=2];done=[]
    while pool:
        ring=pool.pop()
        while ring[0]!=ring[-1]:
            for i,w in enumerate(pool):
                if w[0]==ring[-1]:ring+=w[1:]
                elif w[-1]==ring[-1]:ring+=w[::-1][1:]
                elif w[-1]==ring[0]:ring=w[:-1]+ring
                elif w[0]==ring[0]:ring=w[::-1][:-1]+ring
                else:continue
                pool.pop(i);break
            else:break
        if ring[0]==ring[-1] and len(ring)>=4:done.append(ring)
    return done

def load_elements():
    seen={}
    for f in sorted(CACHE.glob('*.json.gz')):
        with gzip.open(f,'rt',encoding='utf-8') as fh:
            for el in json.load(fh)['elements']:seen[(el['type'],el['id'])]=el
    return list(seen.values())

class ProvinceLookup:
    """Point -> province name via a 0.005 deg raster of the prepared province outlines."""
    def __init__(self):
        fc=json.loads((ROOT/'data/boundary/provinces.geojson').read_text());self.names=[f['properties']['name'] for f in fc['features']]
        self.res=.005;self.w,self.n=97.,21.;self.aff=from_origin(self.w,self.n,self.res,self.res)
        self.grid=rasterize([(f['geometry'],i+1) for i,f in enumerate(fc['features'])],out_shape=(int(16/self.res),int(9/self.res)),transform=self.aff,dtype='uint8')
    def __call__(self,lat,lng):
        r=int((self.n-lat)/self.res);c=int((lng-self.w)/self.res)
        v=self.grid[r,c] if 0<=r<self.grid.shape[0] and 0<=c<self.grid.shape[1] else 0
        return self.names[v-1] if v else None

def build_basemap(els):
    main=defaultdict(lambda:{'waterways':[],'waterAreas':[],'roads':[]});minor=defaultdict(list)
    for el in els:
        t=el.get('tags',{})
        if el['type']=='way' and t.get('highway') in ROAD_GROUP:
            c=geom(el)
            if len(c)<2:continue
            g=ROAD_GROUP[t['highway']];row=[g]+enc(thin(c,4))
            if g=='minor':minor[key(c[0][0],c[0][1],MINOR_TILE)].append(row[1:])
            else:main[key(c[0][0],c[0][1],MAIN_TILE)]['roads'].append(row)
        elif el['type']=='way' and t.get('waterway') in WATERWAYS:
            c=geom(el)
            if len(c)>=2:main[key(c[0][0],c[0][1],MAIN_TILE)]['waterways'].append([WATERWAYS[t['waterway']]]+enc(thin(c,4)))
        elif (t.get('natural')=='water' or t.get('waterway')=='riverbank'):
            cls='river' if t.get('water') in ('river','oxbow','canal') or t.get('waterway')=='riverbank' else 'area'
            if el['type']=='way':
                c=geom(el)
                if len(c)>=4 and c[0]==c[-1]:main[key(c[0][0],c[0][1],MAIN_TILE)]['waterAreas'].append([cls,enc(thin(c,4))])
            else:
                rs=rings([[(p['lat'],p['lon']) for p in m.get('geometry',[])] for m in el.get('members',[]) if m.get('type')=='way'])
                if rs:main[key(rs[0][0][0],rs[0][0][1],MAIN_TILE)]['waterAreas'].append([cls]+[enc(thin(r,4)) for r in rs])
    for k,v in main.items():dump(OUT/f'basemap/main/{k}.json.gz',v)
    for k,v in minor.items():dump(OUT/f'basemap/minor/{k}.json.gz',v)
    return sorted(main),sorted(minor)

def build_model_roads(els,meta):
    """Split at-grade roads into pieces per model cell (<= 20 m sub-segments, grouped by midpoint cell)."""
    with rasterio.open(ROOT/'data/domains'/meta['id']/'mask.tif') as src:mask=src.read(1);aff=src.transform;crs=src.crs
    w,s,e,n=meta['bbox'];ways=[el for el in els if el['type']=='way' and el.get('tags',{}).get('highway') in MODEL_ROADS and at_grade(el['tags'])]
    ways=[(el,geom(el)) for el in ways];ways=[(el,c) for el,c in ways if len(c)>=2 and any(s<=p[0]<=n and w<=p[1]<=e for p in c)]
    lat=[p[0] for _,c in ways for p in c];lng=[p[1] for _,c in ways for p in c]
    X,Y=transform('EPSG:4326',crs,lng,lat);X=np.array(X);Y=np.array(Y);i=0;pieces=[];step=min(20.,meta['cellSizeM']/5)
    flat=mask.ravel();R,C=mask.shape
    for el,c in ways:
        m=len(c);xs,ys=X[i:i+m],Y[i:i+m];i+=m
        px,py,orig=[xs[0]],[ys[0]],[True]
        for a in range(1,m):
            k=max(1,int(math.ceil(math.hypot(xs[a]-xs[a-1],ys[a]-ys[a-1])/step)))
            for q in range(1,k+1):px.append(xs[a-1]+(xs[a]-xs[a-1])*q/k);py.append(ys[a-1]+(ys[a]-ys[a-1])*q/k);orig.append(q==k)
        px,py,orig=np.array(px),np.array(py),np.array(orig)
        col=np.floor(((px[:-1]+px[1:])/2-aff.c)/aff.a).astype(int);row=np.floor(((py[:-1]+py[1:])/2-aff.f)/aff.e).astype(int)
        cell=np.where((row>=0)&(row<R)&(col>=0)&(col<C),row*C+col,-1);start=0
        for b in range(1,len(cell)+1):
            if b==len(cell) or cell[b]!=cell[start]:
                if cell[start]>=0 and flat[cell[start]]:
                    keep=orig[start:b+1].copy();keep[0]=keep[-1]=True
                    pieces.append((int(cell[start]),px[start:b+1][keep],py[start:b+1][keep]))
                start=b
    if not pieces:return []
    lng2,lat2=transform(crs,'EPSG:4326',np.concatenate([p[1] for p in pieces]).tolist(),np.concatenate([p[2] for p in pieces]).tolist())
    tiles=defaultdict(list);j=0
    for cell,px,_ in pieces:
        k=len(px);pts=list(zip(lat2[j:j+k],lng2[j:j+k]));j+=k
        tiles[key(pts[0][0],pts[0][1],MAIN_TILE)].append([cell]+enc(pts))
    for k,v in tiles.items():dump(OUT/f'model-roads/{meta["id"]}/{k}.json.gz',v)
    return sorted(tiles)

def build_river(els,meta,river):
    """data/domains/<id>/river.tif: 1 = channel cell of the named river (OSM water areas + centre line, 1-cell buffer),
    2 = inflow cells where the river crosses the domain's upstream (north) edge."""
    with rasterio.open(ROOT/'data/domains'/meta['id']/'mask.tif') as src:shape=src.shape;aff=src.transform;crs=src.crs;profile=src.profile
    name=river['name'];polys=[];lines=[]
    for el in els:
        t=el.get('tags',{})
        if (t.get('name:th') or t.get('name'))!=name:continue
        if t.get('waterway')=='river' and el['type']=='way':lines.append(geom(el))
        elif t.get('natural')=='water' or t.get('waterway')=='riverbank':
            if el['type']=='way':
                c=geom(el)
                if len(c)>=4:polys.append([c])
            else:
                rs=rings([[(p['lat'],p['lon']) for p in m.get('geometry',[])] for m in el.get('members',[]) if m.get('type')=='way' and m.get('role')=='outer'])
                polys+= [[r] for r in rs]
    def proj(c):
        xs,ys=transform('EPSG:4326',crs,[p[1] for p in c],[p[0] for p in c]);return list(zip(xs,ys))
    shapes=[({'type':'Polygon','coordinates':[proj(r) for r in poly]},1) for poly in polys]+[({'type':'LineString','coordinates':proj(l)},1) for l in lines if len(l)>=2]
    if not shapes:return None
    m=rasterize(shapes,out_shape=shape,transform=aff,all_touched=True,dtype='uint8')
    d=m.copy();d[1:,:]|=m[:-1,:];d[:-1,:]|=m[1:,:];d[:,1:]|=m[:,:-1];d[:,:-1]|=m[:,1:]   # 1-cell buffer: centre lines are thinner than a cell
    d[:4,:][d[:4,:]>0]=2
    with rasterio.open(ROOT/'data/domains'/meta['id']/'river.tif','w',**{**profile,'dtype':'uint8'}) as dst:dst.write(d,1)
    return {'name':name,'cells':int((d>0).sum()),'inflowCells':int((d==2).sum()),'osmPolygons':len(polys),'osmLines':len(lines)}

def build_overview(meta,deg=OVERVIEW_DEG,sub='overview'):
    """Lat/lng-aligned raster of model cell indices so the browser can paint a frame without reprojection."""
    with rasterio.open(ROOT/'data/domains'/meta['id']/'mask.tif') as src:mask=src.read(1);aff=src.transform;crs=src.crs
    w,s,e,n=meta['bbox'];W=int(math.ceil((e-w)/deg));H=int(math.ceil((n-s)/deg))
    lng=w+(np.arange(W)+.5)*deg;lat=n-(np.arange(H)+.5)*deg;LL,LA=np.meshgrid(lng,lat)
    X,Y=transform('EPSG:4326',crs,LL.ravel().tolist(),LA.ravel().tolist());X=np.array(X);Y=np.array(Y)
    col=np.floor((X-aff.c)/aff.a).astype(np.int64);row=np.floor((Y-aff.f)/aff.e).astype(np.int64);R,C=mask.shape
    ok=(row>=0)&(row<R)&(col>=0)&(col<C);idx=np.full(W*H,0xFFFFFFFF,dtype='<u4');cells=row[ok]*C+col[ok]
    inside=mask.ravel()[cells]>0;tmp=idx[ok];tmp[inside]=cells[inside].astype('<u4');idx[ok]=tmp
    p=OUT/f'{sub}/{meta["id"]}.bin.gz';p.parent.mkdir(parents=True,exist_ok=True)
    with gzip.open(p,'wb') as f:f.write(idx.tobytes())
    return {'width':W,'height':H,'bounds':[w,n-H*deg,w+W*deg,n]}

NAMED_KIND=[('ถนน','road'),('ซอย','soi'),('หมู่บ้าน','village'),('คลอง','canal'),('แม่น้ำ','river'),('สะพาน','bridge'),('แยก','junction')]
def build_named(els,province):
    """Named features for text matching. Ways with the same name are merged into connected clusters
    (endpoints within ~80 m), so one road name can resolve to separate places in different provinces."""
    byname=defaultdict(list);points=[]
    for el in els:
        t=el.get('tags',{});name=(t.get('name:th') or t.get('name') or '').strip()
        if not name or len(name)<3:continue
        if el['type']=='node':
            kind='junction' if name.startswith('แยก') or t.get('junction') else 'place'
            points.append({'name':name,'kind':kind,'lat':el['lat'],'lng':el['lon'],'province':province(el['lat'],el['lon'])});continue
        if el['type']=='relation':
            c=[(p['lat'],p['lon']) for m in el.get('members',[]) if m.get('type')=='way' and m.get('role')=='outer' for p in m.get('geometry',[])]
        else:c=geom(el)
        if len(c)<2:continue
        kind=('village' if t.get('landuse')=='residential' else 'bridge' if t.get('man_made')=='bridge' else
              WATERWAYS.get(t.get('waterway'),'water') if t.get('waterway') or t.get('natural') else 'road')
        if kind=='drain' or kind=='stream':kind='canal'
        byname[(name,kind)].append(c)
    features=[]
    for (name,kind),lines in byname.items():
        parent=list(range(len(lines)))
        def find(a):
            while parent[a]!=a:parent[a]=parent[parent[a]];a=parent[a]
            return a
        ends=[(l[0],l[-1]) for l in lines];grid=defaultdict(list)
        for i,(a,b) in enumerate(ends):
            for p in (a,b):grid[(round(p[0]/.0008),round(p[1]/.0008))].append(i)
        for i,(a,b) in enumerate(ends):
            for p in (a,b):
                gx,gy=round(p[0]/.0008),round(p[1]/.0008)
                for dx in (-1,0,1):
                    for dy in (-1,0,1):
                        for j in grid.get((gx+dx,gy+dy),()):parent[find(i)]=find(j)
        clusters=defaultdict(list)
        for i,l in enumerate(lines):clusters[find(i)].append(l)
        for ls in clusters.values():
            pts=[p for l in ls for p in l];la=[p[0] for p in pts];lo=[p[1] for p in pts]
            clat,clng=(min(la)+max(la))/2,(min(lo)+max(lo))/2
            length=sum(math.hypot((l[k][0]-l[k-1][0])*111320,(l[k][1]-l[k-1][1])*108000) for l in ls for k in range(1,len(l)))
            features.append({'name':name,'kind':kind,'lat':round(clat,5),'lng':round(clng,5),'bbox':[round(min(lo),5),round(min(la),5),round(max(lo),5),round(max(la),5)],'lengthM':round(length),
                'province':province(clat,clng),'lines':[[[round(p[0],5),round(p[1],5)] for p in thin(l,12)] for l in ls][:60]})
    for p in points:features.append({**p,'bbox':[p['lng'],p['lat'],p['lng'],p['lat']],'lengthM':0,'lines':[]})
    (ROOT/'data/named').mkdir(parents=True,exist_ok=True)
    with gzip.open(ROOT/'data/named/named.json.gz','wt',encoding='utf-8') as f:json.dump({'source':'OpenStreetMap contributors (ODbL)','features':features},f,ensure_ascii=False,separators=(',',':'))
    return len(features)

if __name__=='__main__':
    doms=json.loads((ROOT/'model/domains.json').read_text())['domains']
    els=load_elements();print('elements',len(els),flush=True)
    for sub in ('basemap/main','basemap/minor','model-roads','overview','overview-lo'):shutil.rmtree(OUT/sub,ignore_errors=True)
    province=ProvinceLookup()
    mains,minors=build_basemap(els);print('basemap tiles',len(mains),len(minors),flush=True)
    domains=[]
    for d in doms:
        meta=json.loads((ROOT/'data/domains'/d['id']/'metadata.json').read_text())
        tiles=build_model_roads(els,meta);ov=build_overview(meta);ovlo=build_overview(meta,OVERVIEW_LO_DEG,'overview-lo')
        if d.get('river'):print(d['id'],'river',build_river(els,meta,d['river']),flush=True)
        domains.append({'id':d['id'],'name':d['name'],'cellSizeM':meta['cellSizeM'],'shape':meta['shape'],'bbox':meta['bbox'],'provinces':[p['name'] for p in meta['provinces']],'roadTiles':tiles,'overview':ov,'overviewLo':ovlo})
        print(d['id'],'road tiles',len(tiles),'overview',ov['width'],'x',ov['height'],flush=True)
    dump(OUT/'domains.json',{'mainTileDeg':MAIN_TILE,'minorTileDeg':MINOR_TILE,'mainTiles':mains,'minorTiles':minors,'domains':domains})
    shutil.copy(ROOT/'data/boundary/provinces.geojson',OUT/'provinces.geojson')
    nat=json.loads((ROOT/'data/basemap/basemap-national.json').read_text());dump(OUT/'basemap/national.json.gz',nat)
    # lite national layer for the first screen: 600 m simplification, drop pieces shorter than 3 km
    def lite(rows):
        out=[]
        for r in rows:
            c=thin(decode(r[1:]),600)
            if sum(math.hypot((c[k][0]-c[k-1][0])*111320,(c[k][1]-c[k-1][1])*108000) for k in range(1,len(c)))>=3000:out.append([r[0]]+enc(c))
        return out
    dump(OUT/'basemap/national-lite.json.gz',{'rivers':lite(nat['rivers']),'roads':lite(nat['roads'])})
    places=json.loads((ROOT/'data/gazetteer/th-admin.json').read_text())['places']
    dump(OUT/'places.json',[[p['short'],p['level'],p['province'],p['lat'],p['lng']] for p in places])
    print('named features',build_named(els,province),flush=True)
