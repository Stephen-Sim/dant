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

    def bus_replies(self, user=False, object_reply=None, property_reply=b'a(sb) 0\n',
                    object_code=0, property_code=0, error=None):
        object_path = '/org/freedesktop/systemd1/unit/fixture_2dguest_2eservice'
        if object_reply is None:
            object_reply = ('o "' + object_path + '"\n').encode()
        scope = '--user' if user else '--system'
        unit = proof.USER_UNIT if user else proof.SYSTEM_UNIT
        prefix = ['busctl', scope, '--no-pager']
        calls = {
            tuple(prefix + ['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
                            'org.freedesktop.systemd1.Manager', 'GetUnit', 's', unit]): (object_reply, object_code),
            tuple(prefix + ['get-property', 'org.freedesktop.systemd1', object_path,
                            'org.freedesktop.systemd1.Service', 'EnvironmentFiles']): (property_reply, property_code),
        }
        def run(command, **options):
            if command[0] == 'systemctl':
                return self.fake_run(command, **options)
            self.calls.append(command)
            sink = options.pop('stdout')
            self.sinks.append(sink)
            self.assertFalse(sink.closed)
            self.assertEqual(options, {'stdin': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL,
                                       'timeout': proof.SERVICE_TIMEOUT, 'check': False})
            self.assertIn(tuple(command), calls)
            if error is not None:
                raise error
            raw, code = calls[tuple(command)]
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

    def current_candidate_listener(self):
        self.current_user_listener()
        self.configuration['entries']['vm/guest.py']['sha256'] = hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        self.namespace_listener(inode='100')

    def test_disappearing_unrelated_descriptor_keeps_the_verified_guest_listener(self):
        self.current_candidate_listener()
        descriptor = self.proc / '456/fd/7'
        readlink = self.observer.readlink
        disappeared = []

        def closed(path):
            if path == descriptor:
                descriptor.unlink()
                disappeared.append(path)
                raise FileNotFoundError('synthetic connection closed after enumeration')
            return readlink(path)

        self.observer.readlink = closed
        for check in (self.observer.system_available, self.observer.user_ready):
            with self.subTest(check=check.__name__):
                descriptor.write_bytes(b'unrelated connection descriptor')
                check(self.configuration)
        self.assertEqual(disappeared, [descriptor, descriptor])

    def observe_volatile_table_metadata(self, fields, names):
        self.current_candidate_listener()
        real_open, real_fstat = proof.os.open, proof.os.fstat
        tables = {}
        observations = []

        def opened(path, flags, *arguments, **options):
            descriptor = real_open(path, flags, *arguments, **options)
            tables[descriptor] = pathlib.Path(path).name in names
            return descriptor

        def observed(descriptor):
            actual = real_fstat(descriptor)
            if not tables.get(descriptor):
                return actual
            observations.append(descriptor)
            values = {name: getattr(actual, name) for name in (
                'st_mode', 'st_nlink', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns')}
            for field in fields:
                values[field] += len(observations)
            return types.SimpleNamespace(**values)

        with patch.object(proof.os, 'open', side_effect=opened), patch.object(proof.os, 'fstat', side_effect=observed):
            self.observer.system_available(self.configuration)
            self.observer.user_ready(self.configuration)
        self.assertGreater(len(observations), 4)

    def test_volatile_proc_table_metadata_keeps_verified_listener_ownership(self):
        self.observe_volatile_table_metadata(('st_size', 'st_mtime_ns'), ('tcp', 'tcp6'))

    def test_tcp6_mtime_refresh_keeps_the_same_opened_table_and_guest_owner(self):
        self.observe_volatile_table_metadata(('st_mtime_ns',), ('tcp6',))

    def test_proc_table_inode_type_and_link_changes_remain_unconfirmed(self):
        file = self.process / 'net/tcp'
        original_lstat, original_fstat, original_open = pathlib.Path.lstat, proof.os.fstat, proof.os.open

        for boundary in ('admitted', 'opened', 'after-read', 'named-after'):
            for field in ('st_dev', 'st_ino', 'st_mode', 'st_nlink'):
                with self.subTest(boundary=boundary, field=field):
                    named, held, descriptors = [], [], []

                    def changed(actual):
                        values = {name: getattr(actual, name) for name in (
                            'st_mode', 'st_nlink', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns')}
                        if field == 'st_mode':
                            values[field] = stat.S_IFIFO
                        else:
                            values[field] += 1
                        return types.SimpleNamespace(**values)

                    def named_info(path, *arguments, **options):
                        actual = original_lstat(path, *arguments, **options)
                        named.append(path)
                        if (boundary == 'admitted' and len(named) == 1) or (boundary == 'named-after' and len(named) == 2):
                            return changed(actual)
                        return actual

                    def held_info(descriptor):
                        actual = original_fstat(descriptor)
                        held.append(descriptor)
                        if (boundary == 'opened' and len(held) == 1) or (boundary == 'after-read' and len(held) == 2):
                            return changed(actual)
                        return actual

                    def opened(path, flags):
                        self.assertEqual(flags & getattr(os, 'O_NOFOLLOW', 0), getattr(os, 'O_NOFOLLOW', 0))
                        self.assertEqual(flags & getattr(os, 'O_NONBLOCK', 0), getattr(os, 'O_NONBLOCK', 0))
                        descriptor = original_open(path, flags)
                        descriptors.append(descriptor)
                        return descriptor

                    with patch.object(pathlib.Path, 'lstat', named_info), patch.object(proof.os, 'fstat', side_effect=held_info), \
                            patch.object(proof.os, 'open', side_effect=opened):
                        with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                            proof.read_socket_table(file)
                    for descriptor in descriptors:
                        with self.assertRaises(OSError):
                            original_fstat(descriptor)

    def test_proc_table_bounds_names_and_regular_file_metadata_are_not_relaxed(self):
        table = self.process / 'net/tcp'
        with patch.object(proof, 'SOCKET_BYTES', 3):
            with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                proof.read_socket_table(table)
        with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
            proof.read_socket_table(self.process / 'stat')
        with patch.object(proof.os, 'open', side_effect=PermissionError('synthetic table denial')):
            with self.assertRaises(PermissionError):
                proof.read_socket_table(table)
        actual_fstat = proof.os.fstat

        def metadata_changed(descriptor):
            actual = actual_fstat(descriptor)
            values = {name: getattr(actual, name) for name in (
                'st_mode', 'st_nlink', 'st_dev', 'st_ino', 'st_size', 'st_mtime_ns')}
            values['st_mtime_ns'] += 1
            return types.SimpleNamespace(**values)

        for path in (self.seed, self.process / 'stat', self.process / 'environ'):
            with self.subTest(file=path.name), patch.object(proof.os, 'fstat', side_effect=metadata_changed):
                with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                    proof.read_bounded(path, proof.SCRIPT_BYTES)

    def test_a_disappearing_owned_listener_never_proves_endpoint_ownership(self):
        self.current_candidate_listener()
        descriptor = self.proc / '456/fd/3'
        readlink = self.observer.readlink

        def closed(path):
            if path == descriptor:
                descriptor.unlink()
                raise FileNotFoundError('synthetic listener closed after enumeration')
            return readlink(path)

        self.observer.readlink = closed
        checks = ((self.observer.system_available, 'guest-endpoint-conflict'),
                  (self.observer.user_ready, 'guest-endpoint-unconfirmed'))
        for check, code in checks:
            with self.subTest(check=check.__name__):
                descriptor.write_bytes(b'owned listener descriptor')
                with self.assertRaisesRegex(proof.GuestProofError, '^' + code + '$'):
                    check(self.configuration)

    def test_descriptor_permission_and_other_errors_remain_unconfirmed(self):
        self.current_candidate_listener()
        descriptor = self.proc / '456/fd/7'
        descriptor.write_bytes(b'unreadable descriptor')
        readlink = self.observer.readlink

        for error in (PermissionError('synthetic denial'), OSError('synthetic read failure'),
                      ProcessLookupError('synthetic process lookup failure')):
            with self.subTest(error=type(error).__name__):
                def denied(path):
                    if path == descriptor:
                        raise error
                    return readlink(path)

                self.observer.readlink = denied
                with self.assertRaises(type(error)):
                    self.observer.system_available(self.configuration)

    def test_a_disappearing_descriptor_does_not_hide_process_or_listener_changes(self):
        self.current_candidate_listener()
        descriptor = self.proc / '456/fd/7'
        process_stat = self.proc / '456/stat'
        original_stat = process_stat.read_bytes()
        readlink = self.observer.readlink

        for change in ('process', 'listener'):
            with self.subTest(change=change):
                descriptor.write_bytes(b'unrelated connection descriptor')

                def changed(path):
                    if path == descriptor:
                        descriptor.unlink()
                        if change == 'process':
                            process_stat.write_bytes(original_stat.replace(b'234', b'235'))
                        else:
                            self.namespace_listener(inode='200')
                        raise FileNotFoundError('synthetic connection closed after enumeration')
                    return readlink(path)

                self.observer.readlink = changed
                with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                    self.observer.system_available(self.configuration)
                process_stat.write_bytes(original_stat)
                self.namespace_listener(inode='100')

    def test_exact_historical_source_and_owned_legacy_socket_allow_new_default(self):
        self.assertIn(hashlib.sha256(self.seed.read_bytes()).hexdigest(), proof.KNOWN_SEED_SOURCES)
        self.observer.system_available(self.configuration)
        self.assertEqual(len(self.calls), 2)
        self.configuration['guestPort'] = 4320
        with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-conflict$'):
            self.observer.system_available(self.configuration)

    def test_foundation_seed_still_requires_runtime_socket_ownership_and_exact_source(self):
        historical = (ROOT / 'tests/vm/fixtures/legacy-guest-foundation.txt').read_bytes()
        self.assertEqual(hashlib.sha256(historical).hexdigest(),
                         '7826248268557a23c549addc0de0a8ec22933efde2b04528fa06f7daa70c31a5')
        self.seed.write_bytes(historical)
        observed_port = 5481
        self.write_process(self.seed, {}, observed_port, proof.SYSTEM_UNIT)
        self.observer.system_available(self.configuration)
        self.configuration['guestPort'] = observed_port
        with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-conflict$'):
            self.observer.system_available(self.configuration)
        self.configuration['guestPort'] = 4321
        self.links['3'] = 'socket:[88]'
        with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
            self.observer.system_available(self.configuration)
        self.links['3'] = 'socket:[99]'
        self.seed.write_bytes(historical + b'\n# unrecognized modification\n')
        with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
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

    def test_systemd_255_omitted_empty_array_requires_typed_bus_proof(self):
        self.system.pop('EnvironmentFiles')
        self.observer.run = self.bus_replies()
        self.observer.system_available(self.configuration)
        bus_calls = [command for command in self.calls if command[0] == 'busctl']
        self.assertEqual(len(bus_calls), 4)
        self.assertEqual(sum('GetUnit' in command for command in bus_calls), 2)

    def test_omitted_empty_array_uses_the_user_bus_for_user_ready(self):
        self.write_process(self.candidate, self.user_environment(), 4321, proof.USER_UNIT)
        self.namespace_listener(inode='99')
        self.user.pop('EnvironmentFiles')
        self.observer.run = self.bus_replies(user=True)
        self.observer.user_ready(self.configuration)
        self.assertTrue(all(command[1] == '--user' for command in self.calls if command[0] == 'busctl'))

    def test_absent_unit_needs_complete_inactive_proof_without_querying_a_missing_service(self):
        self.system.update(LoadState='not-found', ActiveState='inactive', MainPID='0', ControlGroup='')
        self.system.pop('EnvironmentFiles')
        self.observer.system_available(self.configuration)
        self.assertTrue(all(command[0] == 'systemctl' for command in self.calls))

    def test_missing_array_never_accepts_failed_unknown_or_nonempty_bus_properties(self):
        cases = (
            {'object_code': 1},
            {'object_reply': b''},
            {'object_reply': b's "/org/freedesktop/systemd1/unit/foreign"\n'},
            {'object_reply': b'o "/private/path"\n'},
            {'object_reply': b'o "/org/freedesktop/systemd1/unit/foreign" extra\n'},
            {'object_reply': b'o "unterminated'},
            {'object_reply': b'\xff'},
            {'object_reply': b'x' * (proof.SERVICE_BYTES + 1)},
            {'property_code': 1},
            {'property_reply': b''},
            {'property_reply': b's ""\n'},
            {'property_reply': b'a(sb) 1 "/private-env" false\n'},
            {'property_reply': b'a(sb) 00\n'},
            {'property_reply': b'a(sb) 0 extra\n'},
            {'property_reply': b'x' * (proof.SERVICE_BYTES + 1)},
        )
        self.system.pop('EnvironmentFiles')
        for index, replies in enumerate(cases):
            with self.subTest(case=index):
                self.observer.run = self.bus_replies(**replies)
                with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                    self.observer.system_available(self.configuration)

    def test_unavailable_bus_proofs_keep_the_fixed_error_and_close_captures(self):
        self.system.pop('EnvironmentFiles')
        for error in (FileNotFoundError('private executable'), PermissionError('private path'),
                      subprocess.TimeoutExpired('private command', proof.SERVICE_TIMEOUT)):
            with self.subTest(error=type(error).__name__):
                self.observer.run = self.bus_replies(error=error)
                with patch.object(proof, 'GuestServiceObserver', return_value=self.observer):
                    with self.assertRaisesRegex(fixtures.installer.InstallError, '^guest-endpoint-unconfirmed$'):
                        fixtures.installer.assert_guest_endpoint(self.configuration)
                self.assertTrue(all(sink.closed for sink in self.sinks))

    def test_missing_array_does_not_weaken_invalid_or_incomplete_unit_snapshots(self):
        cases = (
            {'LoadState': 'future'},
            {'ActiveState': 'activating'},
            {'MainPID': 'invalid'},
            {'LoadState': 'not-found', 'ActiveState': 'inactive', 'MainPID': '1', 'ControlGroup': ''},
            {'LoadState': 'not-found', 'ActiveState': 'active', 'MainPID': '0', 'ControlGroup': ''},
            {'LoadState': 'not-found', 'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': '/foreign'},
            {'LoadState': 'not-found', 'ActiveState': 'inactive', 'MainPID': '0', 'ControlGroup': '',
             'Environment': 'PRIVATE=value'},
            {'Unexpected': ''},
        )
        for index, changes in enumerate(cases):
            with self.subTest(case=index):
                self.system = dict(self.service(proof.SYSTEM_UNIT), **changes)
                self.system.pop('EnvironmentFiles')
                self.observer.run = self.fake_run
                with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
                    self.observer.system_available(self.configuration)
        self.system = self.service(proof.SYSTEM_UNIT)
        self.system.pop('EnvironmentFiles')
        self.system.pop('Environment')
        with self.assertRaisesRegex(proof.GuestProofError, '^guest-endpoint-unconfirmed$'):
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
