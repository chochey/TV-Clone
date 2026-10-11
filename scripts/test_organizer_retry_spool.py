import ast
import hashlib
import json
import logging
import os
from pathlib import Path
import tempfile
import unittest
import shutil
import stat
from unittest.mock import patch
from organizer_retry_spool import RetrySpool


class SpoolFixture:
    def setUp(self):
        environment = patch.dict(os.environ, {'ORGANIZER_RETRY_SHARED':'', 'ORGANIZER_RETRY_GID':''})
        environment.start()
        self.addCleanup(environment.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'Share'
        self.source.mkdir()
        self.spool = self.root / 'retries'
        self.book = self.source / 'Iron Man [1080p]'
        self.book.mkdir()
        self.now = 1791633600000

    def request(self, source=None, kind='movie', title='Iron Man'):
        source = source or self.book
        info = source.stat()
        packet = {'version': 1, 'requestId': os.urandom(16).hex(), 'source': source.name,
                  'title': title, 'type': kind, 'createdAt': self.now,
                  'fingerprint': {'device': str(info.st_dev), 'inode': str(info.st_ino),
                                  'kind': 'directory' if source.is_dir() else 'file'}}
        self.spool.mkdir(exist_ok=True)
        key = hashlib.sha256(source.name.encode()).hexdigest()[:24]
        file = self.spool / (key + '.json')
        file.write_text(json.dumps(packet))
        return packet, file

    def consumer(self, **kwargs):
        consumer = RetrySpool(self.source, self.spool, now=lambda: self.now, **kwargs)
        self.addCleanup(consumer.close)
        return consumer

    def receipt(self, packet):
        key = hashlib.sha256(packet['source'].encode()).hexdigest()[:24]
        return json.loads((self.spool / (key + '.done.json')).read_text())


class SpoolTest(SpoolFixture, unittest.TestCase):
    def test_default_private_directory_lock_and_receipt_permissions_are_unchanged(self):
        old_umask = os.umask(0o077)
        try:
            consumer = self.consumer()
            packet, file = self.request()
            file.chmod(0o600)
            consumer.poll()
            consumer.complete(self.book.name)
        finally:
            os.umask(old_umask)
        self.assertEqual(stat.S_IMODE(self.spool.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.spool / '.consumer.lock').stat().st_mode), 0o600)
        key = hashlib.sha256(packet['source'].encode()).hexdigest()[:24]
        self.assertEqual(stat.S_IMODE((self.spool / (key + '.done.json')).stat().st_mode), 0o600)

    def test_claim_attempt_receipt_preserves_media(self):
        packet, file = self.request()
        consumer = self.consumer()
        self.assertEqual(consumer.poll()[0]['source'], self.book.name)
        self.assertFalse(file.exists())
        self.assertTrue(consumer.wants(self.book.name))
        self.assertFalse(consumer.wants('Iron Man'))
        consumer.complete(self.book.name)
        self.assertEqual(self.receipt(packet)['status'], 'attempted')
        self.assertEqual(self.receipt(packet)['requestId'], packet['requestId'])
        self.assertTrue(self.book.is_dir())

    def test_changed_source_and_expired_requests_are_rejected(self):
        packet, _ = self.request()
        self.book.rename(self.source / 'Old source')
        self.book.mkdir()
        consumer = self.consumer()
        self.assertEqual(consumer.poll(), [])
        self.assertEqual(self.receipt(packet)['status'], 'rejected')
        packet, file = self.request()
        packet['createdAt'] -= 8 * 24 * 60 * 60 * 1000
        file.write_text(json.dumps(packet))
        self.assertEqual(consumer.poll(), [])
        self.assertEqual(self.receipt(packet)['status'], 'rejected')

    def test_source_shortcuts_and_traversal_cannot_escape(self):
        self.book.rmdir()
        self.book.symlink_to(self.root, target_is_directory=True)
        packet, _ = self.request()
        consumer = self.consumer()
        self.assertEqual(consumer.poll(), [])
        self.assertEqual(self.receipt(packet)['status'], 'rejected')
        outside = self.root / 'outside'
        outside.write_text('kept')
        source = '../outside'
        forged = {'source': source}
        file = self.spool / (hashlib.sha256(source.encode()).hexdigest()[:24] + '.json')
        file.write_text(json.dumps(forged))
        consumer.poll()
        self.assertEqual(outside.read_text(), 'kept')

    def test_lifetime_lock_and_recovery_after_watcher_exit(self):
        packet, _ = self.request()
        consumer = self.consumer()
        consumer.poll()
        with self.assertRaises(BlockingIOError):
            self.consumer()
        consumer.close()
        recovered = self.consumer()
        self.assertEqual(recovered.poll()[0]['requestId'], packet['requestId'])
        recovered.complete(self.book.name)
        self.assertEqual(self.receipt(packet)['status'], 'attempted')

    def test_completed_receipt_prevents_reprocessing_a_claim_left_after_crash(self):
        packet, file = self.request()
        key = file.stem
        file.rename(self.spool / (key + '.claimed.json'))
        (self.spool / (key + '.done.json')).write_text(json.dumps({**packet, 'status': 'attempted', 'completedAt': self.now}))
        consumer = self.consumer()
        self.assertEqual(consumer.poll(), [])
        self.assertFalse((self.spool / (key + '.claimed.json')).exists())

    def test_malformed_packet_does_not_block_another_request_or_expose_contents(self):
        packet, _ = self.request()
        (self.spool / ('0' * 24 + '.json')).write_text('private-invalid-text')
        consumer = self.consumer()
        with self.assertLogs('retry-test', level='WARNING') as logs:
            consumer.log = logging.getLogger('retry-test')
            self.assertEqual(consumer.poll()[0]['requestId'], packet['requestId'])
        self.assertNotIn('private-invalid-text', '\n'.join(logs.output))

    def test_replacement_after_claim_is_checked_again_before_import(self):
        packet, _ = self.request()
        consumer = self.consumer()
        consumer.poll()
        self.book.rename(self.source / 'Old')
        self.book.mkdir()
        self.assertFalse(consumer.wants(self.book.name))
        self.assertEqual(self.receipt(packet)['status'], 'rejected')

    def test_removed_claim_is_rejected_during_poll_without_import_discovery(self):
        packet, _ = self.request()
        consumer = self.consumer()
        consumer.poll()
        self.book.rmdir()
        self.assertEqual(consumer.poll(), [])
        self.assertEqual(self.receipt(packet)['status'], 'rejected')
        self.assertEqual(consumer.active, {})

    def test_runtime_spool_loss_does_not_escape_into_normal_imports(self):
        consumer = self.consumer()
        shutil.rmtree(self.spool)
        self.assertEqual(consumer.poll(), [])
        self.assertTrue(self.book.exists())

    def test_old_receipts_do_not_starve_pending_work_and_history_is_bounded(self):
        packet, _ = self.request()
        for index in range(150):
            (self.spool / (f'{index:024x}.done.json')).write_text('{}')
        consumer = self.consumer()
        self.assertEqual(consumer.poll()[0]['requestId'], packet['requestId'])
        consumer.complete(self.book.name)
        self.assertLessEqual(len(list(self.spool.glob('*.done.json'))), 128)

    def test_symlink_spool_is_not_followed(self):
        self.spool.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.consumer()


