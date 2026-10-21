"""Shared protocol boundaries with isolated files and fake HTTP transports."""

import copy
import importlib.util
import io
import json
import os
import pathlib
import runpy
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))
import network_config as network


class NetworkConfigurationTests(unittest.TestCase):
    def write_protocol(self, root, value=None):
        path = root / network.PROTOCOL_RESOURCE
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(network.PROTOCOL if value is None else value), encoding='utf-8')
        return path

    def test_layouts_load_same_protocol_and_invalid_existing_file_cannot_fall_back(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            for layout, helper in (('flat', 'network_config.py'), ('checkout', 'vm/guest.py'),
                                   ('installed', 'vm/desktop_mcp.py')):
                with self.subTest(layout=layout):
                    location = root / layout
                    target = location / 'app' if layout == 'installed' else location
                    self.write_protocol(target)
                    self.assertEqual(network.load_protocol(location / helper), network.PROTOCOL)
            self.write_protocol(root)
            invalid = root / 'vm/resources/config/protocol.json'
            invalid.parent.mkdir(parents=True)
            invalid.write_text('{}')
            with self.assertRaises(ValueError):
                network.load_protocol(root / 'vm/guest.py')
            with self.assertRaisesRegex(RuntimeError, 'configuration is missing'):
                network.load_protocol(root / 'missing/deeper/helper.py')

    def test_schema_rejects_noncanonical_hosts_ports_paths_and_duplicate_keys(self):
        changes = [[], {}, {'unexpected': True}]
        for field, value in (
            ('loopbackHost', {}), ('loopbackHost', '192.0.2.1'),
            ('loopbackHost', 'localhost'),
            ('loopbackHosts', '127.0.0.1'), ('loopbackHosts', [False, 'localhost']),
            ('loopbackHosts', ['127.0.0.1', '127.0.0.1']), ('loopbackHosts', ['127.0.0.1']),
            ('apiPort', True), ('apiPort', 0), ('apiPort', 65536),
            ('apiPort', network.PROTOCOL['guestPort']), ('paths', []),
            ('paths', {'screen': '/screen'}),
        ):
            value_protocol = copy.deepcopy(network.PROTOCOL)
            value_protocol[field] = value
            changes.append(value_protocol)
        for port in (network.PROTOCOL['apiPort'], network.PROTOCOL['devPort'], network.PROTOCOL['guestPort'],
                     True, 0, 65536, '4319'):
            value_protocol = copy.deepcopy(network.PROTOCOL)
            value_protocol['bootstrapGuestPort'] = port
            changes.append(value_protocol)
        for value in ('//evil', '/screen?secret', 'http://invalid', None, '/', '/' + 'a' * 128,
                      '/é', '/screen/', '/screen space', network.PROTOCOL['paths']['health']):
            value_protocol = copy.deepcopy(network.PROTOCOL)
            value_protocol['paths']['screen'] = value
            changes.append(value_protocol)
        for name in ('session', 'version', 'state'):
            value_protocol = copy.deepcopy(network.PROTOCOL)
            value_protocol['paths'][name] = '/other/' + name
            changes.append(value_protocol)

        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / 'protocol.json'
            for value in changes:
                with self.subTest(value=value):
                    path.write_text(json.dumps(value), encoding='utf-8')
                    with self.assertRaises(ValueError):
                        network.read_protocol(path)
            for raw in (b'{', b'\xff', b'{"loopbackHost":"localhost","loopbackHost":"127.0.0.1"}'):
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    network.read_protocol(path)

            valid = copy.deepcopy(network.PROTOCOL)
            valid['paths']['screen'] = '/Api_0/SCREEN-9'
            path.write_text(json.dumps(valid), encoding='utf-8')
            self.assertEqual(network.read_protocol(path), valid)
            valid['paths']['screen'] = '/' + 'a' * 127
            path.write_text(json.dumps(valid), encoding='utf-8')
            self.assertEqual(network.read_protocol(path), valid)

    def test_regular_single_link_bounded_stable_file_is_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            path = self.write_protocol(root)
            linked = root / 'linked.json'
            os.link(path, linked)
            with self.assertRaisesRegex(ValueError, 'file is invalid'):
                network.read_protocol(path)
            linked.unlink()
            path.write_bytes(b' ' * (network.MAX_PROTOCOL_BYTES + 1))
            with self.assertRaisesRegex(ValueError, 'file is invalid'):
                network.read_protocol(path)
            with self.assertRaisesRegex(ValueError, 'file is invalid'):
                network.read_protocol(root)

            self.write_protocol(root)
            before = path.stat()
            changed = types.SimpleNamespace(st_dev=before.st_dev, st_ino=before.st_ino + 1,
                st_size=before.st_size, st_mtime_ns=before.st_mtime_ns)
            with patch.object(network.os, 'fstat', return_value=changed):
                with self.assertRaisesRegex(ValueError, 'changed'):
                    network.read_protocol(path)
            with patch.object(network.os, 'fstat', side_effect=[before, changed]):
                with self.assertRaisesRegex(ValueError, 'changed'):
                    network.read_protocol(path)
            with patch.object(network.pathlib.Path, 'lstat', side_effect=[before, changed]):
                changed.st_mode, changed.st_nlink = stat.S_IFREG, 1
                with self.assertRaisesRegex(ValueError, 'changed'):
                    network.read_protocol(path)

    def test_screen_check_uses_shared_guest_endpoint_and_never_proxy_or_redirect(self):
        opener = Mock()
        opener.open.return_value = io.BytesIO(network.PNG_SIGNATURE + b'fixture')
        with patch.object(network.urllib.request, 'build_opener', return_value=opener) as build:
            network.screen_check({'DANT_GUEST_HOST': 'localhost', 'DANT_GUEST_PORT': '5480'})
        handlers = build.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], network.NoRedirect)
        self.assertIsNone(handlers[1].redirect_request(None, None, 302, '', {}, 'http://invalid'))
        opener.open.assert_called_once_with('http://localhost:5480/screen', timeout=10)

        opener.open.return_value = io.BytesIO(b'not a PNG')
        with patch.object(network.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'not ready'):
                network.screen_check({})
        with patch.dict(os.environ, {'DANT_PORT': 'private-sentinel'}, clear=True):
            self.assertEqual(network.api_origin(), 'http://127.0.0.1:4317')

    def test_cli_accepts_only_fixed_readonly_screen_operation(self):
        with patch.object(network, 'screen_check') as check, patch.object(network, 'bootstrap_screen_check') as bootstrap:
            network.main(['screen-check'])
            check.assert_called_once_with()
            network.main(['bootstrap-screen-check'])
            bootstrap.assert_called_once_with()
            for arguments in ([], ['screen-check', 'extra'], ['private-sentinel']):
                with self.assertRaisesRegex(ValueError, '^Invalid desktop network helper operation$'):
                    network.main(arguments)

        with patch.object(sys, 'argv', [str(ROOT / 'vm/network_config.py'), 'invalid']):
            with self.assertRaises(ValueError):
                runpy.run_path(str(ROOT / 'vm/network_config.py'), run_name='__main__')

    def test_bootstrap_probe_uses_its_own_validated_port_without_guest_environment_overrides(self):
        protocol = copy.deepcopy(network.PROTOCOL)
        protocol['bootstrapGuestPort'] = 5481
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write_protocol(pathlib.Path(temporary), protocol)
            validated = network.read_protocol(path)
        opener = Mock()
        opener.open.return_value = io.BytesIO(network.PNG_SIGNATURE)
        with patch.object(network, 'PROTOCOL', validated), \
                patch.dict(os.environ, {'DANT_GUEST_HOST': 'localhost', 'DANT_GUEST_PORT': '5480'}, clear=True), \
                patch.object(network.urllib.request, 'build_opener', return_value=opener):
            network.bootstrap_screen_check()
        opener.open.assert_called_once_with('http://127.0.0.1:5481/screen', timeout=10)


if __name__ == '__main__':
    unittest.main()
