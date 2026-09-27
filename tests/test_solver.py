import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'model'))
import numpy as np
from solver import simulate
from run import select_history
class SolverTests(unittest.TestCase):
 def test_uniform_rain_balance_and_units(self):
  out=simulate(np.zeros((4,4)),10,duration_s=3600,dt=30,infiltration_mm_h=2,drainage_mm_h=3)
  np.testing.assert_allclose(out['depth'],.005,atol=1e-12)
  self.assertLess(out['balance']['relativeResidual'],1e-10)
 def test_no_rain_does_not_create_water(self):
  out=simulate(np.arange(36).reshape(6,6),0,duration_s=60)
  self.assertEqual(out['depth'].sum(),0)
 def test_routing_downhill_and_mass(self):
  z=np.tile(np.linspace(2,0,6),(6,1));h=np.zeros((6,6));h[:,0]=.2
  out=simulate(z,0,duration_s=600,initial=h,infiltration_mm_h=0,drainage_mm_h=0)
  self.assertGreater(out['depth'][:,-1].sum(),0)
  self.assertGreaterEqual(out['depth'].min(),0)
  self.assertLess(out['balance']['relativeResidual'],1e-10)
 def test_level_water_remains_at_rest(self):
  z=np.tile(np.linspace(0,.4,6),(6,1));h=.5-z
  out=simulate(z,0,duration_s=600,initial=h,infiltration_mm_h=0,drainage_mm_h=0)
  np.testing.assert_allclose(out['depth'],h,atol=1e-12)
 def test_timestep_sensitivity(self):
  z=np.tile(np.linspace(.2,0,8),(8,1));h=np.zeros((8,8));h[:,0]=.05
  args=dict(duration_s=600,initial=h,infiltration_mm_h=0,drainage_mm_h=0)
  a=simulate(z,0,dt=5,**args)['depth'];b=simulate(z,0,dt=2.5,**args)['depth']
  self.assertLess(float(np.max(np.abs(a-b))),.001)
 def test_missing_history_rejected(self):
  with self.assertRaises(ValueError):select_history({'rainHistory':[]})
 def test_station_with_gap_is_kept_and_gap_left_missing(self):
  hours=lambda skip=():[{'observedAt':f'2026-09-26T{h:02d}:00+07:00','mm':1.} for h in range(0,13) if h not in skip]
  st=lambda i,skip=():{'id':i,'lat':13.9,'lng':100.4,'samples':hours(skip)}
  bundle={'fetchedAt':'2026-09-26T05:20:00Z','rainHistory':[st(5),st(26,(9,)),st(24)]}
  stations,series,times=select_history(bundle)
  self.assertEqual([s['id'] for s in stations],[5,26,24])
  self.assertEqual(len(times),13)
  gap=[t for t in times if t not in series[1]]
  self.assertEqual([t.hour for t in gap],[9])  # missing hour stays missing (interpolated later), not 0
 def test_short_runs_everywhere_rejected(self):
  st=lambda i:{'id':i,'lat':13.9,'lng':100.4,'samples':[{'observedAt':f'2026-09-26T{h:02d}:00+07:00','mm':1.} for h in (8,10,11,12)]}
  with self.assertRaises(ValueError):select_history({'fetchedAt':'2026-09-26T05:20:00Z','rainHistory':[st(1),st(2)]})  # 09:00 has no station -> only 3 h
class OpenBoundaryTests(unittest.TestCase):
 def test_water_leaves_downhill_edge_with_mass_balance(self):
  z=np.tile(np.linspace(1,0,10),(6,1));h=np.full((6,10),.05)
  out=simulate(z,0,duration_s=1800,dt=5,initial=h,infiltration_mm_h=0,drainage_mm_h=0,open_boundary=True)
  self.assertGreater(out['balance']['boundaryOutflowM3'],0)
  self.assertLess(out['balance']['relativeResidual'],1e-10)
  self.assertLess(out['depth'].sum(),h.sum())
 def test_closed_edges_keep_all_water(self):
  z=np.tile(np.linspace(1,0,10),(6,1));h=np.full((6,10),.05)
  out=simulate(z,0,duration_s=600,dt=5,initial=h,infiltration_mm_h=0,drainage_mm_h=0)
  self.assertEqual(out['balance']['boundaryOutflowM3'],0)
  self.assertAlmostEqual(out['depth'].sum(),h.sum())
