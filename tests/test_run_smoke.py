"""End-to-end smoke test of the model tasks on the real central grid (1 h warm-up, 2 h window).
Skipped when the prepared domain data is not present (data-v1 release)."""
import sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'model'))
import run

@unittest.skipUnless((ROOT/'data/domains/central/river.tif').exists(),'prepared domain data not present')
class RunSmokeTests(unittest.TestCase):
 def test_spinup_and_scenarios_run_with_balance(self):
  old=run.SPINUP_H;run.SPINUP_H=1
  try:
   out=tempfile.mkdtemp();times=['2026-09-27T08:00:00+07:00','2026-09-27T09:00:00+07:00']
   river={'name':'x','channelDepthM':7.,'q':[1900.,1900.],'q0':1900.,'gauges':[]}
   run.spinup_task(('central',river,out,4))
   obs=[{'kind':'citizen','lat':13.75,'lng':100.5,'at':'2026-09-27T01:30:00Z','wet':True}]
   for drain in (0.,3.):
    d,k,sc=run.run_task(('central',0,drain,[(660000.,1520000.)],[[5.],[5.]],times,obs,out,river,4))
    self.assertLess(sc['balance']['relativeResidual'],1e-8);self.assertEqual(len(sc['frames']),2);self.assertEqual(sc['validation']['positives'],1)
    self.assertEqual(sc['bangkokDrainageMmH'] is None,drain!=3.)
  finally:run.SPINUP_H=old

if __name__=='__main__':unittest.main()
