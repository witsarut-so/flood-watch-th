"""Build a Thai place-name gazetteer (province / district / subdistrict) for geocoding news text.

OSM admin_level 4/6/8 relation centres come from Overpass. Parent province/district is found by
point-in-polygon against rasterised province and district boundaries (Nominatim lookup, 50 ids per call),
because most OSM district relations carry no province tag.
Output data/gazetteer/th-admin.json: [{"id","level","name","short","en","province","district","lat","lng"}]
Data (c) OpenStreetMap contributors, ODbL.
"""
import json,sys,time,urllib.parse,urllib.request
from datetime import datetime,timezone
from pathlib import Path
import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_origin

ROOT=Path(__file__).resolve().parents[1]
UA={'User-Agent':'thai-flood-watch-prototype/0.1 (local research)'}
RES=.005;WEST,NORTH=97.,21.;COLS,ROWS=int(9/RES),int(16/RES)
AFFINE=from_origin(WEST,NORTH,RES,RES)
PREFIX=('จังหวัด','อำเภอ','เขต','ตำบล','แขวง','กิ่งอำเภอ')

def get(url,data=None,timeout=300):
    req=urllib.request.Request(url,data=data,headers=UA)
    return json.loads(urllib.request.urlopen(req,timeout=timeout).read())

def overpass(levels):
    q=f'[out:json][timeout:600];area["ISO3166-1"="TH"][admin_level=2]->.th;rel(area.th)[boundary=administrative][admin_level~"^({levels})$"];out tags center;'
    return get('https://overpass-api.de/api/interpreter',urllib.parse.urlencode({'data':q}).encode(),timeout=700)['elements']

def polygons(ids):
    out={}
    for i in range(0,len(ids),50):
        rows=get('https://nominatim.openstreetmap.org/lookup?'+urllib.parse.urlencode({'osm_ids':','.join('R%d'%x for x in ids[i:i+50]),'format':'jsonv2','polygon_geojson':1,'polygon_threshold':.001}))
        for r in rows:
            if r.get('geojson',{}).get('type') in ('Polygon','MultiPolygon'):out[int(r['osm_id'])]=r['geojson']
        time.sleep(1.1)  # Nominatim usage policy: max 1 request/second
    return out

def raster(ids,geoms):
    """uint16 raster of 1-based index into ids; 0 = none."""
    return rasterize([(geoms[x],n+1) for n,x in enumerate(ids) if x in geoms],out_shape=(ROWS,COLS),transform=AFFINE,dtype='uint16')

def lookup(grid,lat,lng):
    r=int((NORTH-lat)/RES);c=int((lng-WEST)/RES)
    return int(grid[r,c]) if 0<=r<ROWS and 0<=c<COLS else 0

def clean(tags):
    name=tags.get('name:th') or tags.get('name') or ''
    short=tags.get('short_name:th') or tags.get('short_name') or name
    for p in PREFIX:
        if short.startswith(p):short=short[len(p):]
    return name,short.strip()

def english(tags):
    en=tags.get('short_name:en') or tags.get('name:en') or ''
    for w in (' Province',' District',' Subdistrict','Amphoe ','Khet ','Tambon ','Khwaeng '):en=en.replace(w,'')
    return en.strip()

def anchor_provinces(rows):
    """Overpass `center` is the bbox centre of the relation. For provinces that is often useless (Bangkok's
    relation reaches into the sea: 13.587,100.633 off Samut Prakan), so a province's point is moved to its capital
    district (อำเภอเมือง<name>, Bangkok: พระนคร). Keeps the bbox centre when no capital district is found."""
    cap={r['province']:r for r in rows if r['level']==6 and (r['short'] in('เมือง'+r['province'],r['province']) or (r['province']=='กรุงเทพฯ' and r['short']=='พระนคร'))}
    # relations of neighbouring countries that overlap the TH area filter (e.g. Myanmar's Tanintharyi Region)
    foreign={r['short'] for r in rows if r['level']==4 and (r.get('en') or '').endswith((' Region',' State',' Division'))}
    rows[:]=[r for r in rows if r['province'] not in foreign]
    moved=0
    for r in rows:
        c=cap.get(r['short']) if r['level']==4 else None
        if c:r['lat'],r['lng']=c['lat'],c['lng'];r['anchor']=c['short'];moved+=1
    return moved

if __name__=='__main__':
    if sys.argv[1:]==['--anchors']:  # fix an existing th-admin.json in place
        f=ROOT/'data/gazetteer/th-admin.json';doc=json.loads(f.read_text());print('moved',anchor_provinces(doc['places']));f.write_text(json.dumps(doc,ensure_ascii=False,separators=(',',':')));sys.exit()
    elements=overpass('4|6|8')
    by={l:[e for e in elements if e['tags'].get('admin_level')==l and 'center' in e] for l in '468'}
    prov_ids=[e['id'] for e in by['4']];dist_ids=[e['id'] for e in by['6']]
    geoms=polygons(prov_ids+dist_ids)
    pgrid=raster(prov_ids,geoms);dgrid=raster(dist_ids,geoms)
    pname={n+1:clean(e['tags'])[1] for n,e in enumerate(by['4'])};dname={n+1:clean(e['tags'])[1] for n,e in enumerate(by['6'])}
    rows=[]
    for level,items in [(4,by['4']),(6,by['6']),(8,by['8'])]:
        for e in items:
            name,short=clean(e['tags']);lat,lng=e['center']['lat'],e['center']['lon']
            if not short:continue
            p=pname.get(lookup(pgrid,lat,lng));d=dname.get(lookup(dgrid,lat,lng)) if level==8 else None
            if level==4:p=short
            if p is None:continue  # centre outside rasterised provinces (offshore); unusable for disambiguation
            rows.append({'id':e['id'],'level':level,'name':name,'short':short,'en':english(e['tags']),'province':p,'district':d,'lat':round(lat,5),'lng':round(lng,5)})
    anchor_provinces(rows)
    dest=ROOT/'data/gazetteer';dest.mkdir(parents=True,exist_ok=True)
    doc={'source':'OpenStreetMap contributors (ODbL) via Overpass + Nominatim','builtAt':datetime.now(timezone.utc).isoformat(),'places':rows}
    (dest/'th-admin.json').write_text(json.dumps(doc,ensure_ascii=False,separators=(',',':')))
    counts={l:sum(1 for r in rows if r['level']==l) for l in (4,6,8)}
    print(json.dumps({'counts':counts,'polygons':len(geoms),'missingProvince':sum(len(v) for v in by.values())-len(rows)}))
