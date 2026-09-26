"""Fetch the national OSM layer (major rivers; motorway/trunk/primary roads) shown at low zoom and outside the model domains.
Output: data/basemap/basemap-national.json. (Detailed layers: model/osm_tiles.py + model/build_static.py.)
Older notes below describe the encoding, which is unchanged:

detail (model domain, drawn at zoom >= 12): rivers, canals, drains/ditches, streams, water areas, all road classes
national (Thailand, drawn at lower zooms): major rivers, motorway/trunk/primary roads
Lines are [class, lat0, lng0, dlat, dlng, ...] in integer 1e-5 degrees; areas are [class, ring, ring, ...]
with rings encoded the same way (drawn with even-odd fill, so inner rings become holes).
Points closer than a tolerance to the last kept point are dropped. Data (c) OpenStreetMap contributors, ODbL.
"""
import json,math,time,urllib.parse,urllib.request
from datetime import datetime,timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
UA={'User-Agent':'thai-flood-watch-prototype/0.1 (local research)'}
WATERWAYS=['river','canal','drain','ditch','stream']
ROADS=['motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service','motorway_link','trunk_link','primary_link','secondary_link','tertiary_link']
# service roads (driveways, parking aisles) are fetched but not drawn
ROAD_GROUP={'motorway':'major','trunk':'major','primary':'major','motorway_link':'major','trunk_link':'major','primary_link':'major','secondary':'secondary','secondary_link':'secondary','tertiary':'secondary','tertiary_link':'secondary','unclassified':'minor','residential':'minor','living_street':'minor','service':'service'}

def overpass(q):
    req=urllib.request.Request('https://overpass-api.de/api/interpreter',data=urllib.parse.urlencode({'data':q}).encode(),headers=UA)
    return json.loads(urllib.request.urlopen(req,timeout=900).read())['elements']

def thin(coords,tol_m):
    """Radial-distance simplification; always keeps both ends."""
    if len(coords)<=2:return coords
    out=[coords[0]];k=math.cos(math.radians(coords[0][0]))
    for p in coords[1:-1]:
        q=out[-1]
        if math.hypot((p[0]-q[0])*111320,(p[1]-q[1])*111320*k)>=tol_m:out.append(p)
    out.append(coords[-1]);return out

def encode(coords):
    a=[round(lat*1e5) for lat,_ in coords];b=[round(lng*1e5) for _,lng in coords]
    row=[a[0],b[0]]
    for i in range(1,len(a)):row+=[a[i]-a[i-1],b[i]-b[i-1]]
    return row

def rings(ways):
    """Join member ways end-to-end into closed rings; unclosable chains are dropped."""
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

def geom(e):return [(p['lat'],p['lon']) for p in e.get('geometry',[]) if p]

def water_class(t):
    w=t.get('waterway') or t.get('water') or ''
    if w in ('river','riverbank','oxbow'):return 'river'
    if w=='canal':return 'canal'
    if w in ('drain','ditch'):return 'drain'
    if w=='stream':return 'stream'
    return 'area'

def detail(bbox):
    s,w,n,e=bbox[1],bbox[0],bbox[3],bbox[2];b=f'({s},{w},{n},{e})'
    els=overpass(f'[out:json][timeout:600];(way["waterway"~"^({"|".join(WATERWAYS)})$"]{b};way["natural"="water"]{b};rel["natural"="water"]{b};way["waterway"="riverbank"]{b};rel["waterway"="riverbank"]{b};way["highway"~"^({"|".join(ROADS)})$"]["area"!="yes"]{b};);out tags geom;')
    lines,areas,roads=[],[],[]
    for el in els:
        t=el.get('tags',{})
        if el['type']=='way' and t.get('highway') in ROAD_GROUP:
            c=geom(el)
            if len(c)>=2:roads.append([ROAD_GROUP[t['highway']]]+encode(thin(c,4)))
        elif el['type']=='way' and t.get('waterway') in WATERWAYS:
            c=geom(el)
            if len(c)>=2:lines.append([water_class(t)]+encode(thin(c,4)))
        elif el['type']=='way':
            c=geom(el)
            if len(c)>=4 and c[0]==c[-1]:areas.append([water_class(t),encode(thin(c,4))])
        elif el['type']=='relation':
            members=[[(p['lat'],p['lon']) for p in m.get('geometry',[])] for m in el.get('members',[]) if m.get('type')=='way' and m.get('role') in ('outer','inner','')]
            rs=rings(members)
            if rs:areas.append([water_class(t)]+[encode(thin(r,4)) for r in rs])
    return {'waterways':lines,'waterAreas':areas,'roads':roads}

