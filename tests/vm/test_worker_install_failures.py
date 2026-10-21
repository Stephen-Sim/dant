"""Installer failure boundaries with private files and fake process/HTTP ownership."""

import contextlib
import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

import test_worker_install as fixtures

installer = fixtures.installer


class WorkerInstallFailureTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.WorkerInstallFixture()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)

    def rejected(self, code):
        return self.assertRaisesRegex(installer.InstallError, '^' + code + '$')

    def test_relative_and_non_directory_roots_never_create_or_modify_data(self):
        with self.rejected('path-invalid'):
            installer.ordinary_directory(pathlib.Path('relative'))
        with self.rejected('path-invalid'):
            installer.ordinary_directory(self.f.state)
        self.assertEqual(self.f.state.read_bytes(), self.f.original)

    def test_opened_file_identity_and_growth_are_not_accepted_as_original_bytes(self):
        info = self.f.state.stat()
        changed = types.SimpleNamespace(**{name: getattr(info, name) for name in
            ('st_dev', 'st_ino', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')})
        changed.st_ino += 1
        with patch.object(installer.os, 'fstat', return_value=changed), self.rejected('file-changed'):
            installer.read_regular(self.f.state, 4096)
        original_reader = installer.regular_file

        @contextlib.contextmanager
        def growing(path, limit):
            with original_reader(path, limit) as stream:
                with path.open('ab') as output:
                    output.write(b'x')
                yield stream

        with patch.object(installer, 'regular_file', growing), self.rejected('file-invalid'):
            installer.read_regular(self.f.state, len(self.f.original))

    def test_json_requires_an_object_and_rejects_nonfinite_values(self):
        for raw in (b'[]', b'null', b'NaN', b'{"limit":Infinity}'):
            with self.subTest(raw=raw), self.rejected('manifest-invalid'):
                installer.json_object(raw)

    def test_manifest_layout_entry_shape_total_and_public_environment_fail_closed(self):
        original = json.loads(json.dumps(self.f.manifest))
        cases = [dict(original, schemaVersion=True), dict(original, sourceCommit='invalid'),
            dict(original, files=[None]), dict(original, files=[dict(original['files'][0], bytes=True)])]
        for value in cases:
            self.f.manifest = value
            self.f.write_manifests()
            with self.rejected('manifest-invalid'):
                installer.verify_bundle(self.f.source, self.f.home)
        self.f.manifest = original
        self.f.write_manifests()
        with patch.object(installer, 'BUNDLE_LIMIT', 1), self.rejected('manifest-invalid'):
            installer.verify_bundle(self.f.source, self.f.home)
        deployment = self.f.source / 'deploy-manifest.json'
        for environment in ([], {'DANT_GUEST_HOST': 'localhost'},
                            {'DANT_GUEST_HOST': 'localhost', 'DANT_GUEST_PORT': '0'}):
            deployment.write_bytes(json.dumps(dict(self.f.deployment, publicEnvironment=environment)).encode())
            with self.rejected('network-invalid'):
                installer.verify_bundle(self.f.source, self.f.home)
        self.assertEqual(self.f.calls, [])

    def test_foreign_source_and_changed_operator_cannot_authorize_reconciliation(self):
        with self.rejected('source-invalid'):
            installer.verify_bundle(self.f.home / 'dant', self.f.home)
        script = self.f.source / 'vm/worker-install.py'
        with patch.object(installer, '__file__', str(self.f.source / 'vm/foreign.py')):
            with self.rejected('source-invalid'):
                installer.verify_reconciliation_operator(self.f.configuration)
        actual_reader = installer.read_regular

        def changed_reader(path, limit):
            raw = actual_reader(path, limit)
            return raw + b'changed' if pathlib.Path(path) == script else raw

        with patch.object(installer, '__file__', str(script)), patch.object(installer, 'verify_bundle', return_value=self.f.configuration):
            with patch.object(installer, 'read_regular', side_effect=changed_reader), self.rejected('bundle-changed'):
                installer.verify_reconciliation_operator(self.f.configuration)

    def test_failed_atomic_replace_keeps_original_and_removes_only_owned_temporary(self):
        with patch.object(installer.os, 'replace', side_effect=OSError('PRIVATE failure')):
            with self.assertRaises(OSError):
                installer.atomic_write(self.f.state, b'new')
        self.assertEqual(self.f.state.read_bytes(), self.f.original)
        self.assertFalse(list(self.f.state.parent.glob('.state.json.*.tmp')))

    def test_directory_sync_is_joined_and_closes_descriptor_even_when_flush_fails(self):
        with patch.object(installer.os, 'name', 'posix'), patch.object(installer.os, 'O_DIRECTORY', 0, create=True):
            with patch.object(installer.os, 'open', return_value=123) as opened, \
                    patch.object(installer.os, 'fsync', side_effect=OSError('PRIVATE flush')), \
                    patch.object(installer.os, 'close') as closed:
                with self.assertRaises(OSError):
                    installer.sync_directory(self.f.home)
                opened.assert_called_once()
                closed.assert_called_once_with(123)

    def test_process_failures_are_generic_never_retried_and_do_not_copy_output(self):
        failures = [OSError('PRIVATE'), subprocess.TimeoutExpired('PRIVATE', 1),
                    types.SimpleNamespace(returncode=7)]
        for result in failures:
            kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
            with patch.object(installer.subprocess, 'run', **kwargs) as run, self.rejected('process-unconfirmed'):
                installer.run_quiet(['synthetic-only'], environment={'FIXTURE': 'yes'})
            self.assertEqual(run.call_count, 1)
        output = io.BytesIO()
        with patch.object(installer.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
            installer.run_quiet(['synthetic-only'], environment={'FIXTURE': 'yes'}, output=output)
            self.assertIs(run.call_args.kwargs['stdout'], output)

    def test_backup_footprint_rejects_timeout_nonzero_oversized_and_invalid_output(self):
        cases = [OSError('PRIVATE'), subprocess.TimeoutExpired('PRIVATE', 1),
            types.SimpleNamespace(returncode=1, stdout=b''),
            types.SimpleNamespace(returncode=0, stdout=b'x' * (installer.PREFLIGHT_LIMIT + 1)),
            types.SimpleNamespace(returncode=0, stdout=b'not json')]
        for result in cases:
            kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
            with patch.object(installer.subprocess, 'run', **kwargs) as run, self.rejected('space-unconfirmed'):
                installer.backup_footprint(self.f.configuration, {})
            self.assertEqual(run.call_count, 1)
        operator = dict(self.f.configuration, operatorSource=self.f.source, operatorDigest='f' * 64)
        with patch.object(installer.subprocess, 'run') as run, self.rejected('bundle-changed'):
            installer.backup_footprint(operator, {})
        run.assert_not_called()

    def test_filesystem_space_never_guesses_missing_capacity_or_changed_directory(self):
        for failure in (AttributeError('PRIVATE'), OSError('PRIVATE')):
            with patch.object(installer.os, 'statvfs', side_effect=failure, create=True), self.rejected('space-unconfirmed'):
                installer.filesystem_space(self.f.home)
        valid = types.SimpleNamespace(f_bavail=100, f_frsize=4096)
        with patch.object(installer.os, 'statvfs', return_value=valid, create=True):
            self.assertEqual(installer.filesystem_space(self.f.home), (self.f.home.stat().st_dev, 409600))
        for value in (types.SimpleNamespace(f_bavail=-1, f_frsize=4096),
                      types.SimpleNamespace(f_bavail=100, f_frsize=0)):
            with patch.object(installer.os, 'statvfs', return_value=value, create=True), self.rejected('space-unconfirmed'):
                installer.filesystem_space(self.f.home)

    def test_service_snapshot_rejects_unknown_duplicate_inconsistent_and_oversized_fields(self):
        valid = b'LoadState=loaded\nActiveState=inactive\nMainPID=0\nControlGroup=\n'
        invalid = [valid + b'Unknown=x\n', valid + b'MainPID=0\n', b'LoadState=loaded\n',
            valid.replace(b'inactive', b'activating'), valid.replace(b'MainPID=0', b'MainPID=42'),
            valid.replace(b'MainPID=0', b'MainPID=01'), b'x' * (installer.SERVICE_LIMIT + 1)]
        for raw in invalid:
            with patch.object(installer.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=raw)):
                with self.rejected('shutdown-unconfirmed'):
                    installer.service_state()
        for failure in (OSError('PRIVATE'), subprocess.TimeoutExpired('PRIVATE', 1)):
            with patch.object(installer.subprocess, 'run', side_effect=failure), self.rejected('shutdown-unconfirmed'):
                installer.service_state()
        with patch.object(installer.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=valid)) as run:
            self.assertEqual(installer.service_state()['ActiveState'], 'inactive')
            self.assertEqual(run.call_args.args[0][0], 'systemctl')
        self.assertEqual(self.f.calls, [])

    def test_stopped_process_scan_has_bounded_cmdline_environment_and_permissions(self):
        proc = self.f.home / 'synthetic-proc'
        child = proc / '123'
        child.mkdir(parents=True)
        (proc / 'not-a-pid').mkdir()
        (child / 'cmdline').write_bytes(b'codex\0')
        (child / 'environ').write_bytes(b'')
        state = dict(LoadState='loaded', ActiveState='inactive', MainPID='0', ControlGroup='')
        with patch.object(installer.os, 'getuid', return_value=child.stat().st_uid, create=True):
            (child / 'cmdline').write_bytes(b'x' * (32 * 1024 + 1))
            with self.rejected('shutdown-unconfirmed'):
                installer.assert_stopped(self.f.home, state, proc)
            (child / 'cmdline').write_bytes(b'codex\0')
            (child / 'environ').write_bytes(b'x' * (128 * 1024 + 1))
            with self.rejected('shutdown-unconfirmed'):
                installer.assert_stopped(self.f.home, state, proc)
            original_open = pathlib.Path.open

            def denied(path, *args, **kwargs):
                if path == child / 'cmdline':
                    raise PermissionError('PRIVATE metadata')
                return original_open(path, *args, **kwargs)

            with patch.object(pathlib.Path, 'open', denied), self.rejected('shutdown-unconfirmed'):
                installer.assert_stopped(self.f.home, state, proc)
            (child / 'environ').write_bytes(b'')
            with patch.object(installer.os, 'getpid', return_value=123):
                installer.assert_stopped(self.f.home, state, proc)
        with patch.object(installer.os, 'getuid', return_value=1 + child.stat().st_uid, create=True):
            installer.assert_stopped(self.f.home, state, proc)

    def test_cgroup_missing_is_stopped_but_traversal_and_surviving_members_are_not(self):
        proc = self.f.home / 'empty-proc'
        proc.mkdir()
        group = self.f.home / 'cgroup'
        group.mkdir()
        state = dict(LoadState='loaded', ActiveState='inactive', MainPID='0', ControlGroup='/user/dant-worker.service')
        installer.assert_stopped(self.f.home, state, proc, group)
        for name in ('relative/dant-worker.service', '/user/../dant-worker.service', '/other.service'):
            with self.rejected('shutdown-unconfirmed'):
                installer.assert_stopped(self.f.home, dict(state, ControlGroup=name), proc, group)

    def test_maintenance_errors_do_not_release_or_replay_an_unknown_reservation(self):
        class Opener:
            def __init__(self, raw):
                self.raw = raw
                self.calls = []

            def open(self, request, **kwargs):
                self.calls.append(request)
                return io.BytesIO(self.raw)

        for raw in (b'x' * (installer.MANIFEST_LIMIT + 1), b'{"id":"invalid"}'):
            opener = Opener(raw)
            with self.rejected('maintenance-unconfirmed'):
                installer.maintenance_request(opener, 'http://127.0.0.1:4317', 'synthetic', 'GET')
            self.assertEqual(len(opener.calls), 1)
        for failure in (fixtures.urllib.error.HTTPError('http://127.0.0.1', 503, 'PRIVATE', {}, None), None):
            outcomes = [failure] if failure is not None else [None, None]
            with patch.object(installer, 'local_opener'), patch.object(installer, 'local_session', return_value='synthetic'), \
                    patch.object(installer, 'maintenance_request', side_effect=outcomes) as request:
                with self.rejected('maintenance-unconfirmed'):
                    installer.reserve_maintenance(self.f.configuration)
                self.assertEqual([call.args[-1] for call in request.call_args_list],
                                 ['GET'] if failure is not None else ['GET', 'POST'])

    def test_local_http_opener_disables_proxies_and_redirects_without_sending_requests(self):
        opener = installer.local_opener()
        handlers = opener.handlers
        redirect = next(item for item in handlers if isinstance(item, installer.urllib.request.HTTPRedirectHandler))
        self.assertIsNone(redirect.redirect_request(None, None, None, None, None, 'http://example.invalid'))
        self.assertFalse(any(isinstance(item, installer.urllib.request.ProxyHandler) and item.proxies for item in handlers))

    def test_linger_requires_confirmed_yes_and_never_retries_login_commands(self):
        with patch.dict(sys.modules, pwd=types.SimpleNamespace(getpwuid=lambda _: types.SimpleNamespace(pw_name='synthetic'))):
            with patch.object(installer.os, 'getuid', return_value=123, create=True):
                self.assertEqual(installer.unix_username(), 'synthetic')
        for result in (types.SimpleNamespace(returncode=0, stdout=b'no'),
                       types.SimpleNamespace(returncode=7, stdout=b'yes'), OSError('PRIVATE')):
            kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
            with patch.object(installer, 'unix_username', return_value='synthetic'), \
                    patch.object(installer, 'run_quiet') as quiet, patch.object(installer.subprocess, 'run', **kwargs):
                with self.rejected('linger-unconfirmed'):
                    installer.ensure_linger()
                quiet.assert_called_once_with(['loginctl', 'enable-linger', 'synthetic'])
        with patch.object(installer, 'unix_username', return_value='synthetic'), patch.object(installer, 'run_quiet'), \
                patch.object(installer.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=b'yes\n')):
            installer.ensure_linger()

    def test_outer_activation_owns_lock_before_dispatch_and_busy_lock_never_starts(self):
        fake = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
        with patch.dict(sys.modules, fcntl=fake), patch.object(installer.os, 'O_NOFOLLOW', 0, create=True):
            with patch.object(installer, '_activate_locked') as activate:
                installer.activate(self.f.configuration)
                activate.assert_called_once_with(self.f.configuration, False, self.f.service_directory, None)
            fake.flock = lambda *_: (_ for _ in ()).throw(BlockingIOError('PRIVATE'))
            with patch.object(installer, '_activate_locked') as activate, self.rejected('install-busy'):
                installer.activate(self.f.configuration)
            activate.assert_not_called()
            lock = self.f.home / 'dant/.worker-install.lock'
            os.link(lock, self.f.home / 'foreign-lock-link')
            with patch.object(installer, '_activate_locked') as activate, self.rejected('install-busy'):
                installer.activate(self.f.configuration)
            activate.assert_not_called()

    def test_legacy_committed_receipt_is_valid_but_partial_modern_proof_is_not(self):
        receipt = dict(schemaVersion=1, source='a' * 64, phase='committed',
                       backup='12345678-1234-1234-1234-123456789abc.raw')
        installer.validate_previous_attempt(receipt)
        with self.rejected('previous-install-unconfirmed'):
            installer.validate_previous_attempt(dict(receipt, attemptId='12345678-1234-1234-1234-123456789abc'))

    def test_preserved_journal_evidence_is_idempotent_and_cannot_be_overwritten(self):
        directory = self.f.home / 'evidence'
        directory.mkdir()
        with patch.object(installer, 'sync_directory'):
            installer.preserve_evidence(directory, 'original.json', b'original')
            installer.preserve_evidence(directory, 'original.json', b'original')
            with self.rejected('reconciliation-unconfirmed'):
                installer.preserve_evidence(directory, 'original.json', b'changed')
        self.assertEqual((directory / 'original.json').read_bytes(), b'original')

    def test_empty_backup_preserves_unknown_attempt_and_never_starts_worker(self):
        def empty_backup(arguments, **kwargs):
            if '--role=backup-cli' not in arguments:
                self.f.quiet(arguments, **kwargs)
        with self.f.isolated_activation(quiet=empty_backup), self.rejected('backup-unconfirmed'):
            self.f.activate()
        self.assertFalse(any('--role=prepare-worker' in call for call in self.f.calls))
        self.assertFalse(any(call[:3] == ['systemctl', '--user', 'start'] for call in self.f.calls))
        journal = json.loads((self.f.home / 'dant/install-attempt.json').read_bytes())
        self.assertEqual(journal['phase'], 'stopping')

    def test_existing_nonlink_app_directory_is_preserved_and_cannot_be_activated(self):
        app = self.f.home / 'dant/app'
        app.mkdir()
        evidence = app / 'private-fixture.txt'
        evidence.write_bytes(b'preserve original directory')
        with self.f.isolated_activation(), self.rejected('app-path-invalid'):
            self.f.activate()
        self.assertEqual(evidence.read_bytes(), b'preserve original directory')
        self.assertFalse(any(call[:3] == ['systemctl', '--user', 'start'] for call in self.f.calls))

    def test_reconciliation_without_original_journal_never_dispatches_any_command(self):
        request = {'attemptId': '12345678-1234-1234-1234-123456789abc', 'journalSha256': 'a' * 64}
        with self.f.isolated_activation(), self.rejected('reconciliation-unconfirmed'):
            self.f.activate(reconciliation=request)
        self.assertEqual(self.f.calls, [])
        self.assertEqual(self.f.state.read_bytes(), self.f.original)

    def test_cli_dispatch_validates_arguments_before_any_process_or_live_call(self):
        with patch.object(installer, 'activate') as activate, patch.object(installer, 'ready') as ready:
            for arguments in ([], ['unknown'], ['verify', str(self.f.source), str(self.f.home), '--bad']):
                with self.rejected('arguments-invalid'):
                    installer.main(arguments)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                installer.main(['verify', str(self.f.source), str(self.f.home)])
            self.assertIn(self.f.configuration['digest'], output.getvalue())
            ready.return_value = False
            with self.rejected('readiness-unconfirmed'):
                installer.main(['current', str(self.f.source), str(self.f.home)])
            ready.return_value = True
            installer.main(['current', str(self.f.source), str(self.f.home)])
            with patch.object(installer.sys, 'platform', 'unsupported-fixture'), self.rejected('vm-user-required'):
                installer.main(['activate', str(self.f.source), str(self.f.home)])
            activate.assert_not_called()

    def test_linux_cli_dispatch_passes_exact_reconciliation_identity_to_one_owner(self):
        attempt = '12345678-1234-1234-1234-123456789abc'
        digest = 'b' * 64
        path_type = type(self.f.home)
        with patch.object(installer, 'verify_bundle', return_value=self.f.configuration), \
                patch.object(installer, 'verify_reconciliation_operator', return_value=self.f.configuration), \
                patch.object(installer, 'pathlib', types.SimpleNamespace(Path=path_type)), \
                patch.object(installer.os, 'name', 'posix'), patch.object(installer.os, 'getuid', return_value=123, create=True), \
                patch.object(installer.sys, 'platform', 'linux'), patch.object(installer, 'activate') as activate:
            installer.main(['activate', 'synthetic-source', 'synthetic-home', '--update-running-work'])
            activate.assert_called_once_with(self.f.configuration, True, None)
            activate.reset_mock()
            installer.main(['reconcile-stopped', 'synthetic-source', 'synthetic-home',
                            '--attempt-id', attempt, '--journal-sha256', digest])
            activate.assert_called_once_with(self.f.configuration, False,
                {'attemptId': attempt, 'journalSha256': digest})
        self.assertEqual(self.f.calls, [])

    def test_program_error_exit_has_a_fixed_code_and_never_echoes_private_arguments(self):
        output = io.StringIO()
        with patch.object(sys, 'argv', ['worker-install.py', 'PRIVATE-invalid-operation']), \
                contextlib.redirect_stderr(output), self.assertRaises(SystemExit) as exit_result:
            runpy.run_path(str(fixtures.ROOT / 'vm/worker-install.py'), run_name='__main__')
        self.assertEqual(exit_result.exception.code, 1)
        self.assertIn('DANT_UPDATE_FAILED:arguments-invalid:cutover', output.getvalue())
        self.assertNotIn('PRIVATE', output.getvalue())
        self.assertEqual(self.f.calls, [])


if __name__ == '__main__':
    unittest.main()
