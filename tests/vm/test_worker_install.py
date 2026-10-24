"""Go cutover fixtures. Never contact a service, VM, model, or package registry."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shlex
import shutil
import sys
import tempfile
import types
import urllib.error
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))
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
            if name == installer.LEGACY_PROTOCOL_PATH:
                continue
            data = ('isolated resource ' + name).encode()
            if name == installer.PROTOCOL_PATH:
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
        self.footprint = {'files': 1, 'contentBytes': 4096, 'dataBytes': 4096,
                          'stagingBytes': 65536, 'archiveBytes': 8192,
                          'requiredBytes': 65536 + 8192 + installer.SPACE_HEADROOM}

    def write_manifests(self):
        raw = json.dumps(self.manifest, separators=(',', ':'), ensure_ascii=False).encode()
        (self.source / installer.BUNDLE_MANIFEST).write_bytes(raw)
        self.digest = hashlib.sha256(raw).hexdigest()
        self.deployment = {'schemaVersion': 2, 'sha256': self.digest,
                           'publicEnvironment': {'DANT_GUEST_HOST': 'localhost', 'DANT_GUEST_PORT': '5540'}}
        (self.source / 'deploy-manifest.json').write_text(json.dumps(self.deployment), encoding='utf-8')

    def test_current_bundle_uses_canonical_resource_protocol(self):
        verified = installer.verify_bundle(self.source, self.home)
        self.assertIn(installer.PROTOCOL_PATH, verified['entries'])
        self.assertNotIn(installer.LEGACY_PROTOCOL_PATH, verified['entries'])

    def test_worker_unit_keeps_activation_link_and_uses_verified_real_configuration_root(self):
        for name in ('source.first-candidate', 'source.next-candidate.42'):
            with self.subTest(directory=name):
                target = self.source.with_name(name)
                self.source.rename(target)
                self.source = target
                configuration = installer.verify_bundle(self.source, self.home)
                unit = installer.service_units(configuration)['dant-worker.service'].decode('utf-8')
                command = next(line.removeprefix('ExecStart=') for line in unit.splitlines()
                               if line.startswith('ExecStart='))
                arguments = shlex.split(command)
                expected_root = '%h/dant/releases/' + name

                self.assertEqual(arguments, [
                    '%h/dant/bin/dant-core', '--role=worker', '--root=%h/dant/app',
                    '--config-root=' + expected_root, '--data-dir=%h/dant/data',
                    '--workspace-root=%h/dant/workspaces',
                ])
                self.assertEqual(pathlib.Path(expected_root.replace('%h', str(self.home))), self.source)
                self.assertFalse((self.source / '.env').exists())
                self.assertIn('WorkingDirectory=%h/dant/app', unit.splitlines())
                environment = dict(line.removeprefix('Environment=').split('=', 1)
                                   for line in unit.splitlines() if line.startswith('Environment='))
                self.assertEqual(environment['DANT_DATA'], '%h/dant/data')
                self.assertEqual(environment['DANT_WORKSPACE_ROOT'], '%h/dant/workspaces')
                self.assertEqual(environment['DANT_PORT'], str(configuration['port']))
                self.assertEqual(environment['DANT_GUEST_HOST'], configuration['guestHost'])
                self.assertEqual(environment['DANT_GUEST_PORT'], str(configuration['guestPort']))
                self.assertEqual(self.calls, [])

    def test_new_bootstrap_and_native_ports_cannot_be_reused_by_the_deployed_guest(self):
        protocol = json.loads((ROOT / 'resources/config/protocol.json').read_bytes())

        def save_protocol(value):
            raw = json.dumps(value).encode()
            (self.source / installer.PROTOCOL_PATH).write_bytes(raw)
            for entry in self.manifest['files']:
                if entry['path'] == installer.PROTOCOL_PATH:
                    entry.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            self.write_manifests()

        save_protocol(protocol)
        for port in (protocol['apiPort'], protocol['bootstrapGuestPort']):
            deployment = dict(self.deployment, publicEnvironment={
                'DANT_GUEST_HOST': 'localhost', 'DANT_GUEST_PORT': str(port)})
            (self.source / 'deploy-manifest.json').write_text(json.dumps(deployment))
            with self.subTest(port=port), self.assertRaisesRegex(installer.InstallError, '^network-invalid$'):
                installer.verify_bundle(self.source, self.home)

        deployment['publicEnvironment']['DANT_GUEST_PORT'] = str(protocol['devPort'])
        (self.source / 'deploy-manifest.json').write_text(json.dumps(deployment))
        self.assertEqual(installer.verify_bundle(self.source, self.home)['guestPort'], protocol['devPort'])
        for port in (None, True, 0, 65536, '4319', protocol['apiPort']):
            save_protocol(dict(protocol, bootstrapGuestPort=port))
            with self.subTest(port=port), self.assertRaisesRegex(installer.InstallError, '^network-invalid$'):
                installer.verify_bundle(self.source, self.home)

        legacy = dict(protocol)
        legacy.pop('bootstrapGuestPort')
        save_protocol(legacy)
        self.assertEqual(installer.verify_bundle(self.source, self.home)['guestPort'], 5540)
        self.assertEqual(self.calls, [])

    def test_network_helper_is_verified_in_new_bundle_but_legacy_target_may_omit_it(self):
        relative = 'vm/network_config.py'
        self.assertIn(relative, self.configuration['entries'])
        self.assertNotIn(relative, installer.REQUIRED)
        self.manifest['files'] = [entry for entry in self.manifest['files'] if entry['path'] != relative]
        (self.source / relative).unlink()
        self.write_manifests()
        verified = installer.verify_bundle(self.source, self.home)
        self.assertNotIn(relative, verified['entries'])

    def test_activation_installs_the_verified_shared_network_helper(self):
        with self.isolated_activation():
            self.activate()
        self.assertEqual((self.home / 'dant/vm/network_config.py').read_bytes(),
                         (self.source / 'vm/network_config.py').read_bytes())

    def test_legacy_activation_keeps_optional_missing_network_helper_compatible(self):
        relative = 'vm/network_config.py'
        self.manifest['files'] = [entry for entry in self.manifest['files'] if entry['path'] != relative]
        (self.source / relative).unlink()
        self.write_manifests()
        self.configuration = installer.verify_bundle(self.source, self.home)
        with self.isolated_activation():
            self.activate()
        self.assertFalse((self.home / 'dant/vm/network_config.py').exists())
        self.assertTrue((self.home / 'dant/vm/guest.py').is_file())

    def test_legacy_target_protocol_is_verified_without_changing_its_manifest(self):
        previous, _, _ = self.stopped_attempt(legacy_protocol=True)
        target = self.home / 'dant/releases' / previous['directory']
        original = (target / installer.BUNDLE_MANIFEST).read_bytes()
        verified = installer.verify_bundle(target, self.home)
        self.assertIn(installer.LEGACY_PROTOCOL_PATH, verified['entries'])
        self.assertNotIn(installer.PROTOCOL_PATH, verified['entries'])
        self.assertEqual((target / installer.BUNDLE_MANIFEST).read_bytes(), original)
        self.assertEqual(verified['digest'], previous['source'])

    def test_missing_or_ambiguous_protocol_cannot_select_a_manifest_layout(self):
        original_files = self.manifest['files']
        self.manifest['files'] = [entry for entry in original_files if entry['path'] != installer.PROTOCOL_PATH]
        self.write_manifests()
        with self.assertRaisesRegex(installer.InstallError, '^manifest-invalid$'):
            installer.verify_bundle(self.source, self.home)
        legacy = self.source / installer.LEGACY_PROTOCOL_PATH
        legacy.parent.mkdir(parents=True)
        raw = (self.source / installer.PROTOCOL_PATH).read_bytes()
        legacy.write_bytes(raw)
        self.manifest['files'] = sorted([*original_files, {
            'path': installer.LEGACY_PROTOCOL_PATH, 'bytes': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest(),
        }], key=lambda entry: entry['path'])
        self.write_manifests()
        with self.assertRaisesRegex(installer.InstallError, '^manifest-invalid$'):
            installer.verify_bundle(self.source, self.home)

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
            stack.enter_context(patch.object(installer, 'assert_guest_endpoint'))
            stack.enter_context(patch.object(installer, 'assert_conversation_runtime'))
            stack.enter_context(patch.object(installer, 'ready', return_value=ready))
            stack.enter_context(patch.object(installer, 'reserve_maintenance', return_value=None))
            stack.enter_context(patch.object(installer, 'unix_username', return_value='fixture'))
            stack.enter_context(patch.object(installer, 'ensure_linger'))
            stack.enter_context(patch.object(installer, 'backup_footprint', return_value=self.footprint))
            stack.enter_context(patch.object(installer, 'filesystem_space', return_value=(1, 1 << 40)))
            stack.enter_context(patch.object(installer.os, 'symlink', side_effect=lambda source, target, **_: pathlib.Path(target).write_text(str(source))))
            stack.enter_context(patch.object(installer.time, 'sleep'))
            yield

    def activate(self, manual=False, reconciliation=None):
        with contextlib.redirect_stdout(io.StringIO()):
            installer._activate_locked(self.configuration, manual, self.service_directory, reconciliation)

    def stopped_attempt(self, phase=installer.PHASE_STOPPING, legacy_protocol=False):
        old_source = self.source.with_name('source.previous')
        shutil.copytree(self.source, old_source)
        manifest = dict(self.manifest, version='0.4.6')
        if legacy_protocol:
            current = old_source / installer.PROTOCOL_PATH
            legacy = old_source / installer.LEGACY_PROTOCOL_PATH
            legacy.parent.mkdir(parents=True)
            current.rename(legacy)
            manifest['files'] = sorted([
                dict(entry, path=installer.LEGACY_PROTOCOL_PATH)
                if entry['path'] == installer.PROTOCOL_PATH else dict(entry)
                for entry in manifest['files']
            ], key=lambda entry: entry['path'])
        raw = json.dumps(manifest, separators=(',', ':')).encode()
        (old_source / installer.BUNDLE_MANIFEST).write_bytes(raw)
        deployment = dict(self.deployment, sha256=hashlib.sha256(raw).hexdigest())
        (old_source / 'deploy-manifest.json').write_bytes(json.dumps(deployment).encode())
        old = installer.verify_bundle(old_source, self.home)
        previous = {'schemaVersion': 1, 'attemptId': '12345678-1234-1234-1234-123456789abc',
                    'source': old['digest'], 'sourceCommit': old['commit'],
                    'version': old['version'], 'directory': old_source.name, 'phase': phase}
        raw = json.dumps(previous, indent=2).encode() + b'\n'
        (self.home / 'dant/install-attempt.json').write_bytes(raw)
        return previous, raw, {'attemptId': previous['attemptId'], 'journalSha256': hashlib.sha256(raw).hexdigest()}

    def prior_preparation(self, attempt_id):
        proof = {'schemaVersion': 1, 'attemptId': attempt_id, 'source': 'b' * 64,
                 'sourceCommit': 'b' * 40, 'version': '0.4.5', 'directory': 'source.older',
                 'dataDir': str(self.home / 'dant/data'),
                 'workspaceRoot': str(self.home / 'dant/workspaces'),
                 'backup': '87654321-4321-4321-4321-cba987654321.raw',
                 'backupBytes': 42, 'backupModifiedNS': '1234',
                 'backupIdentity': '1:2', 'backupSha256': 'c' * 64}
        raw = json.dumps(proof).encode()
        (self.home / 'dant' / installer.PREPARATION_FILE).write_bytes(raw)
        return raw

    def test_valid_bundle_has_exact_provenance_and_public_network(self):
        self.assertEqual(self.configuration['digest'], self.digest)
        self.assertEqual(self.configuration['guestHost'], 'localhost')
        self.assertEqual(self.configuration['guestPort'], 5540)
        self.assertEqual(self.configuration['port'], 4317)

    def test_space_preflight_uses_only_the_verified_candidate_and_strict_numeric_output(self):
        environment, _ = installer.installation_environment(self.configuration)
        response = types.SimpleNamespace(returncode=0, stdout=json.dumps(self.footprint).encode())
        with patch.object(installer.subprocess, 'run', return_value=response) as run:
            self.assertEqual(installer.backup_footprint(self.configuration, environment), self.footprint)
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[:3], [str(self.source / installer.BINARY), '--role=backup-cli', 'preflight'])
        self.assertEqual(run.call_args.kwargs['env']['TMPDIR'], environment['TMPDIR'])
        self.assertNotEqual(arguments[0], str(self.home / 'dant/bin/dant-core'))
        for change in ({'files': True}, {'files': 0}, {'dataBytes': 4097}, {'contentBytes': -1},
                       {'stagingBytes': 1}, {'requiredBytes': 0}, {'unexpected': 1}):
            with self.subTest(change=change):
                response.stdout = json.dumps(dict(self.footprint, **change)).encode()
                with patch.object(installer.subprocess, 'run', return_value=response):
                    with self.assertRaisesRegex(installer.InstallError, '^space-unconfirmed$'):
                        installer.backup_footprint(self.configuration, environment)
        response.stdout = b'private process content' * installer.PREFLIGHT_LIMIT
        with patch.object(installer.subprocess, 'run', return_value=response):
            with self.assertRaisesRegex(installer.InstallError, '^space-unconfirmed$'):
                installer.backup_footprint(self.configuration, environment)

    def test_space_is_grouped_by_filesystem_and_sequential_phase_peak(self):
        environment, temporary = installer.installation_environment(self.configuration)
        root = self.home / 'dant'
        footprint = self.footprint
        capacities = {
            temporary: (1, footprint['stagingBytes'] + installer.SPACE_HEADROOM),
            root / 'installation-backups': (2, footprint['archiveBytes'] + installer.SPACE_HEADROOM),
            root / 'data': (3, footprint['dataBytes'] + installer.SPACE_HEADROOM),
        }
        with patch.object(installer, 'backup_footprint', return_value=footprint):
            with patch.object(installer, 'filesystem_space', side_effect=lambda path: capacities[path]):
                installer.assert_installation_space(self.configuration, environment, temporary)
            shared_peak = sum(footprint[key] for key in ('stagingBytes', 'archiveBytes', 'dataBytes'))
            with patch.object(installer, 'filesystem_space', return_value=(1, shared_peak + installer.SPACE_HEADROOM)):
                installer.assert_installation_space(self.configuration, environment, temporary)
            with patch.object(installer, 'filesystem_space', return_value=(1, shared_peak + installer.SPACE_HEADROOM - 1)):
                with self.assertRaisesRegex(installer.InstallError, '^space-insufficient$'):
                    installer.assert_installation_space(self.configuration, environment, temporary)

    def test_insufficient_space_preserves_old_binary_service_and_journal(self):
        binary = self.home / 'dant/bin/dant-core'
        binary.write_bytes(b'unchanged old worker')
        with self.isolated_activation():
            with patch.object(installer, 'filesystem_space', return_value=(1, 0)):
                with self.assertRaisesRegex(installer.InstallError, '^space-insufficient$'):
                    self.activate()
        self.assertEqual(binary.read_bytes(), b'unchanged old worker')
        self.assertEqual(self.state.read_bytes(), self.original)
        self.assertFalse((self.home / 'dant/install-attempt.json').exists())
        self.assertFalse(any(call[1:4] == ['--user', 'stop', 'dant-worker.service'] for call in self.calls))

    def test_oversized_or_unknown_filesystem_allocation_is_not_guessed(self):
        for size in (0, installer.SPACE_ALLOCATION_LIMIT + 1, True):
            with self.subTest(size=size):
                capacity = types.SimpleNamespace(f_bavail=1 << 30, f_frsize=size)
                with patch.object(installer.os, 'statvfs', return_value=capacity, create=True):
                    with self.assertRaisesRegex(installer.InstallError, '^space-unconfirmed$'):
                        installer.filesystem_space(self.home)

    def test_separate_memory_filesystem_also_needs_migration_capacity(self):
        memory = self.home / 'dant/data/memory/dant'
        memory.mkdir(parents=True)
        environment, temporary = installer.installation_environment(self.configuration)
        def capacity(path):
            return (2, 0) if path == memory else (1, 1 << 40)
        with patch.object(installer, 'backup_footprint', return_value=self.footprint):
            with patch.object(installer, 'filesystem_space', side_effect=capacity):
                with self.assertRaisesRegex(installer.InstallError, '^space-insufficient$'):
                    installer.assert_installation_space(self.configuration, environment, temporary)

    def test_explicit_reconciliation_keeps_original_evidence_and_runs_a_whole_new_cutover(self):
        previous, raw, request = self.stopped_attempt()
        orphan = self.home / 'dant/installation-backups/orphan.raw'
        orphan.write_bytes(b'incomplete original archive')
        with self.isolated_activation():
            self.activate(reconciliation=request)
        history = list((self.home / 'dant' / installer.RECONCILIATION_DIRECTORY).iterdir())
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].read_bytes(), raw)
        attempt = json.loads((self.home / 'dant/install-attempt.json').read_bytes())
        self.assertNotEqual(attempt['attemptId'], previous['attemptId'])
        self.assertEqual(attempt['source'], self.configuration['digest'])
        self.assertEqual(attempt['phase'], installer.PHASE_COMMITTED)
        self.assertEqual(orphan.read_bytes(), b'incomplete original archive')
        self.assertEqual(sum('--role=backup-cli' in call for call in self.calls), 1)
        self.assertEqual(sum('--role=prepare-worker' in call for call in self.calls), 1)

    def test_partial_attempt_cannot_be_replayed_by_automatic_activation(self):
        _, raw, _ = self.stopped_attempt()
        with self.isolated_activation():
            with self.assertRaisesRegex(installer.InstallError, '^previous-install-unconfirmed$'):
                self.activate()
        self.assertEqual((self.home / 'dant/install-attempt.json').read_bytes(), raw)
        self.assertEqual(self.calls, [])

    def test_explicit_same_source_reconciliation_creates_a_new_attempt_without_resuming_the_old_one(self):
        previous, _, _ = self.stopped_attempt()
        previous.update({'source': self.configuration['digest'], 'sourceCommit': self.configuration['commit'],
                         'version': self.configuration['version'], 'directory': self.source.name})
        raw = json.dumps(previous).encode()
        (self.home / 'dant/install-attempt.json').write_bytes(raw)
        request = {'attemptId': previous['attemptId'], 'journalSha256': hashlib.sha256(raw).hexdigest()}
        with self.isolated_activation():
            self.activate(reconciliation=request)
        current = json.loads((self.home / 'dant/install-attempt.json').read_bytes())
        self.assertNotEqual(current['attemptId'], previous['attemptId'])
        self.assertEqual(current['source'], previous['source'])
        self.assertEqual(current['phase'], installer.PHASE_COMMITTED)
        self.assertEqual(sum('--role=backup-cli' in call for call in self.calls), 1)
        self.assertEqual(sum('--role=prepare-worker' in call for call in self.calls), 1)

    def test_new_operator_preflight_keeps_older_target_bundle_and_live_proof_identity(self):
        previous, _, request = self.stopped_attempt(legacy_protocol=True)
        target = installer.verify_bundle(self.home / 'dant/releases' / previous['directory'], self.home)
        script = self.source / 'vm/worker-install.py'
        with patch.object(installer, '__file__', str(script)):
            configuration = installer.verify_reconciliation_operator(target)
        self.assertEqual(configuration['source'], target['source'])
        self.assertEqual(configuration['operatorSource'], self.source)
        response = types.SimpleNamespace(returncode=0, stdout=json.dumps(self.footprint).encode())
        environment, _ = installer.installation_environment(configuration)
        with patch.object(installer.subprocess, 'run', return_value=response) as run:
            installer.backup_footprint(configuration, environment)
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[0], str(self.source / installer.BINARY))
        self.assertEqual(arguments[-1], target['digest'])
        self.configuration = configuration
        with self.isolated_activation():
            self.activate(reconciliation=request)
        current = json.loads((self.home / 'dant/install-attempt.json').read_bytes())
        self.assertEqual(current['source'], target['digest'])
        self.assertEqual(current['sourceCommit'], target['commit'])
        self.assertTrue(any(call[:3] == ['bash', str(target['source'] / 'vm/install-worker.sh'), str(target['source'])] for call in self.calls))
        prepare = next(call for call in self.calls if '--role=prepare-worker' in call)
        self.assertIn('--root=' + str(target['source']), prepare)
        self.assertEqual((self.home / 'dant/bin/dant-core').read_bytes(), (target['source'] / installer.BINARY).read_bytes())
        script.write_bytes(b'changed operator helper')
        with patch.object(installer, '__file__', str(script)):
            with self.assertRaises(installer.InstallError):
                installer.verify_reconciliation_operator(target)

    def test_reconciliation_refuses_wrong_identity_later_phases_and_any_backup_marker(self):
        previous, _, request = self.stopped_attempt()
        variants = [dict(previous, phase=phase) for phase in ('unknown', installer.PHASE_PREPARING,
                                                           installer.PHASE_ACTIVATING, installer.PHASE_COMMITTED)]
        variants += [dict(previous, backup=''), dict(previous, backupBytes=0), dict(previous, preparationSha256='a' * 64)]
        for changed in variants:
            with self.subTest(changed=changed):
                raw = json.dumps(changed).encode()
                (self.home / 'dant/install-attempt.json').write_bytes(raw)
                exact = dict(request, journalSha256=hashlib.sha256(raw).hexdigest())
                with self.isolated_activation():
                    with self.assertRaisesRegex(installer.InstallError, '^reconciliation-unconfirmed$'):
                        self.activate(reconciliation=exact)
                self.assertEqual((self.home / 'dant/install-attempt.json').read_bytes(), raw)
                self.assertEqual(self.calls, [])
        raw = json.dumps(previous).encode()
        (self.home / 'dant/install-attempt.json').write_bytes(raw)
        for wrong in (dict(request, attemptId='00000000-0000-0000-0000-000000000000'), request):
            with self.isolated_activation():
                with self.assertRaisesRegex(installer.InstallError, '^reconciliation-unconfirmed$'):
                    self.activate(reconciliation=wrong)
        self.assertEqual(self.calls, [])

    def test_reconciliation_rejects_changed_old_source_or_unstopped_processes(self):
        previous, raw, request = self.stopped_attempt()
        with self.isolated_activation():
            with patch.object(installer, 'assert_stopped', side_effect=installer.InstallError('shutdown-unconfirmed')):
                with self.assertRaisesRegex(installer.InstallError, '^shutdown-unconfirmed$'):
                    self.activate(reconciliation=request)
        self.assertEqual(self.calls, [])
        old_binary = self.home / 'dant/releases' / previous['directory'] / installer.BINARY
        old_binary.write_bytes(b'changed old provenance')
        with self.isolated_activation():
            with self.assertRaises(installer.InstallError):
                self.activate(reconciliation=request)
        self.assertEqual(self.calls, [])
        self.assertEqual((self.home / 'dant/install-attempt.json').read_bytes(), raw)

    def test_reconciliation_blocks_current_preparation_but_preserves_an_older_receipt(self):
        previous, raw, request = self.stopped_attempt()
        self.prior_preparation(previous['attemptId'])
        with self.isolated_activation():
            with self.assertRaisesRegex(installer.InstallError, '^reconciliation-unconfirmed$'):
                self.activate(reconciliation=request)
        self.assertEqual(self.calls, [])
        prior = self.prior_preparation('87654321-4321-4321-4321-cba987654321')
        with self.isolated_activation():
            self.activate(reconciliation=request)
        records = [path.read_bytes() for path in (self.home / 'dant' / installer.RECONCILIATION_DIRECTORY).iterdir()]
        self.assertCountEqual(records, [raw, prior])

    def test_space_or_journal_change_during_reconciliation_keeps_the_original_fence(self):
        _, raw, request = self.stopped_attempt()
        attempt = self.home / 'dant/install-attempt.json'
        with self.isolated_activation():
            with patch.object(installer, 'filesystem_space', return_value=(1, 0)):
                with self.assertRaisesRegex(installer.InstallError, '^space-insufficient$'):
                    self.activate(reconciliation=request)
        self.assertEqual(attempt.read_bytes(), raw)
        self.assertFalse((self.home / 'dant' / installer.RECONCILIATION_DIRECTORY).exists())

        def changed(arguments, **kwargs):
            self.quiet(arguments, **kwargs)
            if '--guard-only' in arguments:
                attempt.write_bytes(raw + b' ')
        with self.isolated_activation(quiet=changed):
            with self.assertRaisesRegex(installer.InstallError, '^reconciliation-unconfirmed$'):
                self.activate(reconciliation=request)
        self.assertEqual(attempt.read_bytes(), raw + b' ')
        self.assertFalse((self.home / 'dant' / installer.RECONCILIATION_DIRECTORY).exists())
        self.assertFalse(any('--role=backup-cli' in call for call in self.calls))

    def test_crash_between_history_and_new_journal_never_removes_the_fence(self):
        _, raw, request = self.stopped_attempt()
        actual = installer.atomic_write
        def fail_before_new_journal(path, data, mode=0o600):
            if pathlib.Path(path).name == 'install-attempt.json':
                history = list((self.home / 'dant' / installer.RECONCILIATION_DIRECTORY).iterdir())
                self.assertEqual([entry.read_bytes() for entry in history], [raw])
                installer.reject('fixture-new-journal-unconfirmed')
            return actual(path, data, mode)
        with self.isolated_activation():
            with patch.object(installer, 'atomic_write', side_effect=fail_before_new_journal):
                with self.assertRaisesRegex(installer.InstallError, '^fixture-new-journal-unconfirmed$'):
                    self.activate(reconciliation=request)
            before_retry = len(self.calls)
            with self.assertRaisesRegex(installer.InstallError, '^previous-install-unconfirmed$'):
                self.activate()
            self.assertEqual(len(self.calls), before_retry)
        self.assertEqual((self.home / 'dant/install-attempt.json').read_bytes(), raw)
        self.assertFalse(any('--role=backup-cli' in call for call in self.calls))

    @unittest.skipUnless(os.name == 'posix', 'kernel flock requires the Linux installer host')
    def test_kernel_install_lock_rejects_a_second_operator_before_any_process(self):
        import fcntl
        lock_path = self.home / 'dant/.worker-install.lock'
        with lock_path.open('wb') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(installer, 'run_quiet') as run:
                with self.assertRaisesRegex(installer.InstallError, '^install-busy$'):
                    installer.activate(self.configuration)
                run.assert_not_called()
        self.assertFalse((self.home / 'dant/install-attempt.json').exists())

    def test_stopped_proof_rejects_an_owned_backup_or_installation_child(self):
        proc = pathlib.Path(self.temporary.name) / 'recovery-proc'
        child = proc / '123'
        child.mkdir(parents=True)
        (child / 'environ').write_bytes(b'')
        state = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': ''}
        root = self.home / 'dant'
        commands = [
            [b'dant-core', b'--role=backup-cli', b'export', b'--data-dir', os.fsencode(str(root / 'data'))],
            [b'dant-core', b'--role=backup-cli', b'export', b'--workspace-root=' + os.fsencode(str(root / 'workspaces'))],
            [os.fsencode((self.source / installer.BINARY).as_posix()), b'--role=prepare-worker', b'--data-dir=' + os.fsencode(str(root / 'data'))],
            [os.fsencode((self.source / installer.BINARY).as_posix()), b'--role=backup-cli', b'export', b'--workspace-root', os.fsencode(str(root / 'workspaces'))],
            [b'python3.12', os.fsencode(str(self.source / 'vm/worker-install.py')), b'activate'],
            [b'bash', os.fsencode(str(self.source / 'vm/install-worker.sh')), os.fsencode(str(self.source))],
        ]
        with patch.object(installer.os, 'getuid', return_value=0, create=True):
            with patch.object(pathlib.Path, 'stat', autospec=True) as current:
                current.return_value.st_uid = 0
                for arguments in commands:
                    (child / 'cmdline').write_bytes(b'\0'.join(arguments) + b'\0')
                    with self.assertRaisesRegex(installer.InstallError, '^shutdown-unconfirmed$'):
                        installer.assert_stopped(self.home, state, proc)
                (child / 'cmdline').write_bytes(b'dant-core\0--data-dir\0/other/data\0')
                installer.assert_stopped(self.home, state, proc)
                (child / 'cmdline').write_bytes(os.fsencode((self.source / installer.BINARY).as_posix()) + b'\0--role=backup-cli\0export\0')
                (child / 'environ').write_bytes(b'DANT_DATA=' + os.fsencode(str(root / 'data')) + b'\0')
                with self.assertRaisesRegex(installer.InstallError, '^shutdown-unconfirmed$'):
                    installer.assert_stopped(self.home, state, proc)

    def test_stopped_proof_resolves_relative_installer_commands_and_rejects_unknown_cwd(self):
        proc = pathlib.Path(self.temporary.name) / 'relative-proc'
        child = proc / '123'
        child.mkdir(parents=True)
        (child / 'environ').write_bytes(b'')
        state = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': ''}
        for arguments in (b'bash\0vm/install-worker.sh\0source.fixture\0',
                          b'python3\0./vm/worker-install.py\0activate\0source.fixture\0'):
            (child / 'cmdline').write_bytes(arguments)
            with patch.object(installer.os, 'getuid', return_value=0, create=True):
                with patch.object(pathlib.Path, 'stat', autospec=True) as current:
                    current.return_value.st_uid = 0
                    for cwd in (self.source, pathlib.Path(str(self.source) + ' (deleted)')):
                        with patch.object(pathlib.Path, 'readlink', return_value=cwd):
                            with self.assertRaisesRegex(installer.InstallError, '^shutdown-unconfirmed$'):
                                installer.assert_stopped(self.home, state, proc)
                    with patch.object(pathlib.Path, 'readlink', side_effect=PermissionError('private metadata')):
                        with self.assertRaisesRegex(installer.InstallError, '^shutdown-unconfirmed$'):
                            installer.assert_stopped(self.home, state, proc)
                    with patch.object(pathlib.Path, 'readlink', side_effect=FileNotFoundError('private metadata')):
                        with self.assertRaisesRegex(installer.InstallError, '^shutdown-unconfirmed$'):
                            installer.assert_stopped(self.home, state, proc)
                    with patch.object(pathlib.Path, 'readlink', return_value=self.home / 'other'):
                        installer.assert_stopped(self.home, state, proc)

    def test_reconciliation_arguments_cannot_fall_through_to_automatic_activation(self):
        for arguments in (
            ['reconcile-stopped', str(self.source), str(self.home)],
            ['reconcile-stopped', str(self.source), str(self.home), '--attempt-id', '', '--journal-sha256', 'a' * 64],
            ['reconcile-stopped', str(self.source), str(self.home), '--attempt-id', '12345678-1234-1234-1234-123456789abc', '--journal-sha256', 'unknown'],
        ):
            with patch.object(installer, 'activate') as activate:
                with self.assertRaisesRegex(installer.InstallError, '^arguments-invalid$'):
                    installer.main(arguments)
                activate.assert_not_called()

    def test_installation_phase_constants_match_shared_contract(self):
        domains = json.loads((ROOT / 'resources/contracts/state-domains.json').read_bytes())['domains']
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

                with patch.object(installer, 'local_opener', return_value=Opener()), \
                        patch.object(installer, 'guest_ready', return_value=True):
                    self.assertEqual(installer.ready(self.configuration), name == 'matching')
                self.assertEqual(calls, ['/api/session', '/api/version'] if name == 'matching' else ['/api/session'])


if __name__ == '__main__':
    unittest.main()
