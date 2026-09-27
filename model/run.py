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
import river as rv_mod
ROOT=Path(__file__).resolve().parents[1]
THRESHOLD_M=.02;DRAINAGE=[0.,3.,8.];INFILTRATION=2.;MAX_HOURS=36  # rain_24h_graph returns ~37 h

def select_history(bundle,min_stations=2):
    """Choose the longest recent window (6..MAX_HOURS h, ending at the latest hour within 3 h of fetch) in which
    every hour has rain from at least `min_stations` stations. A station missing some hours is kept: those hours
    are interpolated from the stations that did report (never zero-filled). Stations with no value in the
    window are left out. Returns (stations, series, times) with series[i][t] possibly missing."""
    histories=bundle.get('rainHistory',[])
    if len(histories)<min_stations:raise ValueError('ต้องมีประวัติฝนที่ใช้ได้อย่างน้อย 2 สถานี')
    now=datetime.fromisoformat(bundle['fetchedAt'].replace('Z','+00:00'))
    series=[]
    for station in histories:
        values={}
        for s in station['samples']:
            if s['observedAt'] and s['mm'] is not None and 0<=s['mm']<=500:
                t=datetime.fromisoformat(s['observedAt'])
                if t<=now:values[t]=s['mm']
        series.append(values)
    reporting=lambda t:sum(1 for s in series if t in s)
    ends=sorted({t for s in series for t in s if (now-t).total_seconds()<=10800 and reporting(t)>=min_stations},reverse=True)
    if not ends:raise ValueError('ไม่มีฝนล่าสุด (ไม่เกิน 3 ชั่วโมง) จากอย่างน้อย 2 สถานี')
    end=ends[0];times=[end]
    while len(times)<MAX_HOURS and reporting(times[0]-timedelta(hours=1))>=min_stations:times.insert(0,times[0]-timedelta(hours=1))
    if len(times)<6:raise ValueError('ต้องมีฝนต่อเนื่องอย่างน้อย 6 ชั่วโมง (อย่างน้อย 2 สถานีต่อชั่วโมง) ไม่มีการแทนข้อมูลหายด้วยศูนย์')
    members=[i for i,s in enumerate(series) if any(t in s for t in times)]
    return [histories[i] for i in members],[series[i] for i in members],times