class SharedSpoolTest(SpoolFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.gid = os.getegid()
        if self.gid == 0:
            self.skipTest('Shared fixtures require a non-root effective group')
        self.spool.mkdir()
        self.spool.chmod(0o2770)

    def consumer(self, **kwargs):
        options = {'shared':True, 'gid':self.gid, 'identity':(os.geteuid(), {self.gid})}
        options.update(kwargs)
        return super().consumer(**options)

    def request(self, *args, **kwargs):
        packet, file = super().request(*args, **kwargs)
        file.chmod(0o660)
        return packet, file

    def assert_shared(self, file):
        info = file.lstat()
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual(info.st_gid, self.gid)
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o660)

    @staticmethod
    def changed_stat(info, field, value):
        values = list(info)
        values[{'uid':4, 'gid':5}[field]] = value
        return os.stat_result(values)

    def test_effective_owner_acceptance_and_permissions_survive_claim_receipt_and_umask(self):
        old_umask = os.umask(0o077)
        try:
            consumer = self.consumer()
            packet, file = self.request()
            self.assert_shared(file)
            self.assert_shared(self.spool / '.consumer.lock')
            consumer.poll()
            claim = self.spool / (file.stem + '.claimed.json')
            self.assert_shared(claim)
            consumer.complete(self.book.name)
            self.assert_shared(self.spool / (file.stem + '.done.json'))
            self.assertEqual(self.receipt(packet)['status'], 'attempted')
        finally:
            os.umask(old_umask)
        self.assertEqual(stat.S_IMODE(self.spool.stat().st_mode), 0o2770)

    def test_root_owned_precreated_directory_is_accepted_without_chmod(self):
        original_lstat = Path.lstat
        def root_owned(file):
            info = original_lstat(file)
            return self.changed_stat(info, 'uid', 0) if file == self.spool else info
        with patch.object(Path, 'lstat', root_owned):
            consumer = self.consumer()
            self.assert_shared(self.spool / '.consumer.lock')
            consumer.close()
        self.assertEqual(stat.S_IMODE(self.spool.stat().st_mode), 0o2770)

    def test_foreign_owner_is_rejected(self):
        with self.assertRaises(ValueError):
            self.consumer(identity=(os.geteuid() + 1, {self.gid}))
        self.assertFalse((self.spool / '.consumer.lock').exists())

    def test_shared_directory_must_already_exist(self):
        self.spool.rmdir()
        with self.assertRaises(FileNotFoundError):
            self.consumer()
        self.assertFalse(self.spool.exists())

    def test_environment_selects_shared_mode_and_numeric_group(self):
        with patch.dict(os.environ, {'ORGANIZER_RETRY_SHARED':'1', 'ORGANIZER_RETRY_GID':str(self.gid)}):
            consumer = super().consumer()
        self.assertTrue(consumer.shared)
        self.assertEqual(consumer.gid, self.gid)
        self.assert_shared(self.spool / '.consumer.lock')

    def test_invalid_group_configuration_fails_closed(self):
        for gid in [None, '', 0, -1, True, 1.5, '1e3', ' 1000', '1000x', 0xffffffff]:
            with self.subTest(gid=gid), self.assertRaises(ValueError):
                self.consumer(gid=gid)
        self.assertFalse((self.spool / '.consumer.lock').exists())

    def test_wrong_directory_group_is_rejected(self):
        other = self.gid + 1
        with self.assertRaises(ValueError):
            self.consumer(gid=other, identity=(os.geteuid(), {other}))
        self.assertFalse((self.spool / '.consumer.lock').exists())

    def test_process_must_belong_to_the_configured_group(self):
        with self.assertRaises(ValueError):
            self.consumer(identity=(os.geteuid(), set()))
        self.assertFalse((self.spool / '.consumer.lock').exists())

    def test_world_access_and_missing_setgid_are_rejected_without_permission_repair(self):
        for mode in [0o770, 0o2777, 0o2775, 0o2700]:
            self.spool.chmod(mode)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.consumer()
            self.assertEqual(stat.S_IMODE(self.spool.stat().st_mode), mode)
        self.assertFalse((self.spool / '.consumer.lock').exists())

    def test_shared_directory_symlink_is_rejected(self):
        self.spool.rmdir()
        target = self.root / 'real-retries'
        target.mkdir()
        target.chmod(0o2770)
        self.spool.symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.consumer()
        self.assertEqual(list(target.iterdir()), [])

    def test_packet_permissions_must_be_exactly_group_private(self):
        _, file = self.request()
        consumer = self.consumer()
        for mode in [0o600, 0o640, 0o666]:
            file.chmod(mode)
            with self.subTest(mode=mode):
                self.assertEqual(consumer.poll(), [])
                self.assertTrue(file.exists())
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), mode)
        file.chmod(0o660)
        self.assertEqual(len(consumer.poll()), 1)

    def test_packet_group_must_match_before_claiming(self):
        _, file = self.request()
        consumer = self.consumer()
        original_fstat = os.fstat
        inode = file.stat().st_ino
        def wrong_group(fd):
            info = original_fstat(fd)
            return self.changed_stat(info, 'gid', self.gid + 1) if info.st_ino == inode else info
        with patch('organizer_retry_spool.os.fstat', side_effect=wrong_group):
            self.assertEqual(consumer.poll(), [])
        self.assertTrue(file.exists())
        self.assertEqual(len(consumer.poll()), 1)

    def test_fifo_packet_is_rejected_without_waiting_for_a_writer(self):
        _, file = self.request()
        file.unlink()
        os.mkfifo(file, 0o660)
        file.chmod(0o660)
        consumer = self.consumer()
        self.assertEqual(consumer.poll(), [])
        self.assertTrue(stat.S_ISFIFO(file.lstat().st_mode))

    def test_existing_lock_permissions_and_nonregular_lock_fail_closed(self):
        lock = self.spool / '.consumer.lock'
        lock.write_text('')
        lock.chmod(0o600)
        with self.assertRaises(ValueError):
            self.consumer()
        self.assertEqual(stat.S_IMODE(lock.stat().st_mode), 0o600)
        lock.unlink()
        os.mkfifo(lock, 0o660)
        lock.chmod(0o660)
        with self.assertRaises(ValueError):
            self.consumer()
        self.assertTrue(stat.S_ISFIFO(lock.lstat().st_mode))

    def test_directory_permission_change_disables_retries_until_corrected(self):
        _, file = self.request()
        consumer = self.consumer()
        self.spool.chmod(0o770)
        self.assertEqual(consumer.poll(), [])
        self.assertTrue(file.exists())
        self.spool.chmod(0o2770)
        self.assertEqual(len(consumer.poll()), 1)
        self.spool.chmod(0o2777)
        self.assertFalse(consumer.wants(self.book.name))
        consumer.complete(self.book.name)
        self.assertFalse((self.spool / (file.stem + '.done.json')).exists())

    def test_claim_permissions_are_checked_before_import_and_recovery(self):
        _, file = self.request()
        consumer = self.consumer()
        consumer.poll()
        claim = self.spool / (file.stem + '.claimed.json')
        claim.chmod(0o600)
        self.assertFalse(consumer.wants(self.book.name))
        self.assertEqual(consumer.poll(), [])
        consumer.close()
        recovered = self.consumer()
        self.assertEqual(recovered.poll(), [])
        self.assertTrue(claim.exists())
        self.assertFalse(file.exists())

    def test_malformed_shared_claim_does_not_interrupt_import_authorization_or_recovery(self):
        _, file = self.request()
        consumer = self.consumer()
        consumer.poll()
        claim = self.spool / (file.stem + '.claimed.json')
        claim.write_text('[]')
        self.assertFalse(consumer.wants(self.book.name))
        self.assertEqual(consumer.poll(), [])
        consumer.close()
        recovered = self.consumer()
        self.assertEqual(recovered.poll(), [])
        self.assertTrue(claim.exists())

    def test_invalid_receipt_permissions_do_not_replay_a_completed_claim(self):
        packet, file = self.request()
        consumer = self.consumer()
        consumer.poll()
        consumer.close()
        claim = self.spool / (file.stem + '.claimed.json')
        receipt = self.spool / (file.stem + '.done.json')
        receipt.write_text(json.dumps({**packet, 'status':'attempted', 'completedAt':self.now}))
        receipt.chmod(0o600)
        recovered = self.consumer()
        self.assertEqual(recovered.poll(), [])
        self.assertTrue(claim.exists())
        self.assertFalse(file.exists())
        recovered.close()
        receipt.chmod(0o660)
        accepted = self.consumer()
        self.assertEqual(accepted.poll(), [])
        self.assertFalse(claim.exists())


