"""Pick the river channel depth whose simulated water levels best match the gauges along the river.

usage: calibrate_river.py <input.json> [domain] [--depths 3,5,7,9] [--hours 24]
<input.json> is a model input bundle (model-inputs.mjs) with riverGauges. For each trial depth the channel is
carved below a smoothed DSM profile (river.channel_bed), filled to that level, and fed the measured inflow (mean of the last `hours` at the inflow gauge) with
no rain for `hours`. Simulated water surface at the gauges near the channel is compared with the observed level
(mean of the last 6 h) after removing one datum offset (see river.py), i.e. the fit is on the river's slope. Writes
data/domains/<domain>/river-calibration.json, which run.py uses instead of the configured depth.
"""
import argparse,json
from datetime import datetime,timezone,timedelta
from pathlib import Path
import numpy as np
import rasterio
from solver import simulate
import river as rv_mod

ROOT=Path(__file__).resolve().parents[1]

def trial(z_dsm,rv,depth,q,hours,dx,dt,mask,gauges,affine,crs):
    channel=rv>0;z,ref=rv_mod.channel_bed(z_dsm,rv,depth);h=np.where(channel,ref-z,0.)
    inf=np.where(channel,0.,2.);inlet,wall=rv_mod.inlet(rv);h[wall]=0
    R=z.shape[0];sink=np.zeros(z.shape,dtype=np.uint8);sink[int(R*.9):,:]=((z[int(R*.9):,:]<=.5)&(mask[int(R*.9):,:]==0)&~channel[int(R*.9):,:])
    src=np.where(inlet,q*3.6e6/(inlet.sum()*dx*dx),0.)
    h=simulate(z,0,duration_s=hours*3600,dx=dx,dt=dt,infiltration_mm_h=inf,drainage_mm_h=0.,initial=h,capture=(),open_boundary=True,inflow_mm_h=src,sink=sink,wall=wall)['depth']
    return {g['code']:rv_mod.surface_sim(g,z,h) for g in gauges}

if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('input');ap.add_argument('domain',nargs='?',default='central')
    ap.add_argument('--depths',default='3,5,7,9');ap.add_argument('--hours',type=int,default=24);a=ap.parse_args()
    cfg=next(d for d in json.loads((ROOT/'model/domains.json').read_text())['domains'] if d['id']==a.domain)['river']
    base=ROOT/'data/domains'/a.domain;bundle=json.loads(Path(a.input).read_text())
    with rasterio.open(base/'dsm.tif') as s:z=s.read(1).astype(float);affine=s.transform;crs=s.crs
    with rasterio.open(base/'mask.tif') as s:mask=s.read(1)
    with rasterio.open(base/'river.tif') as s:rv=s.read(1)
    dx=json.loads((base/'metadata.json').read_text())['cellSizeM'];dt=15 if dx<=100 else 30
    gauges=[g for g in bundle.get('riverGauges',[]) if g.get('domain')==a.domain]
    now=max(rv_mod.at(p['at']) for g in gauges for p in g['series']).replace(minute=0,second=0)
    last=[now-timedelta(hours=i) for i in range(a.hours)]
    q=rv_mod.gauge_inflow(gauges,cfg['inflowStation'],last,cfg.get('inflowLagHours',0))[0]
    if not q:raise SystemExit('No discharge at '+cfg['inflowStation'])
    q=float(np.mean(q))
    near=rv_mod.near_channel([g for g in gauges if g['code']!=cfg['inflowStation']],rv>0,affine,crs)
    obs={g['code']:[v for v in rv_mod.hourly(g['series'],last[:6],'wl') if v is not None] for g in near}
    near=[g for g in near if obs[g['code']]];obs={g['code']:float(np.mean(obs[g['code']])) for g in near}
    if not near:raise SystemExit('No gauges near the channel with water levels')
    print(f'inflow {q:.0f} m3/s, {len(near)} gauges:',', '.join(f"{g['code']} {obs[g['code']]:.2f} m MSL" for g in near),flush=True)
    trials=[]
    for depth in [float(x) for x in a.depths.split(',')]:
        sim=trial(z,rv,depth,q,a.hours,dx,dt,mask,near,affine,crs);c=rv_mod.compare({k:[v] for k,v in obs.items()},{k:[v] for k,v in sim.items()})
        trials.append({'channelDepthM':depth,'rmseM':c['rmseM'],'offsetM':c['offsetM'],'errorM':c['meanErrorM'],'surfaceSimM':{k:round(v,2) for k,v in sim.items()}})
        print(json.dumps(trials[-1]),flush=True)
    best=min(trials,key=lambda t:t['rmseM'])
    out={'domain':a.domain,'channelDepthM':best['channelDepthM'],'calibratedAt':datetime.now(timezone.utc).isoformat(),'inflowM3s':round(q),'hours':a.hours,
         'gauges':[{'code':g['code'],'name':g['name'],'levelObsM':round(obs[g['code']],2),'bankM':g['bankM'],'distM':g['distM']} for g in near],'trials':trials,
         'note':'Fit on water-surface shape along the river (one datum offset removed). A single uniform depth, not a surveyed channel.'}
    (base/'river-calibration.json').write_text(json.dumps(out,ensure_ascii=False,indent=1));print('best',best['channelDepthM'],'m, rmse',best['rmseM'])