def validate(obs,depth,mask,affine,crs,times):
    """Compare point observations with the modelled depth at the nearest simulated hour.
    Wet = citizen flood report or road sensor >= 5 cm; dry = road sensor reading 0. Hit if any cell in the
    3x3 neighbourhood (+-100 m, for position error and road-in-cell) is >= threshold; a dry point is a false
    alarm if its own cell is wet. Readings up to 2 h after the last hour are compared with the last hour: road sensors
    only report their current value, and rain data lags ~1 h, so without this every dry reading would be dropped. baseRate = share of mask cells that would count as a hit by chance."""
    if not obs:return {'n':0}
    xs,ys=transform('EPSG:4326',crs,[o['lng'] for o in obs],[o['lat'] for o in obs])
    t0=times[0]-timedelta(hours=1);th=round(THRESHOLD_M*100)
    wet=depth>=th;pad=np.pad(wet,((0,0),(1,1),(1,1)));near=np.zeros_like(wet)
    for dr in (0,1,2):
        for dc in (0,1,2):near|=pad[:,dr:dr+wet.shape[1],dc:dc+wet.shape[2]]
    inside=mask>0;base_by_frame=[float(near[f][inside].mean()) if inside.any() else 0. for f in range(len(times))];res={'positives':0,'hits':0,'negatives':0,'falseAlarms':0,'baseRate':[],'kinds':{}}
    for o,x,y in zip(obs,xs,ys):
        at=datetime.fromisoformat(o['at'].replace('Z','+00:00'))
        if not t0<=at<=times[-1]+timedelta(hours=2):continue
        f=min(range(len(times)),key=lambda i:abs((times[i]-at).total_seconds()))
        c=int((x-affine.c)//affine.a);r=int((y-affine.f)//affine.e)
        if not(0<=r<mask.shape[0] and 0<=c<mask.shape[1]) or not inside[r,c]:continue
        if o['wet']:
            k=res['kinds'].setdefault(o['kind'],[0,0,[]]);k[0]+=1;k[1]+=int(near[f,r,c]);k[2].append(base_by_frame[f])
            # satellite areas (mostly river flooding on farmland, often from before the rain window) are reported
            # on their own and kept out of the score, which is about rain-driven street/urban flooding
            if o['kind']=='satellite':continue
            res['positives']+=1;res['hits']+=int(near[f,r,c]);res['baseRate'].append(base_by_frame[f])
        else:res['negatives']+=1;res['falseAlarms']+=int(wet[f,r,c])
    base=float(np.mean(res['baseRate'])) if res['baseRate'] else None
    return {'n':res['positives']+res['negatives'],'positives':res['positives'],'hits':res['hits'],'hitRate':res['hits']/res['positives'] if res['positives'] else None,'baseRate':base,
        'negatives':res['negatives'],'falseAlarms':res['falseAlarms'],'falseAlarmRate':res['falseAlarms']/res['negatives'] if res['negatives'] else None,'byKind':{k:{'n':v[0],'hits':v[1],'hitRate':v[1]/v[0],'baseRate':float(np.mean(v[2]))} for k,v in res['kinds'].items()}}

def domain_bundle(bundle,meta,pad=.2):
    w,s,e,n=meta['bbox']
    return {**bundle,'rainHistory':[h for h in bundle.get('rainHistory',[]) if s-pad<=h['lat']<=n+pad and w-pad<=h['lng']<=e+pad]}

# Middle drainage scenario inside Bangkok: BMA pumping stations discharge ~1,300 m3/s to the Chao Phraya (both banks),
# spread over the Bangkok cells of the grid (ThaiPublica interview with BMA, 2025). Elsewhere the 3 mm/h assumption stays.
BMA_PUMPING_M3S=1300.
MIN_DRY=20  # dry sensor readings needed before false alarms count in the score
SPINUP_H=24  # river-only warm-up so the channel is already flowing when the rain window starts

def dam_series(points,times,lag_h):
    """m3/s entering the domain at each simulated hour: news-reported dam release `lag_h` hours earlier.
    Uses 'actual' readings only; the median of those reported in the 12 h before the lagged time, else the
    latest before it, else the earliest one (backfill at the start of the record)."""
    act=sorted((datetime.fromisoformat(p['at'].replace('Z','+00:00')),p['m3s']) for p in points if p.get('type')=='actual')
    if not act:return None
    out=[]
    for t in times:
        tl=t-timedelta(hours=lag_h);recent=[v for at,v in act if tl-timedelta(hours=12)<=at<=tl]
        before=[v for at,v in act if at<=tl]
        out.append(float(np.median(recent)) if recent else float(before[-1]) if before else float(act[0][1]))
    return out

def set_threads(threads):
    try:
        import numba;numba.set_num_threads(threads)
    except (ImportError,ValueError):pass

def setup(d,drain,river):
    """Grids and per-cell terms of one (domain, drainage scenario), with the river channel carved in."""
    base=ROOT/'data/domains'/d;s={}
    with rasterio.open(base/'dsm.tif') as src:z=src.read(1).astype(float);s['affine']=src.transform;s['crs']=src.crs
    with rasterio.open(base/'mask.tif') as src:mask=src.read(1)
    meta=json.loads((base/'metadata.json').read_text());dx=meta['cellSizeM']
    dt=15 if dx<=100 else 30  # longest step; the solver shortens it where water is deep (0.7 dx / sqrt(g h))
    names={p['code']:p['name'] for p in meta['provinces']}
    # drainage per cell: scenario value, with the Bangkok pumping capacity in the middle scenario
    drn=np.full(z.shape,float(drain));bkk=[c for c,nm in names.items() if nm=='กรุงเทพฯ']
    if drain==3. and bkk:cells=(mask==bkk[0]);drn[cells]=BMA_PUMPING_M3S/(cells.sum()*dx*dx)*3.6e6
    inf=np.full(z.shape,INFILTRATION);h=np.zeros_like(z);channel=np.zeros(z.shape,dtype=bool)
    s.update(bkk=bkk[0] if bkk else None,z=z,mask=mask,meta=meta,dx=dx,dt=dt,names=names,drn=drn,inf=inf,h=h,channel=channel,sink=None,wall=None,per_cell=None)
    if river:
        with rasterio.open(base/'river.tif') as src:rv=src.read(1)
        channel=rv>0;z,ref=rv_mod.channel_bed(z,rv,river['channelDepthM']);h[channel]=(ref-z)[channel]  # smoothed bed, filled to the dry-season (DSM) level
        drn[channel]=0;inf[channel]=0
        # sea: low cells outside the provinces near the southern edge are held at sea level (dry sink)
        R=z.shape[0];sink=np.zeros(z.shape,dtype=np.uint8);sink[int(R*.9):,:]=((z[int(R*.9):,:]<=.5)&(mask[int(R*.9):,:]==0)&~channel[int(R*.9):,:])
        inlet,wall=rv_mod.inlet(rv);h[wall]=0
        s.update(z=z,channel=channel,sink=sink,wall=wall,per_cell=lambda q:np.where(inlet,q*3.6e6/(inlet.sum()*dx*dx),0.))
    return s

SPIN_DRAIN=3.  # the shared river warm-up uses the middle scenario's drainage
def spin_path(out_dir,d):return Path(out_dir)/f'_spinup-{d}.npz'

def spinup_task(task):
    """River-only warm-up of one domain, shared by all its drainage scenarios (same river, no rain)."""
    d,river,out_dir,threads=task;set_threads(threads);s=setup(d,SPIN_DRAIN,river)
    out=simulate(s['z'],0,duration_s=SPINUP_H*3600,dx=s['dx'],dt=s['dt'],infiltration_mm_h=s['inf'],drainage_mm_h=s['drn'],initial=s['h'],capture=(),open_boundary=True,inflow_mm_h=s['per_cell'](river['q0']),sink=s['sink'],wall=s['wall'])
    np.savez(spin_path(out_dir,d),h=out['depth'],qx=out['flux'][0],qy=out['flux'][1]);return d

def run_task(task):
    """One (domain, scenario): simulate hour by hour, write frames, return stats and validation."""
    d,k,drain,stations_xy,values,times,obs,out_dir,river,threads=task;set_threads(threads)
    s=setup(d,drain,river);z,mask,meta,dx,dt,names,drn,inf,h,channel,sink,wall,per_cell,affine,crs=(s[k_] for k_ in ('z','mask','meta','dx','dt','names','drn','inf','h','channel','sink','wall','per_cell','affine','crs'))
    yy,xx=np.indices(z.shape);gx=affine.c+(xx+.5)*affine.a;gy=affine.f+(yy+.5)*affine.e
    weights=np.array([1/np.maximum((gx-x)**2+(gy-y)**2,1000**2) for x,y in stations_xy],dtype='float32')
    del yy,xx,gx,gy
    inside=mask>0;inflow=0.;flux=None;qs=None
    if river:
        checks=rv_mod.near_channel(river.get('gauges',[]),channel,affine,crs);qs=river['q']
        if qs:
            sp=np.load(spin_path(out_dir,d));h=sp['h'].copy();flux=(sp['qx'].copy(),sp['qy'].copy())
    sim_fb={g['code']:[] for g in (checks if river else [])}
    balance={'initialM3':float(h.sum()*dx*dx),'rainM3':0.,'inflowM3':0.,'infiltrationM3':0.,'drainageM3':0.,'boundaryOutflowM3':0.,'sinkM3':0.}
    depth=np.zeros((len(times),)+z.shape,dtype='uint8');frames=[];rain_means=[]
    for i,hour_values in enumerate(values):
        # inverse-distance weights renormalised over the stations that reported this hour (None = missing)
        avail=[j for j,v in enumerate(hour_values) if v is not None]
        rain=np.tensordot(np.asarray([hour_values[j] for j in avail],dtype='float32'),weights[avail],axes=1)/weights[avail].sum(axis=0);rain_means.append(float(rain[inside].mean()))
        if river and qs:inflow=per_cell(qs[i])
        out=simulate(z,rain,dx=dx,dt=dt,infiltration_mm_h=inf,drainage_mm_h=drn,initial=h,capture=(3600,),open_boundary=True,inflow_mm_h=inflow,sink=sink,wall=wall,flux=flux);h=out['depth'];flux=out['flux']
        for key in ['rainM3','inflowM3','infiltrationM3','drainageM3','boundaryOutflowM3','sinkM3']:balance[key]+=out['balance'][key]
        for g in (checks if river else []):sim_fb[g['code']].append(rv_mod.surface_sim(g,z,h))
        # the river channel itself is not "flooding": only water outside it is shown and counted
        shown=np.where(inside&~channel,h,0);depth[i]=np.minimum(np.round(shown*100),255).astype('uint8')
        with gzip.open(Path(out_dir)/f'{d}-s{k}-f{i}.bin.gz','wb',compresslevel=6) as f:f.write(depth[i].tobytes())
        wet=(h>=THRESHOLD_M)&~channel
        frames.append({'validAt':times[i],'provincesKm2':{names[c]:round(float((wet&(mask==c)).sum()*dx*dx/1e6),2) for c in names},'maxDepthM':round(float(shown.max()),2)})
    balance['storedM3']=float(h.sum()*dx*dx)
    balance['residualM3']=balance['initialM3']+balance['rainM3']+balance['inflowM3']-balance['infiltrationM3']-balance['drainageM3']-balance['boundaryOutflowM3']-balance['sinkM3']-balance['storedM3']
    balance['relativeResidual']=abs(balance['residualM3'])/max(1,balance['initialM3']+balance['rainM3']+balance['inflowM3'])
    if balance['relativeResidual']>1e-8:raise ArithmeticError(f'Water balance failed for {d}')
    check=validate(obs,depth,mask,affine,crs,[datetime.fromisoformat(t) for t in times])
    bkk_rate=float(drn[mask==s['bkk']].mean()) if (s['bkk'] is not None and drain==3.) else None
    gauge_checks=None
    if river and checks:
        tt=[datetime.fromisoformat(t) for t in times];obs={g['code']:rv_mod.hourly(g['series'],tt,'wl') for g in checks};cmp=rv_mod.compare(obs,sim_fb)
        if cmp:gauge_checks={'offsetM':cmp['offsetM'],'rmseM':cmp['rmseM'],'gauges':[{'code':g['code'],'name':g['name'],'lat':g['lat'],'lng':g['lng'],'distM':g['distM'],'bankM':g['bankM'],
            'obsM':obs[g['code']],'simM':[round(v+cmp['offsetM'],2) for v in sim_fb[g['code']]],'meanErrorM':cmp['meanErrorM'].get(g['code'])} for g in checks]}
    return d,k,{'id':str(int(drain)),'index':k,'gaugeChecks':gauge_checks,'drainageMmH':drain,'bangkokDrainageMmH':bkk_rate,'infiltrationMmH':INFILTRATION,'roughness':.06,'rainMeanTotalMm':float(sum(rain_means)),'balance':balance,'validation':check,'frames':frames}

def skill(v):
    """Hit rate above chance for the same wet area, minus the false-alarm rate on dry sensors when there are enough
    of them. Plain hit rate would always favour the wettest map; plain hit-minus-false-alarm (Peirce) too, here,
    because wet points (citizen reports) and dry points (road sensors) are different places."""
    if not v.get('positives') or v.get('baseRate') is None:return None
    return v['hitRate']-v['baseRate']-(v['falseAlarmRate'] if (v.get('negatives') or 0)>=MIN_DRY else 0.)

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
        values=[[sr.get(t) for sr in series] for t in times];iso=[t.isoformat() for t in times]
        coverage=[sum(v is not None for v in row) for row in values]
        obs=[o for o in obs_all if s<=o['lat']<=n and w<=o['lng']<=e]
        domains.append({**info,'startAt':(times[0]-timedelta(hours=1)).isoformat(),'endAt':iso[-1],'times':iso,
            'rainStations':[{k:st[k] for k in ['id','name','lat','lng','source']} for st in stations],
            'rainStationsExcluded':[{'id':h['id'],'name':h['name'],'reason':'no value within the selected window'} for h in domain_bundle(bundle,meta)['rainHistory'] if h['id'] not in kept],'stationsPerHour':coverage,
            'observationsUsed':{k:sum(1 for o in obs if o['kind']==k) for k in {o['kind'] for o in obs}},'scenarios':[None]*len(DRAINAGE)})
        river=None
        if dom.get('river') and (ROOT/'data/domains'/dom['id']/'river.tif').exists():
            cfg=dict(dom['river']);cal=ROOT/'data/domains'/dom['id']/'river-calibration.json'
            if cal.exists():cfg['channelDepthM']=json.loads(cal.read_text())['channelDepthM'];cfg['calibrated']=True
            gauges=[g for g in bundle.get('riverGauges',[]) if g.get('domain')==dom['id']]
            q,g_in=rv_mod.gauge_inflow(gauges,cfg.get('inflowStation'),times,cfg.get('inflowLagHours',0))
            q0=rv_mod.gauge_inflow(gauges,cfg.get('inflowStation'),[times[0]-timedelta(hours=SPINUP_H)],cfg.get('inflowLagHours',0))[0] if q else None
            src='gauge'
            if not q:
                pts=(bundle.get('damRelease') or {}).get('points',[]);src='news'
                q=dam_series(pts,times,cfg['lagHours']);q0=dam_series(pts,[times[0]-timedelta(hours=SPINUP_H)],cfg['lagHours']) if q else None
            river={**cfg,'q':q,'q0':q0[0] if q0 else (q[0] if q else None),'gauges':gauges}
            domains[-1]['river']={'name':cfg['name'],'inflowSource':src if q else None,
                'inflowStation':{'code':g_in['code'],'name':g_in['name'],'lagHours':cfg.get('inflowLagHours',0)} if src=='gauge' and g_in else None,
                'inflowFrom':cfg['inflowFrom'],'lagHours':cfg['lagHours'] if src=='news' else cfg.get('inflowLagHours',0),'channelDepthM':cfg['channelDepthM'],'channelDepthCalibrated':bool(cfg.get('calibrated')),'spinupHours':SPINUP_H if q else 0,
                'inflowM3s':q,'newsPoints':[p for p in (bundle.get('damRelease') or {}).get('points',[]) if p.get('type')=='actual'],
                'note':{'gauge':'Inflow = discharge measured at the gauge (ThaiWater/RID), hourly.','news':'Gauge unavailable: inflow = Chao Phraya Dam release reported in news, delayed by the travel time.'}.get(src if q else '', 'No inflow data: channel only carries local rain.')}
        for k,drain in enumerate(DRAINAGE):tasks.append([dom['id'],k,drain,list(zip(xs,ys)),values,iso,obs,str(out_dir),river])
    # a few processes, each running the numba kernel on the remaining cores (no oversubscription)
    cpus=os.cpu_count() or 2;workers=max(1,min(len(tasks),cpus//2,3));threads=max(1,cpus//workers)
    tasks=[tuple(t+[threads]) for t in tasks]
    # river domains: one shared warm-up first (runs while the other domains' scenarios are computed)
    spins={t[0]:t[8] for t in tasks if t[8] and t[8].get('q')}
    with ProcessPoolExecutor(max_workers=workers) as pool:
        warm=[pool.submit(spinup_task,(d,rv,str(out_dir),threads)) for d,rv in spins.items()]
        futs=[pool.submit(run_task,t) for t in tasks if t[0] not in spins]
        for f in warm:f.result()
        futs+=[pool.submit(run_task,t) for t in tasks if t[0] in spins]
        for f in futs:
            d,k,sc=f.result();next(x for x in domains if x['id']==d)['scenarios'][k]=sc
    for d in spins:spin_path(out_dir,d).unlink(missing_ok=True)
    for dom in domains:
        if dom.get('skipped'):continue
        for sc in dom['scenarios']:sc['validation']['skill']=skill(sc['validation'])
        scored=[(sc['validation']['skill'],sc['id']) for sc in dom['scenarios'] if sc['validation'].get('skill') is not None]
        dom['bestScenario']=max(scored)[1] if scored else None
    result={'kind':'experimental-rainfall-replay','engine':'storage-cell-routing-v3 (local-inertial, Bates et al. 2010; open edges; not SFINCS/SWMM)','operational':False,'issuedAt':datetime.now(timezone.utc).isoformat(),
        'inputFetchedAt':bundle['fetchedAt'],'inputSha256':bundle.get('rawSha256'),'thresholdM':THRESHOLD_M,'drainageScenariosMmH':DRAINAGE,
        'depthFiles':'<domain>-s<scenario>-f<frame>.bin.gz: gzip uint8 cm, row-major domain grid, 255 = >=255 cm',
        'rainTimeAssumption':'Provider hourly totals interpreted as the hour ending at timestamp in Asia/Bangkok.','rainInterpolation':'inverse distance squared between the stations reporting each hour (min 1 km); missing station-hours are interpolated from the others, never zero-filled; not radar',
        'timeStepS':{'100m':15,'250m':30,'note':'longest step; shortened to 0.7 dx/sqrt(g h_max) in deep water'},'initialCondition':'zero additional surface storage; river channel after a shared river-only warm-up (middle drainage scenario)','boundaryCondition':'open domain edges (free outflow); central domain: Chao Phraya channel fed by the discharge measured at C.7A (news-reported dam release if missing), sea cells held dry',
        'bangkokPumping':{'m3s':BMA_PUMPING_M3S,'source':'BMA pumping stations to the Chao Phraya, both banks (ThaiPublica, June 2025)','usedIn':'middle drainage scenario, Bangkok cells'},
        'notUsed':['river/canal stage observations','individual gate/pump operations','photos and reports (validation only)','satellite water'],
        'validationNote':'Citizen reports only say where water was seen; road sensors reading 0 are the only dry checks. Hit rate above baseRate means water is placed where people reported it better than chance.',
        'domains':domains}
    (out_dir/'result.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
    print(json.dumps({'ok':True,'domains':{d['id']:('skipped: '+d['skipped']) if d.get('skipped') else d['endAt'] for d in domains}},ensure_ascii=False))

if __name__=='__main__':
    try:main(sys.argv[1],sys.argv[2])
    except Exception as e:print(str(e),file=sys.stderr);sys.exit(1)
