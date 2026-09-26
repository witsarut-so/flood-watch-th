"""Prepare a UTM grid per model domain (model/domains.json) from public Copernicus DEM GLO-30 tiles.

For each domain: data/domains/<id>/dsm.tif (float32, first-quartile aggregation of 30 m cells, leaning
toward ground level rather than roofs/canopy), mask.tif (uint8 province code = index+1 in the domain's
province list, 0 = outside) and metadata.json. Province outlines (OSM via Nominatim lookup) are written to
data/boundary/provinces.geojson for display. Cells with no DEM tile at all (open sea) are set to 0 m.
"""
import json,math,time,urllib.parse,urllib.request
from datetime import datetime,timezone
from pathlib import Path
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import reproject,Resampling,transform_bounds,transform_geom

ROOT=Path(__file__).resolve().parents[1]
CRS='EPSG:32647'  # UTM 47N covers 96-102 E, all domains
TILE_URL='https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif'
UA={'User-Agent':'thai-flood-watch-prototype/0.1 (flood map research)'}

def province_shapes(ids):
    out={}
    for k in range(0,len(ids),50):
        url='https://nominatim.openstreetmap.org/lookup?'+urllib.parse.urlencode({'osm_ids':','.join('R%d'%x for x in ids[k:k+50]),'format':'jsonv2','polygon_geojson':1,'polygon_threshold':.0005})
        for r in json.loads(urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=120).read()):
            out[int(r['osm_id'])]=r['geojson']
        time.sleep(1.1)  # Nominatim usage policy
    missing=[i for i in ids if i not in out]
    if missing:raise ValueError(f'No boundary for relations {missing}')
    return out

def build(domain,shapes):
    cell=float(domain['cellM']);w,s,e,n=domain['bbox']
    x0,y0,x1,y1=transform_bounds('EPSG:4326',CRS,w,s,e,n)
    west=math.floor(x0/cell)*cell;east=math.ceil(x1/cell)*cell;south=math.floor(y0/cell)*cell;north=math.ceil(y1/cell)*cell
    cols=int(round((east-west)/cell));rows=int(round((north-south)/cell));affine=from_origin(west,north,cell,cell)
    z=np.full((rows,cols),np.nan,dtype='float32');used=[]
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',GDAL_HTTP_TIMEOUT='60',GDAL_HTTP_MAX_RETRY='3'):
        for lat in range(math.floor(s),math.ceil(n)):
            for lon in range(math.floor(w),math.ceil(e)):
                url=TILE_URL.format(lat=lat,lon=lon)
                try:src=rasterio.open('/vsicurl/'+url)
                except rasterio.errors.RasterioIOError:continue  # no tile: open sea
                with src:
                    part=np.full_like(z,np.nan)
                    reproject(rasterio.band(src,1),part,src_transform=src.transform,src_crs=src.crs,src_nodata=src.nodata,dst_transform=affine,dst_crs=CRS,dst_nodata=np.nan,resampling=Resampling.q1)
                    fill=np.isnan(z)&np.isfinite(part);z[fill]=part[fill];used.append(url)
    sea=np.isnan(z);z[sea]=0
    mask=np.zeros((rows,cols),dtype='uint8')
    for code,(name,osm) in enumerate(domain['provinces'],start=1):
        g=transform_geom('EPSG:4326',CRS,shapes[osm])
        mask[(rasterize([(g,1)],out_shape=z.shape,transform=affine,all_touched=True,dtype='uint8')==1)&(mask==0)]=code
    out=ROOT/'data/domains'/domain['id'];out.mkdir(parents=True,exist_ok=True)
    profile=dict(driver='GTiff',height=rows,width=cols,count=1,crs=CRS,transform=affine,compress='deflate')
    with rasterio.open(out/'dsm.tif','w',dtype='float32',**profile) as dst:dst.write(z,1)
    with rasterio.open(out/'mask.tif','w',dtype='uint8',**profile) as dst:dst.write(mask,1)
    gw,gs,ge,gn=transform_bounds(CRS,'EPSG:4326',west,south,east,north)
    meta={'id':domain['id'],'name':domain['name'],'source':'Copernicus DEM GLO-30 public (2021 release)','tiles':used,'boundarySource':'OpenStreetMap via Nominatim (ODbL)','preparedAt':datetime.now(timezone.utc).isoformat(),
        'terrainType':'DSM, not bare-earth DTM','aggregation':'first quartile (q1) of 30 m cells','horizontalCrs':CRS,'verticalDatum':'EGM2008; not reconciled to Thai station datum','cellSizeM':cell,'shape':[rows,cols],
        'transform':[affine.a,affine.b,affine.c,affine.d,affine.e,affine.f],'bbox':[gw,gs,ge,gn],'provinces':[{'code':c,'name':p[0],'osm':p[1],'cells':int((mask==c).sum())} for c,p in enumerate(domain['provinces'],start=1)],
        'seaCellsFilled':int(sea.sum()),'minElevationM':float(z.min()),'maxElevationM':float(z.max()),
        'limitations':[f'{int(cell)} m cells cannot resolve individual streets; roads are coloured by the cell they fall in','Buildings and vegetation partly remain in DSM','No surveyed drains, channel bathymetry, gates or pumps','Domain edges are open (free outflow); rivers and the sea are not forced by observed levels']}
    (out/'metadata.json').write_text(json.dumps(meta,ensure_ascii=False,indent=1))
    return {k:meta[k] for k in ('id','shape','seaCellsFilled')}|{'provinces':{p['name']:p['cells'] for p in meta['provinces']}}

if __name__=='__main__':
    import sys
    all_doms=json.loads((ROOT/'model/domains.json').read_text())['domains']
    doms=[d for d in all_doms if len(sys.argv)<2 or d['id'] in sys.argv[1:]]
    names={p[1]:p[0] for d in all_doms for p in d['provinces']};ids=sorted(names)
    shapes=province_shapes(ids)
    (ROOT/'data/boundary').mkdir(parents=True,exist_ok=True)
    (ROOT/'data/boundary/provinces.geojson').write_text(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','properties':{'name':names[i],'osm':f'relation/{i}'},'geometry':shapes[i]} for i in ids]},ensure_ascii=False))
    for d in doms:print(json.dumps(build(d,shapes),ensure_ascii=False),flush=True)
