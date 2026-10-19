"""Go cutover fixtures. Never contact a service, VM, model, or package registry."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import types
import urllib.error
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('worker_install', ROOT / 'vm/worker-install.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class WorkerInstallFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = pathlib.Path(self.temporary.name) / 'home'
        self.source = self.home / 'dant/releases/source.fixture'
        self.source.mkdir(parents=True)
        entries = []
        for name in sorted(installer.ALLOWLIST):
            data = ('isolated resource ' + name).encode()
            if name == 'src/config/protocol.json':
                data = json.dumps({'apiPort': 4317, 'loopbackHosts': ['127.0.0.1', 'localhost']}).encode()
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            entries.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        self.manifest = {'schemaVersion': 1, 'version': '0.4.7-beta.12',
                         'sourceCommit': 'a' * 40, 'files': entries}
        self.write_manifests()
        for name in ('data', 'workspaces', 'bin', 'vm', 'installation-backups'):
            (self.home / 'dant' / name).mkdir()
        self.service_directory = self.home / '.config/systemd/user'
        self.service_directory.mkdir(parents=True)
        self.state = self.home / 'dant/data/state.json'
        self.state.write_bytes(b'{"conversationId":"fixture","messages":[]}')
        self.original = self.state.read_bytes()
        self.calls = []
        self.stopped_checks = 0
        self.configuration = installer.verify_bundle(self.source, self.home)

    def write_manifests(self):
        raw = json.dumps(self.manifest, separators=(',', ':'), ensure_ascii=False).encode()
        (self.source / installer.BUNDLE_MANIFEST).write_bytes(raw)
        self.digest = hashlib.sha256(raw).hexdigest()
        self.deployment = {'schemaVersion': 2, 'sha256': self.digest,
                           'publicEnvironment': {'DANT_GUEST_HOST': 'localhost', 'DANT_GUEST_PORT': '5540'}}
        (self.source / 'deploy-manifest.json').write_text(json.dumps(self.deployment), encoding='utf-8')

    def quiet(self, arguments, timeout=installer.SERVICE_TIMEOUT, environment=None, output=None):
        self.calls.append(arguments)
        if '--role=backup-cli' in arguments:
            self.assertEqual(arguments[2], 'export')
            self.assertIsNotNone(output)
            output.write(b'DANT-BACKUP/1\nvalidated fixture archive\n')
        if '--role=prepare-worker' in arguments:
            backup = pathlib.Path(next(value[len('--backup='):] for value in arguments if value.startswith('--backup=')))
            self.assertTrue(backup.read_bytes().startswith(b'DANT-BACKUP/1\n'))
            attempt = json.loads((self.home / 'dant/install-attempt.json').read_bytes())
            proof = {key: attempt[key] for key in (
                'schemaVersion', 'attemptId', 'source', 'sourceCommit', 'version', 'directory',
                'backup', 'backupBytes', 'backupModifiedNS', 'backupIdentity')}
            proof.update({
                'dataDir': str(self.home / 'dant/data'),
                'workspaceRoot': str(self.home / 'dant/workspaces'),
                'backupSha256': hashlib.sha256(backup.read_bytes()).hexdigest(),
            })
            (self.home / 'dant' / installer.PREPARATION_FILE).write_bytes(json.dumps(proof).encode())

    def assert_stopped(self, home):
        self.assertEqual(home, self.home)
        self.stopped_checks += 1

    @contextlib.contextmanager
    def isolated_activation(self, quiet=None, ready=True):
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(installer, 'run_quiet', side_effect=quiet or self.quiet))
            stack.enter_context(patch.object(installer, 'service_state', return_value={
                'LoadState': 'loaded', 'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': ''}))
            stack.enter_context(patch.object(installer, 'assert_stopped', side_effect=self.assert_stopped))
            stack.enter_context(patch.object(installer, 'ready', return_value=ready))
            stack.enter_context(patch.object(installer, 'reserve_maintenance', return_value=None))
            stack.enter_context(patch.object(installer, 'unix_username', return_value='fixture'))
            stack.enter_context(patch.object(installer, 'ensure_linger'))
            stack.enter_context(patch.object(installer.os, 'symlink', side_effect=lambda source, target, **_: pathlib.Path(target).write_text(str(source))))
            stack.enter_context(patch.object(installer.time, 'sleep'))
            yield

    def activate(self, manual=False):
        with contextlib.redirect_stdout(io.StringIO()):
            installer._activate_locked(self.configuration, manual, self.service_directory)

    def test_valid_bundle_has_exact_provenance_and_public_network(self):
        self.assertEqual(self.configuration['digest'], self.digest)
        self.assertEqual(self.configuration['guestHost'], 'localhost')
        self.assertEqual(self.configuration['guestPort'], 5540)
        self.assertEqual(self.configuration['port'], 4317)

    def test_installation_phase_constants_match_shared_contract(self):
        domains = json.loads((ROOT / 'src/contracts/state-domains.json').read_bytes())['domains']
        self.assertEqual(domains['WorkerInstallationPhase'], {
            'Reserving': installer.PHASE_RESERVING,
            'Stopping': installer.PHASE_STOPPING,
            'Preparing': installer.PHASE_PREPARING,
            'Activating': installer.PHASE_ACTIVATING,
            'Committed': installer.PHASE_COMMITTED,
        })

    def test_cross_api_ctime_difference_does_not_mask_same_api_changes(self):
        actual_fstat = os.fstat
        reads = []

        def different_ctime(descriptor):
            current = actual_fstat(descriptor)
            values = {name: getattr(current, name) for name in (
                'st_dev', 'st_ino', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
            reads.append(descriptor)
            values['st_ctime_ns'] += 1000
            return types.SimpleNamespace(**values)

        with patch.object(installer.os, 'fstat', side_effect=different_ctime):
            self.assertEqual(installer.read_regular(self.state, 4096), self.original)
        self.assertGreaterEqual(len(reads), 2)

        reads.clear()

        def changed_ctime(descriptor):
            result = different_ctime(descriptor)
            result.st_ctime_ns += len(reads)
            return result

        with patch.object(installer.os, 'fstat', side_effect=changed_ctime):
            with self.assertRaisesRegex(installer.InstallError, 'file-changed'):
                installer.read_regular(self.state, 4096)

        with self.assertRaisesRegex(installer.InstallError, 'file-changed'):
            with installer.regular_file(self.state, 4096):
                before = self.state.stat()
                os.utime(self.state, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000_000))

    def test_modified_binary_rejected_before_any_service_action(self):
        (self.source / installer.BINARY).write_bytes(b'changed resource')
        with self.assertRaises(installer.InstallError):
            installer.verify_bundle(self.source, self.home)
        self.assertEqual(self.calls, [])

    def test_unknown_duplicate_manifest_and_public_environment_rejected(self):
        for mutation in ('unknown', 'duplicate', 'network', 'source', 'bool-size'):
            with self.subTest(mutation=mutation):
                original = json.loads(json.dumps(self.manifest))
                if mutation == 'unknown':
                    self.manifest['files'][0]['path'] = '.env'
                elif mutation == 'duplicate':
                    self.manifest['files'].append(self.manifest['files'][0])
                elif mutation == 'source':
                    self.manifest['sourceCommit'] = 'not-a-source'
                elif mutation == 'bool-size':
                    self.manifest['files'][0]['bytes'] = True
                self.write_manifests()
                if mutation == 'network':
                    self.deployment['publicEnvironment']['DANT_GUEST_HOST'] = 'remote.example'
                    (self.source / 'deploy-manifest.json').write_text(json.dumps(self.deployment), encoding='utf-8')
                with self.assertRaises(installer.InstallError):
                    installer.verify_bundle(self.source, self.home)
                self.manifest = original
                self.write_manifests()

    def test_duplicate_json_keys_and_hardlinks_rejected(self):
        with self.assertRaises(installer.InstallError):
            installer.json_object(b'{"schemaVersion":1,"schemaVersion":1}')
        link = self.source / 'linked-binary'
        os.link(self.source / installer.BINARY, link)
        with self.assertRaises(installer.InstallError):
            installer.verify_bundle(self.source, self.home)

    def test_cutover_orders_stop_backup_prepare_go_start_and_commit(self):
        with self.isolated_activation():
            self.activate(manual=True)
        flattened = [' '.join(call) for call in self.calls]
        guard = next(index for index, call in enumerate(flattened) if '--guard-only' in call)
        stop = next(index for index, call in enumerate(flattened) if '--user stop dant-worker.service' in call)
        backup = next(index for index, call in enumerate(flattened) if '--role=backup-cli export' in call)
        prepare = next(index for index, call in enumerate(flattened) if '--role=prepare-worker' in call)
        start = next(index for index, call in enumerate(flattened) if '--user start dant-worker.service' in call)
        self.assertLess(guard, stop)
        self.assertLess(stop, backup)
        self.assertLess(backup, prepare)
        self.assertLess(prepare, start)
        self.assertIn('--update-running-work', flattened[guard])
        self.assertGreaterEqual(self.stopped_checks, 3)
        self.assertEqual(self.state.read_bytes(), self.original)
        self.assertEqual((self.home / 'dant/deployed-source.json').read_bytes(), (self.source / 'deploy-manifest.json').read_bytes())
        attempt = json.loads((self.home / 'dant/install-attempt.json').read_bytes())
        self.assertEqual(attempt['phase'], 'committed')
        proof_raw = (self.home / 'dant' / installer.PREPARATION_FILE).read_bytes()
        proof = json.loads(proof_raw)
        self.assertEqual(attempt['preparationSha256'], hashlib.sha256(proof_raw).hexdigest())
        self.assertEqual(attempt['attemptId'], proof['attemptId'])
        self.assertEqual(attempt['backupSha256'], proof['backupSha256'])
        self.assertEqual(attempt['sourceCommit'], self.configuration['commit'])
        service = (self.service_directory / 'dant-worker.service').read_text()
        self.assertIn('ExecStart=%h/dant/bin/dant-core --role=worker', service)
        self.assertNotIn('node', service.lower())
        self.assertNotIn('src/server.mts', service)
        self.assertTrue(all('node' not in call and 'npm' not in call for call in self.calls))

    def test_missing_foreign_or_changed_preparation_proof_cannot_start_worker(self):
        for variant in ('missing', 'other-attempt', 'wrong-root', 'changed-backup', 'unknown-field'):
            with self.subTest(variant=variant):
                self.calls.clear()
                (self.home / 'dant/install-attempt.json').unlink(missing_ok=True)

                def invalidate(arguments, **kwargs):
                    self.quiet(arguments, **kwargs)
                    if '--role=prepare-worker' not in arguments:
                        return
                    path = self.home / 'dant' / installer.PREPARATION_FILE
                    proof = json.loads(path.read_bytes())
                    if variant == 'missing':
                        path.unlink()
                        return
                    if variant == 'other-attempt':
                        proof['attemptId'] = '00000000-0000-0000-0000-000000000000'
                    elif variant == 'wrong-root':
                        proof['dataDir'] += '-other'
                    elif variant == 'unknown-field':
                        proof['unverified'] = True
                    elif variant == 'changed-backup':
                        backup = self.home / 'dant/installation-backups' / proof['backup']
                        backup.write_bytes(backup.read_bytes() + b'changed')
                    path.write_bytes(json.dumps(proof).encode())

                with self.isolated_activation(quiet=invalidate):
                    with self.assertRaises((installer.InstallError, FileNotFoundError)):
                        self.activate()
                self.assertFalse(any(call[1:4] == ['--user', 'start', 'dant-worker.service'] for call in self.calls))
                self.assertEqual(json.loads((self.home / 'dant/install-attempt.json').read_bytes())['phase'], installer.PHASE_PREPARING)

    def test_failed_stop_backup_prepare_or_start_never_restarts_node_or_replays(self):
        for phase in ('stop', 'backup', 'prepare', 'start'):
            with self.subTest(phase=phase):
                self.calls.clear()
                (self.home / 'dant/install-attempt.json').unlink(missing_ok=True)
                (self.home / 'dant/app').unlink(missing_ok=True)
                def failure(arguments, **kwargs):
                    self.quiet(arguments, **kwargs)
                    matches = (
                        phase == 'stop' and arguments[1:4] == ['--user', 'stop', 'dant-worker.service'] or
                        phase == 'backup' and '--role=backup-cli' in arguments or
                        phase == 'prepare' and '--role=prepare-worker' in arguments or
                        phase == 'start' and arguments[1:4] == ['--user', 'start', 'dant-worker.service'])
                    if matches:
                        installer.reject('fixture-unconfirmed')
                with self.isolated_activation(quiet=failure):
                    with self.assertRaises(installer.InstallError):
                        self.activate()
                    before_retry = len(self.calls)
                    with self.assertRaisesRegex(installer.InstallError, 'previous-install-unconfirmed'):
                        self.activate()
                    self.assertEqual(len(self.calls), before_retry)
                self.assertEqual(self.state.read_bytes(), self.original)
                self.assertFalse((self.home / 'dant/deployed-source.json').exists())
                self.assertTrue(all('node' not in call and 'npm' not in call for call in self.calls))

    def test_readiness_timeout_keeps_unknown_attempt_and_does_not_stop_new_work(self):
        with self.isolated_activation(ready=False):
            with self.assertRaisesRegex(installer.InstallError, 'readiness-unconfirmed'):
                self.activate()
        stops = [call for call in self.calls if call[1:4] == ['--user', 'stop', 'dant-worker.service']]
        self.assertEqual(len(stops), 1)
        self.assertFalse((self.home / 'dant/deployed-source.json').exists())
        self.assertEqual(json.loads((self.home / 'dant/install-attempt.json').read_bytes())['phase'], 'activating')

    def test_failed_committed_journal_never_publishes_target_as_current(self):
        actual_write = installer.atomic_write

        def fail_commit(path, data, mode=0o600):
            if pathlib.Path(path).name == 'install-attempt.json':
                value = json.loads(data)
                if value.get('phase') == installer.PHASE_COMMITTED:
                    installer.reject('fixture-commit-unconfirmed')
            return actual_write(path, data, mode)

        with self.isolated_activation():
            with patch.object(installer, 'atomic_write', side_effect=fail_commit):
                with self.assertRaisesRegex(installer.InstallError, 'fixture-commit-unconfirmed'):
                    self.activate()
        self.assertFalse((self.home / 'dant/deployed-source.json').exists())
        attempt = json.loads((self.home / 'dant/install-attempt.json').read_bytes())
        self.assertEqual(attempt['phase'], installer.PHASE_ACTIVATING)
        self.assertEqual(sum(call[1:4] == ['--user', 'start', 'dant-worker.service'] for call in self.calls), 1)

    def test_replaced_verified_binary_before_copy_prevents_prepare(self):
        def replace_before_copy(arguments, **kwargs):
            self.quiet(arguments, **kwargs)
            if arguments[1:4] == ['--user', 'stop', 'dant-worker.service']:
                (self.source / installer.BINARY).write_bytes(b'changed resource')
        with self.isolated_activation(quiet=replace_before_copy):
            with self.assertRaises(installer.InstallError):
                self.activate()
        self.assertFalse(any('--role=prepare-worker' in call for call in self.calls))
        self.assertEqual(self.state.read_bytes(), self.original)

    def test_unknown_maintenance_reservation_blocks_shutdown_and_never_replays(self):
        active = {'LoadState': 'loaded', 'ActiveState': 'active', 'MainPID': '123', 'ControlGroup': ''}
        with self.isolated_activation():
            with patch.object(installer, 'service_state', return_value=active):
                with patch.object(installer, 'reserve_maintenance', side_effect=installer.InstallError('maintenance-unconfirmed')) as reservation:
                    with self.assertRaisesRegex(installer.InstallError, 'maintenance-unconfirmed'):
                        self.activate()
                    with self.assertRaisesRegex(installer.InstallError, 'previous-install-unconfirmed'):
                        self.activate()
                    self.assertEqual(reservation.call_count, 1)
        self.assertFalse(any(call[1:4] == ['--user', 'stop', 'dant-worker.service'] for call in self.calls))
        self.assertEqual(json.loads((self.home / 'dant/install-attempt.json').read_bytes())['phase'], 'reserving')

    def test_changed_service_identity_does_not_stop_replacement_after_reservation(self):
        original = {'LoadState': 'loaded', 'ActiveState': 'active', 'MainPID': '123', 'ControlGroup': ''}
        replacement = dict(original, MainPID='456')
        lease = '49954ce5-c8c5-4f6e-a7d8-531530d09479'
        with self.isolated_activation():
            with patch.object(installer, 'service_state', side_effect=[original, replacement]):
                with patch.object(installer, 'reserve_maintenance', return_value=lease):
                    with self.assertRaisesRegex(installer.InstallError, 'shutdown-unconfirmed'):
                        self.activate()
        self.assertFalse(any(call[1:4] == ['--user', 'stop', 'dant-worker.service'] for call in self.calls))
        attempt = json.loads((self.home / 'dant/install-attempt.json').read_bytes())
        self.assertEqual(attempt['maintenanceId'], lease)

    def test_cgroup_and_inherited_codex_owner_must_be_empty(self):
        proc = pathlib.Path(self.temporary.name) / 'proc'
        cgroups = pathlib.Path(self.temporary.name) / 'cgroups'
        proc.mkdir()
        group = cgroups / 'user.slice/dant-worker.service'
        group.mkdir(parents=True)
        processes = group / 'cgroup.procs'
        processes.write_bytes(b'')
        state = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': '/user.slice/dant-worker.service'}
        with patch.object(installer.os, 'getuid', return_value=0, create=True):
            installer.assert_stopped(self.home, state, proc, cgroups)
            processes.write_bytes(b'123\n')
            with self.assertRaisesRegex(installer.InstallError, 'shutdown-unconfirmed'):
                installer.assert_stopped(self.home, state, proc, cgroups)
            processes.write_bytes(b'')
            child = proc / '123'
            child.mkdir()
            (child / 'cmdline').write_bytes(b'/usr/bin/codex\0')
            (child / 'environ').write_bytes(b'CODEX_HOME=' + os.fsencode(str(self.home / '.dant-codex')) + b'\0')
            with patch.object(pathlib.Path, 'stat', autospec=True) as fake_stat:
                fake_stat.return_value.st_uid = 0
                with self.assertRaisesRegex(installer.InstallError, 'shutdown-unconfirmed'):
                    installer.assert_stopped(self.home, state, proc, cgroups)
                (child / 'cmdline').write_bytes(b'/usr/bin/firefox\0')
                installer.assert_stopped(self.home, state, proc, cgroups)
        for field, value in (('ActiveState', 'activating'), ('MainPID', '12'), ('ControlGroup', '/../../dant-worker.service')):
            with self.subTest(field=field):
                changed = dict(state)
                changed[field] = value
                with self.assertRaises(installer.InstallError):
                    installer.assert_stopped(self.home, changed, proc, cgroups)

    def test_new_worker_fence_is_acquired_once_and_unknown_post_is_never_replayed(self):
        lease = '49954ce5-c8c5-4f6e-a7d8-531530d09479'
        for mode in ('confirmed', 'legacy', 'unknown', 'existing'):
            with self.subTest(mode=mode):
                calls = []
                def opened(request, timeout):
                    if isinstance(request, str):
                        calls.append(('GET', '/api/session'))
                        return io.BytesIO(b'{"token":"fixture-token"}')
                    method = request.get_method()
                    calls.append((method, '/api/updates/worker-maintenance'))
                    if mode == 'legacy':
                        raise urllib.error.HTTPError(request.full_url, 404, 'fixture', {}, None)
                    if method == 'GET':
                        return io.BytesIO(json.dumps({'id': lease}).encode() if mode == 'existing' else b'null')
                    if mode == 'unknown':
                        raise TimeoutError('private unknown request outcome')
                    self.assertEqual(request.data, b'{}')
                    self.assertEqual(request.get_header('X-dant-token'), 'fixture-token')
                    return io.BytesIO(json.dumps({'id': lease}).encode())
                class Opener:
                    open = staticmethod(opened)
                with patch.object(installer, 'local_opener', return_value=Opener()):
                    if mode in ('unknown', 'existing'):
                        with self.assertRaisesRegex(installer.InstallError, 'maintenance-unconfirmed'):
                            installer.reserve_maintenance(self.configuration)
                    else:
                        self.assertEqual(installer.reserve_maintenance(self.configuration), lease if mode == 'confirmed' else None)
                self.assertEqual(sum(method == 'POST' for method, _ in calls), 1 if mode in ('confirmed', 'unknown') else 0)

    def test_readiness_requires_the_live_go_worker_and_exact_bundle_source(self):
        target = {
            'product': 'dant', 'mode': 'worker', 'runtime': 'go', 'protocol': 1,
            'version': self.configuration['version'],
            'source': self.configuration['commit'], 'token': 'fixture-token',
        }
        variants = {
            'matching': target,
            'legacy': {'product': 'dant', 'mode': 'worker', 'token': 'fixture-token'},
            'other-source': dict(target, source='0' * 40),
            'other-version': dict(target, version='0.0.0'),
            'controller': dict(target, mode='controller'),
            'node': dict(target, runtime='node'),
            'other-protocol': dict(target, protocol=2),
            'boolean-protocol': dict(target, protocol=True),
            'missing-token': {key: value for key, value in target.items() if key != 'token'},
        }
        for name, session in variants.items():
            with self.subTest(name=name):
                calls = []

                def opened(request, timeout):
                    if isinstance(request, str):
                        calls.append('/api/session')
                        return io.BytesIO(json.dumps(session).encode())
                    calls.append('/api/version')
                    self.assertEqual(request.get_header('X-dant-token'), 'fixture-token')
                    return io.BytesIO(json.dumps({'version': self.configuration['version']}).encode())

                class Opener:
                    open = staticmethod(opened)

                with patch.object(installer, 'local_opener', return_value=Opener()):
                    self.assertEqual(installer.ready(self.configuration), name == 'matching')
                self.assertEqual(calls, ['/api/session', '/api/version'] if name == 'matching' else ['/api/session'])


if __name__ == '__main__':
    unittest.main()