class RiverTermsTests(unittest.TestCase):
 def test_deep_channel_stays_wet_and_carries_inflow(self):
  # a 6 m deep, 3-cell wide channel fed 1500 m3/s: the old diffusive flux oscillated here (half the cells dry)
  z=np.tile(np.linspace(2,0,60),(9,1))+2.;z[3:6,:]-=6.;h=np.zeros_like(z);h[3:6,1:]=6.
  src=np.zeros_like(z);src[3:6,1]=1500*3.6e6/(3*1e4);wall=np.zeros(z.shape,bool);wall[3:6,0]=True
  for nb in (False,True):
   out=simulate(z,0,duration_s=6*3600,dx=100,dt=15,infiltration_mm_h=0,drainage_mm_h=0,initial=h,capture=(),open_boundary=True,inflow_mm_h=src,wall=wall,use_numba=nb)
   ch=out['depth'][3:6,2:-1];self.assertGreater(float(ch.min()),1.)
   self.assertEqual(float(simulate(z,50,duration_s=600,dx=100,dt=15,initial=out['depth'],wall=wall,use_numba=nb)['depth'][wall].max()),0.)
   self.assertLess(out['balance']['relativeResidual'],1e-9);self.assertGreater(out['balance']['boundaryOutflowM3'],.5*out['balance']['inflowM3'])

 def test_inflow_sink_and_cell_drainage_balance_numba_matches_numpy(self):
  rng=np.random.default_rng(3);z=np.tile(np.linspace(3,0,20),(12,1))+rng.random((12,20))*.2
  src=np.zeros_like(z);src[5:7,0]=500.  # river entering on the west
  sink=np.zeros(z.shape,dtype=np.uint8);sink[:,-1]=1  # sea on the east
  drn=np.where(np.arange(20)[None,:]<10,4.,0.)*np.ones_like(z)
  args=dict(duration_s=3600,dx=100,dt=5,infiltration_mm_h=1,drainage_mm_h=drn,inflow_mm_h=src,sink=sink,capture=(3600,))
  a=simulate(z,8,use_numba=False,**args);b=simulate(z,8,use_numba=True,**args)
  self.assertLess(float(np.abs(a['depth']-b['depth']).max()),1e-12)
  for out in (a,b):
   self.assertGreater(out['balance']['inflowM3'],0);self.assertGreater(out['balance']['sinkM3'],0)
   self.assertLess(out['balance']['relativeResidual'],1e-10)
  self.assertEqual(float(b['depth'][:,-1].sum()),0.)
class ValidationTests(unittest.TestCase):
 def setUp(self):
  from datetime import datetime,timezone,timedelta
  from rasterio.transform import from_origin
  self.times=[datetime(2026,9,26,h,tzinfo=timezone.utc) for h in (1,2)]
  self.affine=from_origin(0,1000,100,100);self.mask=np.ones((10,10),dtype='uint8')
  self.depth=np.zeros((2,10,10),dtype='uint8');self.depth[1,2,2]=10
 def obs(self,x,y,wet,h=2):
  import rasterio.warp
  lng,lat=rasterio.warp.transform('EPSG:32647','EPSG:4326',[x],[y])
  return {'kind':'citizen' if wet else 'sensor','lat':lat[0],'lng':lng[0],'at':f'2026-09-26T{h:02d}:00:00Z','wet':wet}
 def test_neighbourhood_hit_and_false_alarm(self):
  from run import validate
  obs=[self.obs(350,750,True),self.obs(850,150,True),self.obs(250,750,False),self.obs(250,750,True,h=9)]
  v=validate(obs,self.depth,self.mask,self.affine,'EPSG:32647',self.times)
  self.assertEqual((v['positives'],v['hits'],v['negatives'],v['falseAlarms']),(2,1,1,1))
  self.assertAlmostEqual(v['baseRate'],.09)
 def test_window_up_to_24h(self):
  st=lambda i:{'id':i,'lat':13.9,'lng':100.4,'samples':[{'observedAt':(f'2026-09-25T{h:02d}:00+07:00' if h<24 else f'2026-09-26T{h-24:02d}:00+07:00'),'mm':1.} for h in range(0,37)]}
  _,_,times=select_history({'fetchedAt':'2026-09-26T05:20:00Z','rainHistory':[st(1),st(2)]})
  self.assertEqual(len(times),36)
if __name__=='__main__':unittest.main()
