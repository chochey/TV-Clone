import tempfile, unittest
from pathlib import Path
from unittest.mock import patch, Mock
import movie_renamer as m

from organizer_testing import OrganizerTestCase

class ImportSafety(OrganizerTestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.root=Path(self.tmp.name)
  self.info={'title':'Example','year':'2022','imdbID':'tt12345'}
  for name,value in [('get_movie_dest',self.root/'movies'),('get_tv_dest',self.root/'tv'),('query_omdb_episode',None),('check_movie',None)]:
   p=patch.object(m,name,return_value=value);p.start();self.addCleanup(p.stop)
 def folder(self,name,files):
  p=self.root/name;p.mkdir(parents=True)
  for name,data in files.items():
   f=p/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(data)
  return p
 def item(self,folder,tv=None):
  d={'type':'folder','path':folder,'video_files':list(folder.rglob('*.mkv')),'subtitle_files':list(folder.rglob('*.srt'))}
  if tv:d['tv_info']=m.parse_tv_info(tv)
  return d
 def snapshot(self):return {str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
 def test_dry_run_preserves_existing_source_and_destination(self):
  for dest in ['existing.mkv','notes.txt']:
   with self.subTest(dest=dest):
    src=self.folder('src'+dest,{'movie.mkv':b'new'})
    target=self.folder('movies/Example (2022)'+dest, {dest:b'existing'})
    with patch.object(m,'get_movie_dest',return_value=target.parent):
     # Match exact destination name on each independent case.
     target.rename(target.parent/'Example (2022)')
     before=self.snapshot();m.move_movie(self.item(src),self.info,dry_run=True)
     self.assertEqual(before,self.snapshot())
     import shutil;shutil.rmtree(target.parent/'Example (2022)')
 def test_multiple_movie_videos_retained(self):
  src=self.folder('pack',{'part1.mkv':b'long','part2.mkv':b'short'})
  before=self.snapshot();self.assertFalse(m.move_movie(self.item(src),self.info));self.assertEqual(before,self.snapshot())
 def test_partial_tv_move_files_extras_and_keeps_what_it_cannot_place(self):
  src=self.folder('pack',{'Example.S01E01.mkv':b'episode','bonus.mkv':b'bonus','Different.Show.S01E01.mkv':b'other','notes.txt':b'notes'})
  self.assertTrue(m.move_tv_show(self.item(src,'Example.2022.S01'),self.info))
  self.assertEqual((self.root/'tv/Example (2022)/Extras/Season 01 - bonus.mkv').read_bytes(),b'bonus')
  self.assertFalse((src/'bonus.mkv').exists())
  self.assertEqual((src/'Different.Show.S01E01.mkv').read_bytes(),b'other');self.assertTrue((src/'notes.txt').exists())
  self.assertTrue((self.root/'tv/Example (2022)/Season 01/Example - S01E01.mkv').exists())
 def test_extras_stay_in_the_download_folder_when_filing_is_switched_off(self):
  src=self.folder('pack',{'Example.S01E01.mkv':b'episode','bonus.mkv':b'bonus','notes.txt':b'notes'})
  with patch.object(m.config,'FILE_EXTRAS',False):
   self.assertTrue(m.move_tv_show(self.item(src,'Example.2022.S01'),self.info))
  self.assertEqual((src/'bonus.mkv').read_bytes(),b'bonus');self.assertTrue((src/'notes.txt').exists())
  self.assertFalse((self.root/'tv/Example (2022)/Extras').exists())
  self.assertTrue((self.root/'tv/Example (2022)/Season 01/Example - S01E01.mkv').exists())
 def test_folder_episode_never_assigned_to_bonus(self):
  src=self.folder('pack',{'bonus.mkv':b'bonus'})
  self.assertFalse(m.move_tv_show(self.item(src,'Example.S02E03'),self.info));self.assertTrue((src/'bonus.mkv').exists())
 def test_tv_duplicate_retained(self):
  src=self.folder('pack',{'Example.S01E01.mkv':b'new'})
  self.folder('tv/Example (2022)/Season 01',{'Example - S01E01.mkv':b'old'})
  before=self.snapshot();self.assertFalse(m.move_tv_show(self.item(src,'Example.S01'),self.info));self.assertEqual(before,self.snapshot())
 def test_combined_episode_and_year_preserved(self):
  info=m.parse_tv_info('Example.2022.S01E01E02');self.assertEqual(info['year'],'2022');self.assertEqual(info['episode'],[1,2])
  src=self.folder('pack',{'Example.2022.S01E01E02.mkv':b'both'})
  self.assertTrue(m.move_tv_show(self.item(src,'Example.2022.S01'),self.info))
  self.assertTrue((self.root/'tv/Example (2022)/Season 01/Example - S01E01E02.mkv').exists())
 def test_nearest_season_folder_used_not_season_one(self):
  src=self.folder('pack',{'Season 03/Example.E04.mkv':b'episode'})
  self.assertTrue(m.move_tv_show(self.item(src,'Example.S01-S03'),self.info))
  self.assertTrue((self.root/'tv/Example (2022)/Season 03/Example - S03E04.mkv').exists())
 def test_missing_season_is_reviewed(self):
  src=self.folder('pack',{'Example.E04.mkv':b'episode'})
  self.assertFalse(m.move_tv_show(self.item(src,'Example.E04'),self.info));self.assertTrue((src/'Example.E04.mkv').exists())
 def test_two_subtitles_of_one_language_are_both_imported_under_distinct_names(self):
  # They used to be left in Share with a review note each; now the second is numbered and nothing is lost.
  src=self.folder('movie',{'movie.mkv':b'movie','a.eng.srt':b'a','b.eng.srt':b'b'})
  self.assertTrue(m.move_movie(self.item(src),self.info))
  dest=self.root/'movies/Example (2022)'
  self.assertEqual({(dest/n).read_bytes() for n in ['Example (2022).eng.srt','Example (2022).eng.2.srt']},{b'a',b'b'})
  self.assertFalse((src/'a.eng.srt').exists());self.assertFalse((src/'b.eng.srt').exists())
 def test_subtitles_left_behind_join_the_film_already_in_the_library(self):
  # The film was imported earlier and two English subtitles stayed in Share (they used to collide).
  copy=self.folder('movies/Example (2022)',{'Example (2022).mkv':b'movie','Example (2022).ara.srt':b'ara'})
  src=self.folder('leftover',{'Subs/English (SDH).eng.srt':b'sdh','Subs/English (forced).eng.srt':b'forced','site.jpg':b'ad'})
  movies,shows=self.scan(src)
  self.assertEqual(([m['path'] for m in movies],shows),([src],[]))
  self.assertTrue(m.move_movie(movies[0],self.info))
  self.assertEqual((copy/'Example (2022).eng.sdh.srt').read_bytes(),b'sdh');self.assertEqual((copy/'Example (2022).eng.forced.srt').read_bytes(),b'forced')
  self.assertEqual((copy/'Example (2022).ara.srt').read_bytes(),b'ara');self.assertTrue((src/'site.jpg').exists())
 def test_subtitles_left_behind_with_no_film_in_the_library_are_reviewed_and_kept(self):
  src=self.folder('leftover',{'Subs/English.eng.srt':b'eng'})
  movies,_=self.scan(src)
  with self.assertLogs(m.log,level='WARNING') as logs:self.assertFalse(m.move_movie(movies[0],self.info))
  self.assertIn('no copy of the film',logs.output[0]);self.assertTrue((src/'Subs/English.eng.srt').exists())
 def test_a_folder_with_neither_video_nor_subtitles_is_not_media(self):
  src=self.folder('junk',{'site.jpg':b'ad','notes.txt':b'n'})
  self.assertEqual(self.scan(src),([],[]))
 def scan(self,folder):
  # The library for these cases is this test's movies folder, so the organizer can find the earlier import there.
  movies_dir=str(self.root/'movies');Path(movies_dir).mkdir(exist_ok=True)
  for name,value in [('MOVIE_DEST_DIR',movies_dir),('MOVIE_DEST_DIRS',[movies_dir])]:
   p=patch.object(m.config,name,value);p.start();self.addCleanup(p.stop)
  with patch.object(m.config,'SOURCE_DIR',str(folder.parent)),patch.object(m,'ready_for_import',return_value=True):
   movies,shows=m.find_media_in_source()
  return [x for x in movies if x['path']==folder],[x for x in shows if x['path']==folder]
 def test_subtitle_variants_of_one_language_import_with_their_own_tags(self):
  src=self.folder('movie',{'movie.mkv':b'movie','Subs/English (SDH).eng.srt':b'sdh','Subs/English (forced).eng.srt':b'forced'})
  self.assertTrue(m.move_movie(self.item(src),self.info))
  dest=self.root/'movies/Example (2022)'
  self.assertEqual((dest/'Example (2022).eng.sdh.srt').read_bytes(),b'sdh');self.assertEqual((dest/'Example (2022).eng.forced.srt').read_bytes(),b'forced')
 def test_failed_copy_preserves_source_and_removes_partial(self):
  src=self.folder('movie',{'movie.mkv':b'movie'})/'movie.mkv';dst=self.root/'dest/movie.mkv'
  with patch.object(m.os,'link',side_effect=OSError(m.errno.EXDEV, 'different drive')), patch.object(m.shutil,'copyfileobj',side_effect=OSError('disk full')):
   with self.assertRaises(OSError):m.move_without_overwrite(src,dst)
  self.assertEqual(src.read_bytes(),b'movie');self.assertFalse(dst.exists())
 def test_destination_creation_race_never_overwrites(self):
  src=self.folder('movie',{'movie.mkv':b'new'})/'movie.mkv';dst=self.folder('dest',{'movie.mkv':b'old'})/'movie.mkv'
  with self.assertRaises(FileExistsError):m.move_without_overwrite(src,dst)
  self.assertEqual(src.read_bytes(),b'new');self.assertEqual(dst.read_bytes(),b'old')
 def test_wrong_sequel_rejected(self):
  self.assertFalse(m.is_good_match('Example 2','2022',{'title':'Example 3','year':'2022','type':'movie'}))
 def test_movie_search_ranks_all_results_and_rejects_tie(self):
  response=Mock();response.status_code=200
  rows=[{'Title':'Unrelated','Year':'2022','Type':'movie'},{'Title':'Example','Year':'2022','Type':'movie','imdbID':'tt1'}]
  response.json.return_value={'Response':'True','Search':rows}
  with patch.object(m.requests,'get',return_value=response):
   self.assertEqual(m.query_omdb_search('Example','2022')['imdbID'],'tt1')
   rows.append(dict(rows[1],imdbID='tt2'));self.assertIsNone(m.query_omdb_search('Example','2022'))
 def test_episode_request_uses_series_id(self):
  # Remove the setUp episode stub just for this check via module source function.
  import inspect
  namespace=dict(m.__dict__)
  source=Path(m.__file__).read_text();start=source.index('def query_omdb_episode(');end=source.index('def find_media_in_source(',start)
  exec(source[start:end],namespace)
  response=Mock();response.status_code=200;response.json.return_value={'Response':'True','Title':'Episode'}
  with patch.object(m.requests,'get',return_value=response) as get:
   namespace['query_omdb_episode']('Example',1,1,'tt12345')
   self.assertEqual(get.call_args.kwargs['params']['i'],'tt12345');self.assertNotIn('t',get.call_args.kwargs['params'])
 def test_year_is_passed_to_series_match(self):
  src=self.folder('dated',{'Example.2022.S01E01.mkv':b'episode'})
  item=self.item(src,'Example.2022.S01');item['parse_name']='unique-dated-release'
  with patch.object(m,'query_omdb_series',return_value=self.info) as lookup, patch.object(m,'move_tv_show',return_value=True):
   m.process_tv_shows_list([item]);lookup.assert_called_once_with('Example','2022')
 def test_same_name_remakes_without_year_are_not_auto_selected(self):
  response=Mock();response.status_code=200;response.json.return_value={'Response':'True','Search':[
   {'Title':'Example','Year':'1990','Type':'series','imdbID':'tt1'},
   {'Title':'Example','Year':'2022','Type':'series','imdbID':'tt2'}]}
  with patch.object(m.requests,'get',return_value=response):
   self.assertIsNone(m._query_omdb_series_single('Example'))
 def test_successful_dry_run_makes_no_media_changes(self):
  src=self.folder('preview',{'movie.mkv':b'video','a.eng.srt':b'sub'})
  before=self.snapshot();self.assertTrue(m.move_movie(self.item(src),self.info,True));self.assertEqual(before,self.snapshot())
 def test_other_show_in_tv_pack_is_retained(self):
  src=self.folder('mixed',{'Different.Show.S01E01.mkv':b'episode'})
  self.assertFalse(m.move_tv_show(self.item(src,'Example.S01'),self.info));self.assertTrue((src/'Different.Show.S01E01.mkv').exists())
 def test_spinoff_is_not_parent_series(self):
  self.assertFalse(m.is_good_series_match('Law and Order Special Victims Unit',None,{'title':'Law and Order','year':'1990'}))
 def test_library_rename_preserves_multi_video_pack(self):
  src=self.folder('old',{'part1.mkv':b'a','part2.mkv':b'b'})
  before=self.snapshot();self.assertFalse(m.rename_library_folder(src,self.info));self.assertEqual(before,self.snapshot())
 def test_library_subtitle_collision_preserves_both(self):
  src=self.folder('old',{'movie.mkv':b'movie','a.eng.srt':b'a','b.eng.srt':b'b'})
  m.rename_files_in_folder(src,'Example','2022')
  self.assertEqual(sorted(p.read_bytes() for p in src.glob('*.srt')),[b'a',b'b'])

 def test_successful_cross_drive_copy(self):
  src=self.folder('movie',{'movie.mkv':b'movie'})/'movie.mkv';dst=self.root/'dest/movie.mkv'
  with patch.object(m.os,'link',side_effect=OSError(m.errno.EXDEV, 'different drive')):
   m.move_without_overwrite(src,dst)
  self.assertFalse(src.exists());self.assertEqual(dst.read_bytes(),b'movie')
 def test_same_drive_move_does_not_copy_large_video(self):
  src=self.folder('movie',{'movie.mkv':b'movie'})/'movie.mkv';dst=self.root/'dest/movie.mkv'
  with patch.object(m.shutil,'copyfileobj',side_effect=AssertionError('unneeded copy')):
   m.move_without_overwrite(src,dst)
  self.assertFalse(src.exists());self.assertEqual(dst.read_bytes(),b'movie')

 def test_incomplete_movie_held_without_touching_source(self):
  src=self.folder('sample',{'movie.mkv':b'sample','movie.srt':b'subtitles'})
  before=self.snapshot()
  with patch.object(m,'check_movie',return_value='Possible sample: only 1.0 min'),patch.object(m,'review_item') as review:
   self.assertFalse(m.move_movie(self.item(src),self.info));review.assert_called_once()
  self.assertEqual(before,self.snapshot())
