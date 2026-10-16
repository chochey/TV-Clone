import json,tempfile,unittest
from pathlib import Path
from organizer_readiness import ready_for_import,existing_series
class ReadinessTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.source=self.root/'Pack';self.source.mkdir();self.video=self.source/'episode.mkv';self.video.write_bytes(b'video');self.snapshot=self.root/'state.json';self.observations={}
 def state(self,ready=True,at=100000):self.snapshot.write_text(json.dumps({'updatedAt':at,'entries':[{'names':['Pack'],'ready':ready}]}))
 def test_moving_blocks_even_stable_files(self):
  self.state(False);self.assertFalse(ready_for_import(self.source,self.snapshot,self.observations,100));self.assertFalse(ready_for_import(self.source,self.snapshot,self.observations,135))
 def test_ready_requires_stable_files_then_retries_automatically(self):
  self.state(False);self.assertFalse(ready_for_import(self.source,self.snapshot,self.observations,100))
  self.state(True);self.assertFalse(ready_for_import(self.source,self.snapshot,self.observations,101));self.assertTrue(ready_for_import(self.source,self.snapshot,self.observations,132))
 def test_file_change_restarts_stability_window(self):
  self.state();ready_for_import(self.source,self.snapshot,self.observations,100);self.video.write_bytes(b'more');self.assertFalse(ready_for_import(self.source,self.snapshot,self.observations,131))
 def test_missing_or_stale_status_blocks_import(self):
  self.assertFalse(ready_for_import(self.source,self.snapshot,self.observations,100));self.state();self.assertFalse(ready_for_import(self.source,self.snapshot,self.observations,146))
 def show(self,name):
  p=self.root/name/'Season 01';p.mkdir(parents=True);(p/'Show - S01E01.mkv').write_bytes(b'existing')
 def test_existing_show_matches_exact_title(self):
  self.show('Lanterns (2026)');self.assertEqual(existing_series('Lanterns',None,[self.root])['year'],'2026');self.assertIsNone(existing_series('Dark Lanterns',None,[self.root]))
 def test_remakes_require_unambiguous_year(self):
  self.show('Example (2000)');self.show('Example (2020)');self.assertIsNone(existing_series('Example',None,[self.root]));self.assertEqual(existing_series('Example','2020',[self.root])['year'],'2020')
if __name__=='__main__':unittest.main()
