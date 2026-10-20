"""Real bounded service/proc parsing with synthetic files; no service or sockets."""
import hashlib
import io
import json
import os
import pathlib
import shlex
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))
import guest_service as proof
import test_worker_install as fixtures


class GuestServiceTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = pathlib.Path(folder.name)
        self.home = self.root / 'home'
        self.seed = self.root / 'opt/dant/guest.py'
        self.seed.parent.mkdir(parents=True)
        self.seed.write_bytes((ROOT / 'tests/vm/fixtures/legacy-guest-beta14.txt').read_bytes())
        self.candidate = self.home / 'dant/vm/guest.py'
        self.candidate.parent.mkdir(parents=True)
        self.candidate.write_bytes(b'isolated verified candidate')
        self.configuration = {'home': self.home, 'guestHost': '127.0.0.1', 'guestPort': 4321,
                              'entries': {'vm/guest.py': {'sha256': hashlib.sha256(self.candidate.read_bytes()).hexdigest()}}}
        self.proc = self.root / 'proc'
        (self.proc / 'net').mkdir(parents=True)
        for name in ('tcp', 'tcp6'):
            (self.proc / 'net' / name).write_text('header\n')
        self.process = self.proc / '123'
        (self.process / 'net').mkdir(parents=True)
        (self.process / 'fd').mkdir()
        (self.process / 'fd/3').write_bytes(b'fd directory entry, not socket content')
        self.links = {'3': 'socket:[99]', 'exe': '/usr/bin/python3.12'}
        self.path_links = {}
        self.system = self.service(proof.SYSTEM_UNIT)
        self.user = self.service(proof.USER_UNIT)
        self.calls = []
        self.sinks = []
        self.observer = proof.GuestServiceObserver(run=self.fake_run, proc=self.proc, uid=1000,
                                                  seed=self.seed, readlink=lambda path: self.path_links.get(str(path), self.links[path.name]))
        self.write_process(self.seed, {}, 4320, proof.SYSTEM_UNIT)

    def tearDown(self):
        self.assertTrue(all(sink.closed for sink in self.sinks))

    def service(self, unit):
        return {'LoadState': 'loaded', 'ActiveState': 'active', 'MainPID': '123',
                'ControlGroup': '/isolated/' + unit, 'Environment': '', 'EnvironmentFiles': ''}

    def fake_run(self, command, **options):
        self.calls.append(command)
        sink = options.pop('stdout')
        self.sinks.append(sink)
        self.assertFalse(sink.closed)
        self.assertEqual(options, {'stdin': subprocess.DEVNULL,
                                   'stderr': subprocess.DEVNULL, 'timeout': 5, 'check': False})
        self.assertEqual(command[0], 'systemctl')
        state = self.user if '--user' in command else self.system
        sink.write(''.join(key + '=' + value + '\n' for key, value in state.items()).encode())
        return types.SimpleNamespace(returncode=0)

    def native_reply(self, raw, code=0):
        def run(command, **options):
            sink = options['stdout']
            self.sinks.append(sink)
            sink.write(raw)
            return types.SimpleNamespace(returncode=code)
        return run

    def write_process(self, script, environment, port, unit):
        if unit == proof.USER_UNIT:
            self.user['Environment'] = ' '.join(shlex.quote(key + '=' + value) for key, value in environment.items())
        (self.process / 'stat').write_text('123 (python3) ' + ' '.join(['S'] + ['0'] * 18 + ['234']))
        (self.process / 'status').write_text('Name:\tpython3\nUid:\t1000\t1000\t1000\t1000\n')
        (self.process / 'cmdline').write_bytes(b'/usr/bin/python3\0' + str(script).encode() + b'\0')
        (self.process / 'environ').write_bytes(b''.join((key + '=' + value).encode() + b'\0' for key, value in environment.items()))
        (self.process / 'cgroup').write_text('0::/isolated/' + unit + '\n')
        (self.process / 'net/tcp').write_text('header\n0: 0100007F:' + format(port, '04X') + ' 00000000:0000 0A 0:0 0:0 0 1000 0 99\n')
        (self.process / 'net/tcp6').write_text('header\n')

    def user_environment(self):
        return {'DANT_GUEST_HOST': '127.0.0.1', 'DANT_GUEST_PORT': '4321',
                'DANT_CONTROL_FILE': str(self.home / 'dant/data/computer-control.json')}

    def namespace_listener(self, inode='100', address='0100007F', port=4321):
        (self.proc / 'net/tcp').write_text('header\n0: ' + address + ':' + format(port, '04X') +
                                         ' 00000000:0000 0A 0:0 0:0 0 1000 0 ' + inode + '\n')

    def current_user_listener(self):
        original = self.process
        self.process = self.proc / '456'
        (self.process / 'net').mkdir(parents=True)
        (self.process / 'fd').mkdir()
        (self.process / 'fd/3').write_bytes(b'owned descriptor')
        self.candidate.write_bytes(self.seed.read_bytes())
        self.user['MainPID'] = '456'
        self.write_process(self.candidate, self.user_environment(), 4321, proof.USER_UNIT)
        file = self.process / 'stat'
        file.write_text(file.read_text().replace('123 (', '456 ('))
        file = self.process / 'net/tcp'
        file.write_text(file.read_text().replace(' 99\n', ' 100\n'))
        self.path_links[str(self.process / 'fd/3')] = 'socket:[100]'
        self.path_links[str(self.process / 'exe')] = '/usr/bin/python3.12'
        self.process = original

    def test_exact_historical_source_and_owned_legacy_socket_allow_new_default(self):
        self.assertIn(hashlib.sha256(self.seed.read_bytes()).hexdigest(), proof.KNOWN_SEED_SOURCES)
        self.observer.system_available(self.configuration)
        self.assertEqual(len(self.calls), 2)
        self.configuration['guestPort'] = 4320
        with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-conflict$'):
            self.observer.system_available(self.configuration)

    def test_declared_collision_is_rejected_even_when_system_unit_is_stopped(self):
        self.system.update(MainPID='0', ActiveState='inactive', ControlGroup='', Environment='DANT_GUEST_PORT=4320')
        self.observer.system_available(self.configuration)
        self.configuration['guestPort'] = 4320
        with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-conflict'):
            self.observer.system_available(self.configuration)
        self.system['Environment'] = ''
        with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
            self.observer.system_available(self.configuration)

    def test_missing_seed_service_and_proven_different_port_need_no_unrelated_fd_access(self):
        self.system.update(LoadState='not-found', ActiveState='inactive', MainPID='0', ControlGroup='')
        self.observer.system_available(self.configuration)
        self.system = self.service(proof.SYSTEM_UNIT)
        self.write_process(self.seed, {'DANT_GUEST_PORT': '4320'}, 4320, proof.SYSTEM_UNIT)
        self.observer.readlink = lambda path: self.links['exe'] if path.name == 'exe' else self.fail('unrelated FD ownership was unnecessarily read')
        self.observer.system_available(self.configuration)

    def test_unknown_seed_and_process_or_service_replacement_never_pass(self):
        for mode in ('source', 'uid', 'argv', 'exe', 'cgroup', 'stat', 'service-race', 'pid-reuse', 'unowned-socket', 'wildcard'):
            with self.subTest(mode=mode):
                self.setUp()
                if mode == 'source':
                    self.seed.write_bytes(b'unknown source')
                elif mode == 'uid':
                    (self.process / 'status').write_text('Uid:\t2000\t2000\t2000\t2000\n')
                elif mode == 'argv':
                    (self.process / 'cmdline').write_bytes(b'/usr/bin/python3\0/foreign/guest.py\0')
                elif mode == 'exe':
                    self.links['exe'] = '/tmp/python3'
                elif mode == 'cgroup':
                    (self.process / 'cgroup').write_text('0::/foreign\n')
                elif mode == 'stat':
                    (self.process / 'stat').write_text('not a process identity')
                elif mode == 'unowned-socket':
                    self.links['3'] = 'socket:[88]'
                elif mode == 'wildcard':
                    file = self.process / 'net/tcp'
                    file.write_text(file.read_text().replace('0100007F', '00000000'))
                else:
                    original = self.observer.run
                    def raced(command, **options):
                        if len(self.calls) == 1:
                            if mode == 'service-race':
                                self.system['MainPID'] = '124'
                            else:
                                file = self.process / 'stat'
                                file.write_text(file.read_text().replace('234', '235'))
                        return original(command, **options)
                    self.observer.run = raced
                with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
                    self.observer.system_available(self.configuration)

    def test_candidate_requires_current_user_service_script_environment_and_listener(self):
        for mode in ('valid', 'inactive', 'source', 'uid', 'argv', 'cgroup', 'host', 'port', 'control', 'missing-port', 'socket', 'wildcard'):
            with self.subTest(mode=mode):
                self.setUp()
                environment = self.user_environment()
                if mode in ('host', 'port', 'control'):
                    environment[{'host': 'DANT_GUEST_HOST', 'port': 'DANT_GUEST_PORT', 'control': 'DANT_CONTROL_FILE'}[mode]] = 'foreign'
                if mode == 'missing-port':
                    del environment['DANT_GUEST_PORT']
                self.write_process(self.candidate, environment, 4321, proof.USER_UNIT)
                self.namespace_listener(inode='99')
                if mode == 'source':
                    self.candidate.write_bytes(b'changed helper')
                elif mode == 'inactive':
                    self.user['ActiveState'] = 'inactive'
                elif mode == 'uid':
                    (self.process / 'status').write_text('Uid:\t2000\t2000\t2000\t2000\n')
                elif mode == 'argv':
                    (self.process / 'cmdline').write_bytes(b'/usr/bin/python3\0/foreign/guest.py\0')
                elif mode == 'cgroup':
                    self.user['ControlGroup'] = '/foreign.service'
                elif mode == 'socket':
                    self.links['3'] = 'socket:[88]'
                elif mode == 'wildcard':
                    file = self.process / 'net/tcp'
                    file.write_text(file.read_text().replace('0100007F', '00000000'))
                if mode == 'valid':
                    self.observer.user_ready(self.configuration)
                else:
                    with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
                        self.observer.user_ready(self.configuration)

    def test_service_and_environment_bounds_fail_closed(self):
        for raw in (b'private unknown response', b'x' * (proof.SERVICE_BYTES + 1), b'LoadState=loaded\nLoadState=loaded\n'):
            self.observer.run = self.native_reply(raw)
            with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
                self.observer.system_available(self.configuration)
        for environment in ('DANT_GUEST_PORT=0', 'DANT_GUEST_PORT=65536', 'DANT_GUEST_HOST=0.0.0.0', 'DANT_GUEST_PORT=4320 DANT_GUEST_PORT=4321'):
            self.observer.run = self.fake_run
            self.system['Environment'] = environment
            with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
                self.observer.system_available(self.configuration)

    def test_inconsistent_service_fields_and_failed_commands_never_prove_ownership(self):
        for changes in ({'EnvironmentFiles': '/untrusted/env'}, {'MainPID': '2147483648'},
                        {'MainPID': '-1'}, {'LoadState': 'future'}, {'ActiveState': 'activating'},
                        {'LoadState': 'not-found'}, {'ControlGroup': '/wrong-unit'},
                        {'MainPID': '0', 'Environment': 'DANT_GUEST_PORT=4319'}):
            with self.subTest(changes=changes):
                self.system = dict(self.service(proof.SYSTEM_UNIT), **changes)
                with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
                    self.observer.system_available(self.configuration)
        self.system = self.service(proof.SYSTEM_UNIT)
        raw = ''.join(key + '=' + value + '\n' for key, value in self.system.items()).encode()
        self.observer.run = self.native_reply(raw, code=1)
        with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
            self.observer.system_available(self.configuration)

    def test_listener_tables_and_fd_inventory_are_bounded_and_source_files_cannot_be_linked(self):
        file = self.root / 'bounded'
        file.write_bytes(b'abc')
        self.assertEqual(proof.read_bounded(file, 3), b'abc')
        with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
            proof.read_bounded(file, 2)
        os.link(file, self.root / 'second-name')
        with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
            proof.read_bounded(file, 3)
        for raw in ('header\nincomplete\n', 'header\n0: no-port 0 0A 0 0 0 1000 0 99\n',
                    'header\n0: 0100007F:10E0 0 0A 0 0 0 1000 0 invalid\n'):
            (self.process / 'net/tcp').write_text(raw)
            with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
                self.observer.system_available(self.configuration)
        self.write_process(self.seed, {}, 4320, proof.SYSTEM_UNIT)
        with (self.process / 'net/tcp').open('a') as table:
            table.write('1: 0100007F:10E1 0 01 0 0 0 1000 0 100\n')
        (self.process / 'fd/4').write_bytes(b'ordinary FD entry')
        self.links['4'] = '/irrelevant/ordinary-file'
        self.observer.system_available(self.configuration)
        for index in range(proof.MAXIMUM_FDS):
            (self.process / 'fd' / str(index + 10)).write_bytes(b'')
        with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
            self.observer.system_available(self.configuration)

    def test_user_service_replacement_and_private_probe_errors_are_not_confirmed(self):
        self.write_process(self.candidate, self.user_environment(), 4321, proof.USER_UNIT)
        self.namespace_listener(inode='99')
        original = self.observer.run
        def replaced(command, **options):
            if len(self.calls) == 1:
                self.user['MainPID'] = '124'
            return original(command, **options)
        self.observer.run = replaced
        with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-unconfirmed'):
            self.observer.user_ready(self.configuration)
        for error in (PermissionError('private path'), subprocess.TimeoutExpired('private command', 5)):
            with patch.object(proof.GuestServiceObserver, 'system_available', side_effect=error), \
                    patch.object(proof.os, 'getuid', return_value=1000, create=True):
                with self.assertRaisesRegex(fixtures.installer.InstallError, '^guest-endpoint-unconfirmed$'):
                    fixtures.installer.assert_guest_endpoint(self.configuration)
            with patch.object(proof.GuestServiceObserver, 'user_ready', side_effect=error), \
                    patch.object(proof.os, 'getuid', return_value=1000, create=True):
                self.assertFalse(fixtures.installer.guest_ready(self.configuration))

    def test_native_failure_closes_private_capture_and_never_exposes_its_output(self):
        for error in (PermissionError('private native path'), subprocess.TimeoutExpired('private native command', 5)):
            def failed(command, **options):
                sink = options['stdout']
                self.sinks.append(sink)
                sink.write(b'private partial native metadata')
                raise error
            self.observer.run = failed
            with patch.object(proof, 'GuestServiceObserver', return_value=self.observer):
                with self.assertRaisesRegex(fixtures.installer.InstallError, '^guest-endpoint-unconfirmed$'):
                    fixtures.installer.assert_guest_endpoint(self.configuration)
            self.assertTrue(all(sink.closed for sink in self.sinks))

    def test_conflict_before_new_journal_or_worker_stop_preserves_every_original_byte(self):
        fixture = fixtures.WorkerInstallFixture()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.configuration['guestPort'] = 4320
        actual = fixtures.installer.assert_guest_endpoint
        with fixture.isolated_activation(), patch.object(fixtures.installer, 'assert_guest_endpoint', wraps=actual), \
                patch.object(proof, 'GuestServiceObserver', return_value=self.observer):
            with self.assertRaisesRegex(fixtures.installer.InstallError, '^guest-endpoint-conflict$'):
                fixture.activate()
        self.assertEqual(fixture.calls, [])
        self.assertEqual(fixture.state.read_bytes(), fixture.original)
        self.assertFalse((fixture.home / 'dant/install-attempt.json').exists())

    def test_go_version_alone_cannot_confirm_guest_ready(self):
        configuration = dict(self.configuration, port=4317, version='0.4.7-beta.20', commit='a' * 40)
        session = {'product': 'dant', 'mode': 'worker', 'runtime': 'go', 'protocol': 1,
                   'version': configuration['version'], 'source': configuration['commit'], 'token': 'fixture'}
        class Opener:
            def open(self, request, timeout):
                return io.BytesIO(json.dumps(session if isinstance(request, str) else {'version': configuration['version']}).encode())
        with patch.object(fixtures.installer, 'local_opener', return_value=Opener()), \
                patch.object(proof, 'GuestServiceObserver', return_value=self.observer):
            self.assertFalse(fixtures.installer.ready(configuration))
            self.write_process(self.candidate, self.user_environment(), 4321, proof.USER_UNIT)
            self.namespace_listener(inode='99')
            self.assertTrue(fixtures.installer.ready(configuration))

    def test_ready_requires_the_same_owned_socket_in_the_worker_network_namespace(self):
        for mode in ('private-network', 'foreign-inode', 'wildcard', 'namespace-change'):
            with self.subTest(mode=mode):
                self.setUp()
                self.write_process(self.candidate, self.user_environment(), 4321, proof.USER_UNIT)
                if mode == 'foreign-inode':
                    self.namespace_listener(inode='200')
                elif mode == 'wildcard':
                    self.namespace_listener(inode='99', address='00000000')
                elif mode == 'namespace-change':
                    self.namespace_listener(inode='99')
                    original = self.observer.candidate_listeners
                    calls = []
                    def changed(configuration):
                        calls.append(True)
                        if len(calls) == 2:
                            self.namespace_listener(inode='200')
                        return original(configuration)
                    self.observer.candidate_listeners = changed
                with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                    self.observer.user_ready(self.configuration)

    def test_special_files_and_replacements_are_rejected_before_any_blocking_read(self):
        file = self.root / 'regular-source'
        file.write_bytes(b'bounded')
        admitted = file.lstat()
        special = types.SimpleNamespace(st_mode=stat.S_IFIFO, st_nlink=1)
        with patch.object(pathlib.Path, 'lstat', return_value=special), \
                patch.object(proof.os, 'open') as opened:
            with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                proof.read_bounded(file, 20)
        opened.assert_not_called()

        real_open = proof.os.open
        descriptors = []
        def capture(path, flags):
            self.assertEqual(flags & getattr(os, 'O_NONBLOCK', 0), getattr(os, 'O_NONBLOCK', 0))
            descriptor = real_open(path, flags)
            descriptors.append(descriptor)
            return descriptor
        for mode in ('fifo-replacement', 'regular-replacement', 'changed-during-read'):
            with self.subTest(mode=mode):
                observations = []
                def observed(descriptor):
                    observations.append(descriptor)
                    if mode == 'fifo-replacement':
                        return special
                    values = {name: getattr(admitted, name) for name in (
                        'st_mode', 'st_nlink', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns')}
                    if mode == 'regular-replacement' or len(observations) == 2:
                        values['st_ino'] += 1
                    return types.SimpleNamespace(**values)
                with patch.object(proof.os, 'open', side_effect=capture), \
                        patch.object(proof.os, 'fstat', side_effect=observed):
                    with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                        proof.read_bounded(file, 20)
                with self.assertRaises(OSError):
                    os.fstat(descriptors[-1])

    def test_foreign_candidate_listener_blocks_before_journal_and_worker_stop(self):
        self.namespace_listener()
        self.user.update(LoadState='not-found', ActiveState='inactive', MainPID='0', ControlGroup='')
        fixture = fixtures.WorkerInstallFixture()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.configuration['guestPort'] = 4321
        actual = fixtures.installer.assert_guest_endpoint
        with fixture.isolated_activation(), patch.object(fixtures.installer, 'assert_guest_endpoint', wraps=actual), \
                patch.object(proof, 'GuestServiceObserver', return_value=self.observer):
            with self.assertRaisesRegex(fixtures.installer.InstallError, '^guest-endpoint-conflict$'):
                fixture.activate()
        self.assertEqual(fixture.calls, [])
        self.assertEqual(fixture.state.read_bytes(), fixture.original)
        self.assertFalse((fixture.home / 'dant/install-attempt.json').exists())

    def test_candidate_listener_may_only_belong_to_the_confirmed_restartable_user_unit(self):
        for mode in ('owned', 'foreign-inode', 'source', 'environment', 'pid-listener',
                     'unit-change', 'pid-reuse', 'namespace-change'):
            with self.subTest(mode=mode):
                self.setUp()
                self.namespace_listener()
                self.current_user_listener()
                if mode == 'foreign-inode':
                    self.namespace_listener(inode='200')
                elif mode == 'source':
                    self.candidate.write_bytes(b'unknown current helper')
                elif mode == 'environment':
                    self.user['Environment'] = 'DANT_GUEST_PORT=4320'
                elif mode == 'pid-listener':
                    (self.proc / '456/net/tcp').write_text('header\n')
                elif mode in ('unit-change', 'pid-reuse'):
                    original = self.observer.run
                    def changed(command, **options):
                        if len(self.calls) == 3:
                            if mode == 'unit-change':
                                self.user['MainPID'] = '457'
                            else:
                                file = self.proc / '456/stat'
                                file.write_text(file.read_text().replace('234', '235'))
                        return original(command, **options)
                    self.observer.run = changed
                elif mode == 'namespace-change':
                    original = self.observer.candidate_listeners
                    calls = []
                    def changed(configuration):
                        calls.append(True)
                        if len(calls) == 2:
                            self.namespace_listener(inode='200')
                        return original(configuration)
                    self.observer.candidate_listeners = changed
                if mode == 'owned':
                    self.observer.system_available(self.configuration)
                else:
                    with self.assertRaisesRegex(proof.GuestProofError, 'guest-endpoint-(conflict|unconfirmed)'):
                        self.observer.system_available(self.configuration)

    def test_unrelated_namespace_addresses_and_ports_do_not_require_user_process_inspection(self):
        self.namespace_listener(port=5480)
        self.observer.system_available(self.configuration)
        self.namespace_listener(address='0200007F')
        self.observer.system_available(self.configuration)
        self.assertTrue(all('--user' not in command for command in self.calls))


if __name__ == '__main__':
    unittest.main()