@unittest.skipUnless(os.environ.get('ORGANIZER_RETRY_TEST_SOURCE'), 'Set the staged organizer source for integration checks')
class PatchedImportTest(SpoolFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        selected = {'_consume_targeted_retries', '_targeted_retry_item', '_complete_targeted_retry',
                    'process_movies_list', 'process_tv_shows_list'}
        tree = ast.parse(Path(os.environ['ORGANIZER_RETRY_TEST_SOURCE']).read_text())
        module = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in selected], type_ignores=[])
        self.moves, self.queries = [], []
        consumer = self.consumer()
        self.scope = {'Path':Path, '_retry_queue':consumer, 'log':logging.getLogger('retry-integration'),
                      '_watch_skip_logged':set(), '_omdb_no_match_cache':{},
                      'parse_filename':lambda name: (name, '2020'),
                      'infer_missing_movie_year':lambda movie, title, year: year,
                      'check_if_actually_series':lambda title, year: None,
                      'query_omdb':lambda title, year: self.query(title, year),
                      'move_movie':lambda movie, info, dry_run=False: self.move(movie),
                      'query_omdb_series':lambda title, year: self.query(title, year),
                      'move_tv_show':lambda show, info, dry_run=False: self.move(show)}
        exec(compile(module, '<staged-organizer-functions>', 'exec'), self.scope)

    def query(self, title, year):
        self.queries.append((title, year))
        return {'title':title, 'year':year}

    def move(self, item):
        self.moves.append(item['path'].name)
        return True

    def test_retry_only_selected_release_preserves_other_skip_flags_and_cache_entries(self):
        other = self.source / 'Iron Man [720p]'
        other.mkdir()
        packet, _ = self.request()
        self.scope['_watch_skip_logged'].update([self.book.name, other.name])
        self.scope['_omdb_no_match_cache'].update({('iron man', None):1, ('other title', None):2, ('series:iron man', None):3})
        result = self.scope['process_movies_list']([{'path':other, 'parse_name':other.name}, {'path':self.book, 'parse_name':self.book.name}])
        self.assertEqual(result, (1, 1))
        self.assertEqual(self.moves, [self.book.name])
        self.assertIn(other.name, self.scope['_watch_skip_logged'])
        self.assertNotIn(('iron man', None), self.scope['_omdb_no_match_cache'])
        self.assertIn(('series:iron man', None), self.scope['_omdb_no_match_cache'])
        self.assertIn(('other title', None), self.scope['_omdb_no_match_cache'])
        self.assertEqual(self.receipt(packet)['status'], 'attempted')

    def test_request_during_copy_is_consumed_at_next_import_boundary(self):
        first = self.source / 'Copying now'
        first.mkdir()
        self.scope['_watch_skip_logged'].add(self.book.name)
        def move(item, info, dry_run=False):
            if item['path'] == first:
                self.assertFalse(self.scope['_retry_queue'].wants(self.book.name))
                self.request()
                self.assertFalse(self.scope['_retry_queue'].wants(self.book.name))
            return self.move(item)
        self.scope['move_movie'] = move
        result = self.scope['process_movies_list']([{'path':first, 'parse_name':first.name}, {'path':self.book, 'parse_name':self.book.name}])
        self.assertEqual(result, (2, 0))
        self.assertEqual(self.moves, [first.name, self.book.name])

    def test_folder_and_loose_file_sharing_parse_name_do_not_both_retry(self):
        loose = self.source / (self.book.name + '.mkv')
        loose.write_text('video fixture retained')
        self.request()
        self.scope['_watch_skip_logged'].add(self.book.name)
        result = self.scope['process_movies_list']([{'path':loose, 'parse_name':self.book.name}, {'path':self.book, 'parse_name':self.book.name}])
        self.assertEqual(result, (1, 1))
        self.assertEqual(self.moves, [self.book.name])
        self.assertTrue(loose.exists())

    def test_dry_run_never_claims_or_acknowledges_retry_requests(self):
        _, file = self.request()
        self.scope['_watch_skip_logged'].add(self.book.name)
        self.scope['process_movies_list']([{'path':self.book, 'parse_name':self.book.name}], dry_run=True)
        self.assertTrue(file.exists())
        self.assertEqual(self.moves, [])

    def test_runtime_spool_loss_does_not_stop_a_normal_import(self):
        shutil.rmtree(self.spool)
        result = self.scope['process_movies_list']([{'path':self.book, 'parse_name':self.book.name}])
        self.assertEqual(result, (1, 0))
        self.assertEqual(self.moves, [self.book.name])


if __name__ == '__main__':
    unittest.main()
