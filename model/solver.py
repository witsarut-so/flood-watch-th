"""Experimental conservative storage-cell surface routing, NOT SFINCS/SWMM.

Manning diffusive face flux, explicit fixed steps and donor-volume limiting.
Edges are closed by default; open_boundary=True lets water leave through the domain edge as if the
bed continued with the slope of the last interior cell (at least the local depth gradient), and the
volume that leaves is reported as boundaryOutflowM3.
Per-cell terms (scalars or arrays, mm/h): rain, inflow (e.g. a river entering the domain),
infiltration and drainage (e.g. pumping capacity spread over an area). `sink` marks cells held dry
(e.g. the sea): water reaching them is removed and reported as sinkM3.
Useful for sensitivity experiments only; not a validated hydraulic forecast.
"""
import numpy as np

def _edge_flux(h,z_edge,z_in,dx,roughness,step):
    """Outflow depth over one step through one edge (arrays along that edge)."""
    slope=np.maximum(h,z_in-z_edge+h)/dx
    return h**(5/3)*np.sqrt(np.maximum(slope,0))/roughness*step/dx

try:
    import numba
    from numba import njit,prange
except ImportError:  # numpy reference path only
    numba=None

if numba:
    @njit(parallel=True,cache=True,fastmath=False)
    def _step(z,h,rain,src,step,dx,inf_rate,drn_rate,n,open_b,sink,fx,fy,outg,edge):
        """One explicit step, same arithmetic as the numpy path. edge rows: 0=west 1=east 2=north 3=south."""
        R,C=z.shape;c=step/3600000.;rv=0.;sv=0.;iv=0.;dv=0.
        for r in prange(R):
            for q in range(C):
                a=rain[r,q]*c;b=src[r,q]*c;hh=h[r,q]+a+b;rv+=a;sv+=b
                t=min(hh,inf_rate[r,q]*c);hh-=t;iv+=t
                t=min(hh,drn_rate[r,q]*c);hh-=t;dv+=t
                h[r,q]=hh
        k=step/dx/n
        for r in prange(R):
            for q in range(C):outg[r,q]=0.
        for r in prange(R):
            for q in range(C-1):
                e1=z[r,q]+h[r,q];e2=z[r,q+1]+h[r,q+1];sl=(e1-e2)/dx
                hf=max(0.,max(e1,e2)-max(z[r,q],z[r,q+1]))
                f=np.sign(sl)*hf**(5/3)*np.sqrt(abs(sl))*k;fx[r,q]=f
        for r in prange(R-1):
            for q in range(C):
                e1=z[r,q]+h[r,q];e2=z[r+1,q]+h[r+1,q];sl=(e1-e2)/dx
                hf=max(0.,max(e1,e2)-max(z[r,q],z[r+1,q]))
                fy[r,q]=np.sign(sl)*hf**(5/3)*np.sqrt(abs(sl))*k
        for r in prange(R):
            for q in range(C):
                o=0.
                if q<C-1 and fx[r,q]>0:o+=fx[r,q]
                if q>0 and fx[r,q-1]<0:o-=fx[r,q-1]
                if r<R-1 and fy[r,q]>0:o+=fy[r,q]
                if r>0 and fy[r-1,q]<0:o-=fy[r-1,q]
                outg[r,q]=o
        if open_b:
            for r in range(R):
                hw=h[r,0];sw=max(hw,z[r,1]-z[r,0]+hw)/dx;edge[0,r]=hw**(5/3)*np.sqrt(max(sw,0.))*k;outg[r,0]+=edge[0,r]
                he=h[r,C-1];se=max(he,z[r,C-2]-z[r,C-1]+he)/dx;edge[1,r]=he**(5/3)*np.sqrt(max(se,0.))*k;outg[r,C-1]+=edge[1,r]
            for q in range(C):
                hn=h[0,q];sn=max(hn,z[1,q]-z[0,q]+hn)/dx;edge[2,q]=hn**(5/3)*np.sqrt(max(sn,0.))*k;outg[0,q]+=edge[2,q]
                hs=h[R-1,q];ss=max(hs,z[R-2,q]-z[R-1,q]+hs)/dx;edge[3,q]=hs**(5/3)*np.sqrt(max(ss,0.))*k;outg[R-1,q]+=edge[3,q]
        # outg now holds the limiter scale
        for r in prange(R):
            for q in range(C):
                o=outg[r,q];outg[r,q]=min(1.,h[r,q]/o) if o>0 else 1.
        for r in prange(R):
            for q in range(C-1):
                f=fx[r,q];fx[r,q]=f*(outg[r,q] if f>=0 else outg[r,q+1])
        for r in prange(R-1):
            for q in range(C):
                f=fy[r,q];fy[r,q]=f*(outg[r,q] if f>=0 else outg[r+1,q])
        ov=0.
        if open_b:
            for r in range(R):
                edge[0,r]*=outg[r,0];edge[1,r]*=outg[r,C-1];ov+=edge[0,r]+edge[1,r]
            for q in range(C):
                edge[2,q]*=outg[0,q];edge[3,q]*=outg[R-1,q];ov+=edge[2,q]+edge[3,q]
        mn=0.;kv=0.
        for r in prange(R):
            for q in range(C):
                v=h[r,q]
                if q<C-1:v-=fx[r,q]
                if q>0:v+=fx[r,q-1]
                if r<R-1:v-=fy[r,q]
                if r>0:v+=fy[r-1,q]
                if open_b:
                    if q==0:v-=edge[0,r]
                    if q==C-1:v-=edge[1,r]
                    if r==0:v-=edge[2,q]
                    if r==R-1:v-=edge[3,q]
                mn=min(mn,v);v=max(v,0.)
                if sink[r,q]:kv+=v;v=0.
                h[r,q]=v
        return rv,sv,iv,dv,ov,kv,mn

