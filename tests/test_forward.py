"""Forward (forecast) run of the central domain: frames from the issue hour, the release scenarios, water balance.
Short (2 h, frames every hour) so it runs in the test suite. Skipped without the prepared domain data."""
import sys,tempfile,unittest
from datetime import datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'model'))
import run

class DriverTests(unittest.TestCase):
 def test_lag_and_clamping(self):
  start=datetime.fromisoformat('2026-09-30T00:00:00+00:00');s=[100.,110.,None,130.]
  self.assertEqual(run.driver(s,start,datetime.fromisoformat('2026-09-30T03:00:00+00:00'),2),110.)
  self.assertEqual(run.driver(s,start,datetime.fromisoformat('2026-09-30T02:00:00+00:00'),0),110.)  # a gap takes the value before it
  self.assertEqual(run.driver(s,start,datetime.fromisoformat('2026-10-01T00:00:00+00:00'),0),130.)
  self.assertIsNone(run.driver(None,start,start,0))

@unittest.skipUnless((ROOT/'data/domains/central/river.tif').exists(),'prepared domain data not present')
class ForwardTests(unittest.TestCase):
 def test_forward_scenarios_frames_and_balance(self):
  old=(run.SPINUP_H,run.FORWARD_H,run.FORWARD_EVERY);run.SPINUP_H,run.FORWARD_H,run.FORWARD_EVERY=1,2,1
  try:
   out=tempfile.mkdtemp();times=['2026-09-30T08:00:00+07:00','2026-09-30T09:00:00+07:00']
   fc={'startAt':'2026-09-30T00:00:00Z','issuedAt':'2026-09-30T02:10:00Z','q':{'C.7A':{'base':[2000.]*6,'high':[2000.,2000.,2000.,2600.,2600.,2600.]},'S.26':{'base':[500.]*6,'high':[500.]*6}},
       'rain':[{'lat':13.9,'lng':100.5,'startAt':'2026-09-30T00:00:00Z','mm':[0.,0.,0.,5.,5.,5.]}]}
   river={'name':'x','channelDepthM':7.,'q':[2000.,2000.],'q0':2000.,'gauges':[],'inflowStation':'C.7A','inflowLagHours':0,
          'tributaries':[{'name':'ป่าสัก','station':'S.26','lagHours':0,'lat':14.3505,'lng':100.5795}],'tq':[[500.,500.]],'tq0':[500.],'forecast':fc}
   run.spinup_task(('central',river,out,4))
   d,k,sc=run.run_task(('central',1,3.,[(660000.,1520000.)],[[0.],[0.]],times,[],out,river,4))
   f=sc['forecast'];self.assertEqual(set(f)>={'hold','base','high'},True)
   for v in ('hold','base','high'):
    self.assertEqual([x['hoursAhead'] for x in f[v]['frames']],[0,1,2]);self.assertLess(f[v]['balance']['relativeResidual'],1e-8)
    self.assertEqual(f[v]['frames'][0]['newKm2'],0.)
   self.assertEqual(f['hold']['inflow'][-1][1],2000);self.assertEqual(f['high']['inflow'][-1][1],2600)
   self.assertTrue(all(fr['damKm2']==0 for fr in f['hold']['frames']))
  finally:run.SPINUP_H,run.FORWARD_H,run.FORWARD_EVERY=old
