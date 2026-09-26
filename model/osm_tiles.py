"""Fetch OSM features for every model domain in 0.25-degree tiles, cached as data/osm-cache/<tile>.json.gz.

One query per tile gets everything later steps need: roads (with names), waterways, water areas,
named residential areas / villages / places, named bridges and junctions. Tiles already cached are
skipped, so the script can be re-run after a failure. Several Overpass mirrors are tried in turn.
Data (c) OpenStreetMap contributors, ODbL.
"""
import gzip,json,math,sys,time,urllib.parse,urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'data/osm-cache'
TILE=.25
MIRRORS=['https://overpass-api.de/api/interpreter','https://maps.mail.ru/osm/tools/overpass/api/interpreter']
UA={'User-Agent':'thai-flood-watch-prototype/0.1 (flood map research)'}
HIGHWAYS='motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service'

def domains():return json.loads((ROOT/'model/domains.json').read_text())['domains']

def tiles_for(bbox):
    w,s,e,n=bbox
    for i in range(math.floor(s/TILE),math.ceil(n/TILE)):
        for j in range(math.floor(w/TILE),math.ceil(e/TILE)):yield i,j

def query(s,w,size):
    b=f'({s},{w},{s+size},{w+size})'
    return (f'[out:json][timeout:300];('
        f'way["highway"~"^({HIGHWAYS})$"]{b};'
        f'way["waterway"~"^(river|canal|drain|ditch|stream)$"]{b};'
        f'way["natural"="water"]{b};rel["natural"="water"]{b};way["waterway"="riverbank"]{b};rel["waterway"="riverbank"]{b};'
        f'way["landuse"="residential"]["name"]{b};rel["landuse"="residential"]["name"]{b};'
        f'node["place"~"^(village|hamlet|neighbourhood|suburb|quarter|isolated_dwelling|town)$"]["name"]{b};'
        f'way["man_made"="bridge"]["name"]{b};node["name"~"^แยก"]{b};node["junction"]["name"]{b};'
        f');out tags geom;')

def post(q,url):
    req=urllib.request.Request(url,data=urllib.parse.urlencode({'data':q}).encode(),headers=UA)
    data=json.loads(urllib.request.urlopen(req,timeout=330).read())
    if 'remark' in data and ('runtime error' in data['remark'] or 'timed out' in data['remark']):raise RuntimeError(data['remark'][:200])
    return data

def fetch_box(s,w,size,depth=0):
    """Try the box on each mirror; if all fail, split into four and merge (dedupe by type+id)."""
    last=None
    for attempt,url in enumerate(MIRRORS*2):
        try:return post(query(s,w,size),url)
        except Exception as e:last=e;time.sleep(10*(attempt+1))
    if depth>=2:raise RuntimeError(f'box {s},{w},{size}: {last}')
    half=size/2;seen={};base=None
    for ds in (0,half):
        for dw in (0,half):
            part=fetch_box(s+ds,w+dw,half,depth+1);base=base or part
            for el in part.get('elements',[]):seen[(el['type'],el['id'])]=el
    return {'osm3s':base.get('osm3s',{}),'elements':list(seen.values())}

def fetch(i,j):return fetch_box(i*TILE,j*TILE,TILE)

if __name__=='__main__':
    CACHE.mkdir(parents=True,exist_ok=True)
    want=sorted({t for d in domains() for t in tiles_for(d['bbox'])})
    only=set(sys.argv[1:])  # optional domain ids
    if only:want=sorted({t for d in domains() if d['id'] in only for t in tiles_for(d['bbox'])})
    done=0;failed=[]
    for i,j in want:
        path=CACHE/f'{i}_{j}.json.gz'
        if path.exists():done+=1;continue
        try:
            data=fetch(i,j)
            with gzip.open(path,'wt',encoding='utf-8') as f:json.dump({'tile':[i,j],'tileDeg':TILE,'osmBase':data.get('osm3s',{}).get('timestamp_osm_base'),'elements':data.get('elements',[])},f,separators=(',',':'))
            done+=1;print(f'[{done}/{len(want)}] {i}_{j} {len(data.get("elements",[]))} elements',flush=True)
        except Exception as e:
            failed.append(f'{i}_{j}');print('FAILED',e,flush=True)
        time.sleep(2)
    print(json.dumps({'tiles':len(want),'cached':done,'failed':failed}))
