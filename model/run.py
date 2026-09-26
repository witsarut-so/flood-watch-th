"""Run a reproducible, uncalibrated rainfall/terrain sensitivity replay over every model domain.

usage: run.py <input.json> <out_dir>
Writes <out_dir>/result.json and, per domain d, scenario k and hour i, <out_dir>/<d>-s<k>-f<i>.bin.gz:
gzip of uint8 depth in cm (255 = 255 cm or more), row-major [row, col] of the domain grid,
zero outside the domain's province mask. Domains without enough rain data are listed as skipped.
"""
import gzip,json,os,sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime,timezone,timedelta
from pathlib import Path
import numpy as np
import rasterio
from rasterio.warp import transform
from solver import simulate
ROOT=Path(__file__).resolve().parents[1]
THRESHOLD_M=.02;DRAINAGE=[0.,3.,8.];INFILTRATION=2.;MAX_HOURS=24

def select_history(bundle):
    """Choose the window (6-24 h, ending within 3 h of fetch) and the stations complete over it that
    maximise station-hours. Stations with a gap in the window are left out, never zero-filled."""
    histories=bundle.get('rainHistory',[])
    if len(histories)<2:raise ValueError('ต้องมีประวัติฝนที่ใช้ได้อย่างน้อย 2 สถานี')
    now=datetime.fromisoformat(bundle['fetchedAt'].replace('Z','+00:00'))
    series=[]
    for station in histories:
        values={}
        for s in station['samples']:
            if s['observedAt'] and s['mm'] is not None and 0<=s['mm']<=500:
                t=datetime.fromisoformat(s['observedAt'])
                if t<=now:values[t]=s['mm']
        series.append(values)
    ends={t for s in series for t in s if (now-t).total_seconds()<=10800}
    best=None
    for end in ends:
        for hours in range(6,MAX_HOURS+1):
            times=[end-timedelta(hours=k) for k in range(hours-1,-1,-1)]
            members=[i for i,s in enumerate(series) if all(t in s for t in times)]
            if len(members)<2:break
            score=(len(members)*hours,hours,end)
            if best is None or score>best[0]:best=(score,members,times)
    if best is None:raise ValueError('ต้องมีฝนต่อเนื่องอย่างน้อย 6 ชั่วโมงจากอย่างน้อย 2 สถานี (ล่าสุดไม่เกิน 3 ชั่วโมง) ไม่มีการแทนข้อมูลหายด้วยศูนย์')
    _,members,times=best
    return [histories[i] for i in members],[series[i] for i in members],times

