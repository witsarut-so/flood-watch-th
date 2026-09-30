"""River helpers shared by run.py and calibrate_river.py: gauge series, inflow, and the level check.

ThaiWater gauges report water level in m MSL, the DSM uses EGM2008 heights. The offset between the two is close to
constant over one domain, so levels are compared after removing a single offset (mean observed minus simulated
over all gauges and hours): what is checked is the shape of the water surface along the river (slope, and where
it rises), not the absolute level. DSM bank heights were tried and rejected: buildings/trees make them +-5 m.
"""
from collections import deque
from datetime import datetime,timedelta
import numpy as np
from rasterio.warp import transform

def at(s):return datetime.fromisoformat(s)

def hourly(series,times,key,tol_min=40):
    """Value of `key` nearest each hour (within tol), None otherwise."""
    pts=[(at(p['at']),p[key]) for p in series if p.get(key) is not None]
    out=[]
    for t in times:
        best=min(pts,key=lambda x:abs((x[0]-t).total_seconds()),default=None)
        out.append(best[1] if best and abs((best[0]-t).total_seconds())<=tol_min*60 else None)
    return out

def fill(values):
    """Linear interpolation over gaps, flat at the ends; None if nothing to fill from."""
    idx=[i for i,v in enumerate(values) if v is not None]
    if not idx:return None
    return [float(np.interp(i,idx,[values[j] for j in idx])) for i in range(len(values))]

def gauge_inflow(gauges,code,times,lag_h):
    g=next((g for g in gauges if g['code']==code),None)
    if not g:return None,None
    return fill(hourly(g['series'],[t-timedelta(hours=lag_h) for t in times],'q')),g

def near_channel(gauges,channel,affine,crs,max_cells=2):
    """Gauges within max_cells of a channel cell, with that cell."""
    if not gauges:return []
    xs,ys=transform('EPSG:4326',crs,[g['lng'] for g in gauges],[g['lat'] for g in gauges]);R,C=channel.shape;out=[]
    for g,x,y in zip(gauges,xs,ys):
        c=int((x-affine.c)//affine.a);r=int((y-affine.f)//affine.e)
        if not(0<=r<R and 0<=c<C):continue
        r0,r1,c0,c1=max(0,r-max_cells),min(R,r+max_cells+1),max(0,c-max_cells),min(C,c+max_cells+1)
        win=np.argwhere(channel[r0:r1,c0:c1])
        if not len(win):continue
        rr,cc=min(((r0+a,c0+b) for a,b in win),key=lambda p:(p[0]-r)**2+(p[1]-c)**2)
        out.append({**g,'cell':(int(rr),int(cc)),'distM':round(float(np.hypot(rr-r,cc-c))*abs(affine.a))})
    return out

def surface_sim(g,z_carved,h):
    r,c=g['cell'];return float(z_carved[r,c]+h[r,c])

def compare(obs,sim):
    """obs/sim: {code: [level per hour or None]}. Returns offset, per-gauge mean error and rmse after the offset."""
    pairs=[(c,o,m) for c in obs for o,m in zip(obs[c],sim[c]) if o is not None and m is not None]
    if not pairs:return None
    off=float(np.mean([o-m for _,o,m in pairs]));err={}
    for c,o,m in pairs:err.setdefault(c,[]).append(m+off-o)
    return {'offsetM':round(off,2),'rmseM':round(float(np.sqrt(np.mean([e*e for v in err.values() for e in v]))),2),'meanErrorM':{c:round(float(np.mean(v)),2) for c,v in err.items()}}

def channel_bed(z,rv,depth,bin_cells=10):
    """Carved z: DSM channel cells hold bridges, boats and piers that dam the flow. The reference surface is the
    10th percentile of DSM per 1 km of along-channel distance from the inlet (rv==2), made non-increasing
    downstream; the bed is that surface minus depth. Returns (z_carved, ref_surface)."""
    ch=rv>0;H,W=ch.shape;d=np.full(ch.shape,-1,dtype=np.int32);q=deque()
    for r,c in np.argwhere(rv==2):d[r,c]=0;q.append((r,c))
    while q:
        r,c=q.popleft()
        for a in(-1,0,1):
            for b in(-1,0,1):
                y,x=r+a,c+b
                if 0<=y<H and 0<=x<W and ch[y,x] and d[y,x]<0:d[y,x]=d[r,c]+1;q.append((y,x))
    reach=ch&(d>=0);k=d[reach]//bin_cells;zz=z[reach];n=int(k.max())+1
    prof=np.array([np.percentile(zz[k==i],10) if (k==i).any() else np.nan for i in range(n)])
    ok=~np.isnan(prof);prof=np.minimum.accumulate(np.interp(np.arange(n),np.flatnonzero(ok),prof[ok]))
    ref=z.astype(float).copy();ref[reach]=np.interp(d[reach]/bin_cells-.5,np.arange(n),prof)
    zc=z.astype(float).copy();zc[ch]=ref[ch]-depth
    return zc,ref

def inlet(rv):
    """Inflow cells and the wall behind them: the channel cells on the domain edge are closed so the inflow
    cannot leave straight back through the open boundary."""
    wall=np.zeros(rv.shape,dtype=bool);wall[0,:]=rv[0,:]==2;cells=(rv==2)&~wall
    return cells,wall

def cells_near(channel,affine,crs,lat,lng,radius=2):
    """Channel cells within `radius` cells of the channel cell nearest (lat, lng): where a tributary enters."""
    x,y=transform('EPSG:4326',crs,[lng],[lat]);c=int((x[0]-affine.c)//affine.a);r=int((y[0]-affine.f)//affine.e)
    rr,cc=np.nonzero(channel)
    if not len(rr):return np.zeros(channel.shape,dtype=bool)
    k=int(np.argmin((rr-r)**2+(cc-c)**2));r0,c0=int(rr[k]),int(cc[k])
    near=np.zeros(channel.shape,dtype=bool);near[max(0,r0-radius):r0+radius+1,max(0,c0-radius):c0+radius+1]=True
    return near&channel
