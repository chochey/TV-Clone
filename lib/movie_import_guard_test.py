import unittest,json,subprocess
from unittest.mock import patch,Mock
from movie_import_guard import assess_duration,check_movie,runtime_seconds
class MovieGuardTests(unittest.TestCase):
 def test_sample(self): self.assertIn('sample',assess_duration(61))
 def test_feature_mismatch(self): self.assertIn('incomplete',assess_duration(2700,7200))
 def test_short_films(self):
  self.assertIsNone(assess_duration(2482,2460));self.assertIsNone(assess_duration(2883));self.assertIsNone(assess_duration(240,240))
 def test_cut_variation(self): self.assertIsNone(assess_duration(6500,7200))
 def test_unknown_runtime(self):
  for v in [0,-1,float('nan'),float('inf')]:self.assertIsNotNone(assess_duration(v))
 def test_runtime_parser(self):self.assertEqual(runtime_seconds('119 min'),7140);self.assertIsNone(runtime_seconds('N/A'))
 def test_actual_video_duration_overrides_long_container(self):
  response=Mock(stdout=json.dumps({'format':{'duration':'7200'},'streams':[{'codec_type':'video','duration':'61'}]}))
  with patch('movie_import_guard.subprocess.run',return_value=response):self.assertIn('sample',check_movie('unused',{}))
 def test_missing_video(self):
  with patch('movie_import_guard.subprocess.run',return_value=Mock(stdout='{"streams":[]}')):self.assertIn('No video',check_movie('unused',{}))
 def test_probe_failure(self):
  with patch('movie_import_guard.subprocess.run',side_effect=subprocess.TimeoutExpired('ffprobe',20)):self.assertIn('Could not read',check_movie('unused',{}))
 def test_real_video_sample_is_held(self):
  import tempfile
  from pathlib import Path
  with tempfile.TemporaryDirectory() as folder:
   source=Path(folder)/'sample.mp4'
   subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=s=64x64:r=1','-t','2','-c:v','libx264','-threads','1',str(source)],check=True)
   self.assertIn('sample',check_movie(source,{}));self.assertTrue(source.exists())
if __name__=='__main__':unittest.main()