def simulate(z, rain_mm_h, duration_s=3600, dx=100., dt=2., infiltration_mm_h=2., drainage_mm_h=3., roughness=.06, initial=None, capture=(900,1800,3600), open_boundary=False, use_numba=True, inflow_mm_h=0., sink=None):
    z=np.asarray(z,dtype=float);full=lambda v:np.ascontiguousarray(np.broadcast_to(np.asarray(v,dtype=float),z.shape))
    rain,src,inf,drn=full(rain_mm_h),full(inflow_mm_h),full(infiltration_mm_h),full(drainage_mm_h)
    sink=np.zeros(z.shape,dtype=np.uint8) if sink is None else np.ascontiguousarray(np.asarray(sink,dtype=np.uint8))
    if z.ndim!=2 or min(z.shape)<2 or not np.isfinite(z).all() or not all(np.isfinite(a).all() for a in (rain,src,inf,drn)):raise ValueError('Invalid grid')
    if min(dx,dt,duration_s,roughness)<=0 or any(np.any(a<0) for a in (rain,src,inf,drn)) or sink.shape!=z.shape:raise ValueError('Invalid parameters')
    h=np.zeros_like(z) if initial is None else np.array(initial,dtype=float,copy=True)
    if h.shape!=z.shape or not np.isfinite(h).all() or np.any(h<0):raise ValueError('Invalid initial water')
    area=dx*dx;initial_volume=float(h.sum()*area);rain_volume=in_volume=loss_infil=loss_drain=out_volume=sink_volume=0.;elapsed=0.;frames=[]
    if numba and use_numba:
        z=np.ascontiguousarray(z);R,C=z.shape
        fx=np.zeros((R,C-1));fy=np.zeros((R-1,C));outg=np.zeros((R,C));edge=np.zeros((4,max(R,C)))
        while elapsed<duration_s-1e-9:
            step=min(dt,duration_s-elapsed)
            pending=[t for t in capture if t>elapsed+1e-9]
            if pending:step=min(step,min(pending)-elapsed)
            rv,sv,iv,dv,ov,kv,mn=_step(z,h,rain,src,float(step),float(dx),inf,drn,float(roughness),bool(open_boundary),sink,fx,fy,outg,edge)
            if mn< -1e-10:raise ArithmeticError('Negative water')
            rain_volume+=rv*area;in_volume+=sv*area;loss_infil+=iv*area;loss_drain+=dv*area;out_volume+=ov*area;sink_volume+=kv*area;elapsed+=step
            if any(abs(elapsed-t)<1e-6 for t in capture):frames.append((int(elapsed),h.copy()))
    sinkb=sink.astype(bool)
    while elapsed<duration_s-1e-9:
        step=min(dt,duration_s-elapsed)
        pending=[t for t in capture if t>elapsed+1e-9]
        if pending:step=min(step,min(pending)-elapsed)
        added=rain*(step/3600000);inflow=src*(step/3600000);h+=added+inflow;rain_volume+=float(added.sum()*area);in_volume+=float(inflow.sum()*area)
        infil=np.minimum(h,inf*step/3600000);h-=infil;loss_infil+=float(infil.sum()*area)
        drain=np.minimum(h,drn*step/3600000);h-=drain;loss_drain+=float(drain.sum()*area)
        eta=z+h
        sx=(eta[:,:-1]-eta[:,1:])/dx;sy=(eta[:-1,:]-eta[1:,:])/dx
        hx=np.maximum(0,np.maximum(eta[:,:-1],eta[:,1:])-np.maximum(z[:,:-1],z[:,1:]))
        hy=np.maximum(0,np.maximum(eta[:-1,:],eta[1:,:])-np.maximum(z[:-1,:],z[1:,:]))
        fx=np.sign(sx)*hx**(5/3)*np.sqrt(np.abs(sx))/roughness*step/dx
        fy=np.sign(sy)*hy**(5/3)*np.sqrt(np.abs(sy))/roughness*step/dx
        outgoing=np.zeros_like(h)
        outgoing[:,:-1]+=np.maximum(fx,0);outgoing[:,1:]+=np.maximum(-fx,0)
        outgoing[:-1,:]+=np.maximum(fy,0);outgoing[1:,:]+=np.maximum(-fy,0)
        if open_boundary:
            ow=_edge_flux(h[:,0],z[:,0],z[:,1],dx,roughness,step);oe=_edge_flux(h[:,-1],z[:,-1],z[:,-2],dx,roughness,step)
            on=_edge_flux(h[0,:],z[0,:],z[1,:],dx,roughness,step);os_=_edge_flux(h[-1,:],z[-1,:],z[-2,:],dx,roughness,step)
            outgoing[:,0]+=ow;outgoing[:,-1]+=oe;outgoing[0,:]+=on;outgoing[-1,:]+=os_
        scale=np.minimum(1,np.divide(h,outgoing,out=np.ones_like(h),where=outgoing>0))
        fx*=np.where(fx>=0,scale[:,:-1],scale[:,1:]);fy*=np.where(fy>=0,scale[:-1,:],scale[1:,:])
        h[:,:-1]-=fx;h[:,1:]+=fx;h[:-1,:]-=fy;h[1:,:]+=fy
        if open_boundary:
            ow*=scale[:,0];oe*=scale[:,-1];on*=scale[0,:];os_*=scale[-1,:]
            h[:,0]-=ow;h[:,-1]-=oe;h[0,:]-=on;h[-1,:]-=os_
            out_volume+=float((ow.sum()+oe.sum()+on.sum()+os_.sum())*area)
        if float(h.min()) < -1e-10:raise ArithmeticError('Negative water')
        h=np.maximum(h,0);sink_volume+=float(h[sinkb].sum()*area);h[sinkb]=0;elapsed+=step
        if any(abs(elapsed-t)<1e-6 for t in capture):frames.append((int(elapsed),h.copy()))
    volume=float(h.sum()*area)
    residual=initial_volume+rain_volume+in_volume-loss_infil-loss_drain-out_volume-sink_volume-volume
    return {'depth':h,'frames':frames,'balance':{'initialM3':initial_volume,'rainM3':rain_volume,'inflowM3':in_volume,'infiltrationM3':loss_infil,'drainageM3':loss_drain,'boundaryOutflowM3':out_volume,'sinkM3':sink_volume,'storedM3':volume,'residualM3':residual,'relativeResidual':abs(residual)/max(1,initial_volume+rain_volume+in_volume)}}