def national():
    """Two smaller queries (rivers, major roads); Overpass often times out on one big nationwide request."""
    out={'rivers':[],'roads':[],'errors':[]}
    for key,sel,cls in [('rivers','way["waterway"="river"](area.th)','river'),('roads','way["highway"~"^(motorway|trunk|primary)$"](area.th)','major')]:
        for attempt in range(3):
            try:
                els=overpass(f'[out:json][timeout:900];area["ISO3166-1"="TH"][admin_level=2]->.th;{sel};out geom;')
                out[key]=[[cls]+encode(thin(geom(el),60)) for el in els if len(geom(el))>=2];break
            except Exception as e:
                if attempt==2:out['errors'].append(f'{key}: {e}')
                else:time.sleep(30)
    return out

def decode(row):
    lat,lng=row[0],row[1];out=[(lat/1e5,lng/1e5)]
    for i in range(2,len(row),2):lat+=row[i];lng+=row[i+1];out.append((lat/1e5,lng/1e5))
    return out

TILE=.05
def split(doc):
    """basemap-national.json (zoomed out), basemap-detail.json (water + major/secondary roads in the domain),
    basemap-minor.json ({tile key: minor roads}, keyed by the first point, fetched per view at high zoom)."""
    dest=ROOT/'data/basemap';nat=doc['national'];det=doc['detail']
    national={'rivers':[[r[0]]+encode(thin(decode(r[1:]),150)) for r in nat['rivers']],'roads':[[r[0]]+encode(thin(decode(r[1:]),150)) for r in nat['roads']]}
    detail={'bbox':doc['detailBbox'],'waterways':det['waterways'],'waterAreas':det['waterAreas'],'roads':[r for r in det['roads'] if r[0] in ('major','secondary')]}
    minor={}
    for r in det['roads']:
        if r[0]!='minor':continue
        minor.setdefault(f'{math.floor(r[1]/1e5/TILE)}_{math.floor(r[2]/1e5/TILE)}',[]).append(r[1:])
    meta={'source':doc['source'],'fetchedAt':doc['fetchedAt'],'tileDeg':TILE}
    for name,body in [('national',national),('detail',detail),('minor',minor)]:(dest/f'basemap-{name}.json').write_text(json.dumps({**meta,**({'tiles':body} if name=='minor' else body)},separators=(',',':')))
    return {n:(dest/f'basemap-{n}.json').stat().st_size for n in ('national','detail','minor')}

if __name__=='__main__':
    # Only the national layer is still built here; detailed layers come from osm_tiles.py + build_static.py.
    nat=national();dest=ROOT/'data/basemap';dest.mkdir(parents=True,exist_ok=True)
    national_doc={'source':'OpenStreetMap contributors via Overpass API (ODbL)','fetchedAt':datetime.now(timezone.utc).isoformat(),
        'rivers':[[r[0]]+encode(thin(decode(r[1:]),150)) for r in nat['rivers']],'roads':[[r[0]]+encode(thin(decode(r[1:]),150)) for r in nat['roads']],'errors':nat['errors']}
    (dest/'basemap-national.json').write_text(json.dumps(national_doc,separators=(',',':')))
    print(json.dumps({'rivers':len(national_doc['rivers']),'roads':len(national_doc['roads']),'errors':nat['errors']}))
