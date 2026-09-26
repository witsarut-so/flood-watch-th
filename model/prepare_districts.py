"""Bangkok district (khet) boundaries from OSM for clipping approximate report lines to the reporting district.
Output data/boundary/bkk-districts.geojson (properties.name = short Thai name, e.g. หนองแขม). Data (c) OpenStreetMap contributors.
"""
import json,urllib.parse,urllib.request
from pathlib import Path
from build_static import rings

ROOT=Path(__file__).resolve().parents[1]
Q='[out:json][timeout:300];area(id:3600092277)->.bkk;rel(area.bkk)["boundary"="administrative"]["admin_level"="6"];out geom;'

if __name__=='__main__':
    req=urllib.request.Request('https://overpass-api.de/api/interpreter',data=urllib.parse.urlencode({'data':Q}).encode(),headers={'User-Agent':'thai-flood-watch-prototype/0.1 (flood map research)'})
    els=json.loads(urllib.request.urlopen(req,timeout=330).read())['elements'];features=[]
    for el in els:
        t=el.get('tags',{});name=(t.get('name:th') or t.get('name') or '').replace('เขต','',1).strip()
        outer=rings([[(p['lat'],p['lon']) for p in m.get('geometry',[])] for m in el.get('members',[]) if m.get('type')=='way' and m.get('role')=='outer'])
        if name and outer:features.append({'type':'Feature','properties':{'name':name,'osm':f"relation/{el['id']}"},'geometry':{'type':'MultiPolygon','coordinates':[[[[lng,lat] for lat,lng in r]] for r in outer]}})
    out=ROOT/'data/boundary/bkk-districts.geojson';out.write_text(json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False))
    print(len(features),'districts',sorted(f['properties']['name'] for f in features)[:6])