def validate(obs,depth,mask,affine,crs,times):
    """Compare point observations with the modelled depth at the nearest simulated hour.
    Wet = citizen flood report or road sensor >= 5 cm; dry = road sensor reading 0. Hit if any cell in the
    3x3 neighbourhood (+-100 m, for position error and road-in-cell) is >= threshold; a dry point is a false
    alarm if its own cell is wet. baseRate = share of mask cells that would count as a hit by chance."""
    if not obs:return {'n':0}
    xs,ys=transform('EPSG:4326',crs,[o['lng'] for o in obs],[o['lat'] for o in obs])
    t0=times[0]-timedelta(hours=1);th=round(THRESHOLD_M*100)
    wet=depth>=th;pad=np.pad(wet,((0,0),(1,1),(1,1)));near=np.zeros_like(wet)
    for dr in (0,1,2):
        for dc in (0,1,2):near|=pad[:,dr:dr+wet.shape[1],dc:dc+wet.shape[2]]
    inside=mask>0;base_by_frame=[float(near[f][inside].mean()) if inside.any() else 0. for f in range(len(times))];res={'positives':0,'hits':0,'negatives':0,'falseAlarms':0,'baseRate':[],'kinds':{}}
    for o,x,y in zip(obs,xs,ys):
        at=datetime.fromisoformat(o['at'].replace('Z','+00:00'))
        if not t0<=at<=times[-1]+timedelta(minutes=30):continue
        f=min(range(len(times)),key=lambda i:abs((times[i]-at).total_seconds()))
        c=int((x-affine.c)//affine.a);r=int((y-affine.f)//affine.e)
        if not(0<=r<mask.shape[0] and 0<=c<mask.shape[1]) or not inside[r,c]:continue
        if o['wet']:
            res['positives']+=1;res['hits']+=int(near[f,r,c]);res['baseRate'].append(base_by_frame[f])
            k=res['kinds'].setdefault(o['kind'],[0,0]);k[0]+=1;k[1]+=int(near[f,r,c])
        else:res['negatives']+=1;res['falseAlarms']+=int(wet[f,r,c])
    base=float(np.mean(res['baseRate'])) if res['baseRate'] else None
    return {'n':res['positives']+res['negatives'],'positives':res['positives'],'hits':res['hits'],'hitRate':res['hits']/res['positives'] if res['positives'] else None,'baseRate':base,
        'negatives':res['negatives'],'falseAlarms':res['falseAlarms'],'falseAlarmRate':res['falseAlarms']/res['negatives'] if res['negatives'] else None,'byKind':{k:{'n':v[0],'hits':v[1]} for k,v in res['kinds'].items()}}

def domain_bundle(bundle,meta,pad=.2):
    w,s,e,n=meta['bbox']
    return {**bundle,'rainHistory':[h for h in bundle.get('rainHistory',[]) if s-pad<=h['lat']<=n+pad and w-pad<=h['lng']<=e+pad]}

def run_task(task):
    """One (domain, scenario): simulate hour by hour, write frames, return stats and validation."""
    d,k,drain,stations_xy,values,times,obs,out_dir,threads=task
    try:
        import numba;numba.set_num_threads(threads)
    except (ImportError,ValueError):pass
    base=ROOT/'data/domains'/d
    with rasterio.open(base/'dsm.tif') as src:z=src.read(1).astype(float);affine=src.transform;crs=src.crs
    with rasterio.open(base/'mask.tif') as src:mask=src.read(1)
    meta=json.loads((base/'metadata.json').read_text());dx=meta['cellSizeM'];dt=15 if dx<=100 else 30  # tested against 5 s on real terrain: p99 depth diff 0.05 cm, 99.98% same wet cells
    yy,xx=np.indices(z.shape);gx=affine.c+(xx+.5)*affine.a;gy=affine.f+(yy+.5)*affine.e
    weights=np.array([1/np.maximum((gx-x)**2+(gy-y)**2,1000**2) for x,y in stations_xy],dtype='float32');weights/=weights.sum(axis=0)
    del yy,xx,gx,gy
    names={p['code']:p['name'] for p in meta['provinces']};inside=mask>0
    h=np.zeros_like(z);balance={'initialM3':0.,'rainM3':0.,'infiltrationM3':0.,'drainageM3':0.,'boundaryOutflowM3':0.}
    depth=np.zeros((len(times),)+z.shape,dtype='uint8');frames=[];rain_means=[]
    for i,hour_values in enumerate(values):
        rain=np.tensordot(np.asarray(hour_values),weights,axes=1);rain_means.append(float(rain[inside].mean()))
        out=simulate(z,rain,dx=dx,dt=dt,infiltration_mm_h=INFILTRATION,drainage_mm_h=drain,initial=h,capture=(3600,),open_boundary=True);h=out['depth']
        for key in ['rainM3','infiltrationM3','drainageM3','boundaryOutflowM3']:balance[key]+=out['balance'][key]
        shown=np.where(inside,h,0);depth[i]=np.minimum(np.round(shown*100),255).astype('uint8')
        with gzip.open(Path(out_dir)/f'{d}-s{k}-f{i}.bin.gz','wb',compresslevel=6) as f:f.write(depth[i].tobytes())
        wet=h>=THRESHOLD_M
        frames.append({'validAt':times[i],'provincesKm2':{names[c]:round(float((wet&(mask==c)).sum()*dx*dx/1e6),2) for c in names},'maxDepthM':round(float(shown.max()),2)})
    balance['storedM3']=float(h.sum()*dx*dx)
    balance['residualM3']=balance['rainM3']-balance['infiltrationM3']-balance['drainageM3']-balance['boundaryOutflowM3']-balance['storedM3']
    balance['relativeResidual']=abs(balance['residualM3'])/max(1,balance['rainM3'])
    if balance['relativeResidual']>1e-8:raise ArithmeticError(f'Water balance failed for {d}')
    check=validate(obs,depth,mask,affine,crs,[datetime.fromisoformat(t) for t in times])
    return d,k,{'id':str(int(drain)),'index':k,'drainageMmH':drain,'infiltrationMmH':INFILTRATION,'roughness':.06,'rainMeanTotalMm':float(sum(rain_means)),'balance':balance,'validation':check,'frames':frames}

def skill(v):
    """Hit rate above chance for the same wet area. Plain hit rate would always favour the wettest map."""
    if not v.get('positives') or v.get('baseRate') is None:return None
    return v['hitRate']-v['baseRate']

def main(input_path,out_dir):
    bundle=json.loads(Path(input_path).read_text());out_dir=Path(out_dir);out_dir.mkdir(parents=True,exist_ok=True)
    doms=json.loads((ROOT/'model/domains.json').read_text())['domains'];obs_all=bundle.get('observations',[])
    tasks=[];domains=[]
    for dom in doms:
        meta=json.loads((ROOT/'data/domains'/dom['id']/'metadata.json').read_text())
        info={'id':dom['id'],'name':dom['name'],'cellSizeM':meta['cellSizeM'],'shape':meta['shape'],'bbox':meta['bbox'],'provinces':[p['name'] for p in meta['provinces']]}
        try:stations,series,times=select_history(domain_bundle(bundle,meta))
        except ValueError as e:domains.append({**info,'skipped':str(e)});continue
        kept={s['id'] for s in stations};w,s,e,n=meta['bbox']
        xs,ys=transform('EPSG:4326',meta['horizontalCrs'],[st['lng'] for st in stations],[st['lat'] for st in stations])
        values=[[sr[t] for sr in series] for t in times];iso=[t.isoformat() for t in times]
        obs=[o for o in obs_all if s<=o['lat']<=n and w<=o['lng']<=e]
        domains.append({**info,'startAt':(times[0]-timedelta(hours=1)).isoformat(),'endAt':iso[-1],'times':iso,
            'rainStations':[{k:st[k] for k in ['id','name','lat','lng','source']} for st in stations],
            'rainStationsExcluded':[{'id':h['id'],'name':h['name'],'reason':'hourly gap within the selected window'} for h in domain_bundle(bundle,meta)['rainHistory'] if h['id'] not in kept],
            'observationsUsed':{k:sum(1 for o in obs if o['kind']==k) for k in {o['kind'] for o in obs}},'scenarios':[None]*len(DRAINAGE)})
        for k,drain in enumerate(DRAINAGE):tasks.append([dom['id'],k,drain,list(zip(xs,ys)),values,iso,obs,str(out_dir)])
    # a few processes, each running the numba kernel on the remaining cores (no oversubscription)
    cpus=os.cpu_count() or 2;workers=max(1,min(len(tasks),cpus//2,3));threads=max(1,cpus//workers)
    tasks=[tuple(t+[threads]) for t in tasks]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for d,k,sc in pool.map(run_task,tasks):next(x for x in domains if x['id']==d)['scenarios'][k]=sc
    for dom in domains:
        if dom.get('skipped'):continue
        for sc in dom['scenarios']:sc['validation']['skill']=skill(sc['validation'])
        scored=[(sc['validation']['skill'],sc['id']) for sc in dom['scenarios'] if sc['validation'].get('skill') is not None]
        dom['bestScenario']=max(scored)[1] if scored else None
    result={'kind':'experimental-rainfall-replay','engine':'storage-cell-routing-v2 (open edges; not SFINCS/SWMM)','operational':False,'issuedAt':datetime.now(timezone.utc).isoformat(),
        'inputFetchedAt':bundle['fetchedAt'],'inputSha256':bundle.get('rawSha256'),'thresholdM':THRESHOLD_M,'drainageScenariosMmH':DRAINAGE,
        'depthFiles':'<domain>-s<scenario>-f<frame>.bin.gz: gzip uint8 cm, row-major domain grid, 255 = >=255 cm',
        'rainTimeAssumption':'Provider hourly totals interpreted as the hour ending at timestamp in Asia/Bangkok.','rainInterpolation':'inverse distance squared between stations (min 1 km); not radar',
        'timeStepS':{'100m':15,'250m':30},'initialCondition':'zero additional surface storage','boundaryCondition':'open domain edges (free outflow); no river/sea stage forcing',
        'notUsed':['river/canal stages','dam releases and gate/pump operations','photos and reports (validation only)','satellite water'],
        'validationNote':'Citizen reports only say where water was seen; road sensors reading 0 are the only dry checks. Hit rate above baseRate means water is placed where people reported it better than chance.',
        'domains':domains}
    (out_dir/'result.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
    print(json.dumps({'ok':True,'domains':{d['id']:('skipped: '+d['skipped']) if d.get('skipped') else d['endAt'] for d in domains}},ensure_ascii=False))

if __name__=='__main__':
    try:main(sys.argv[1],sys.argv[2])
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
