"""Configuration contracts; no desktop, network listener or VM is started."""
import importlib.util
import json
import pathlib
import runpy
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))
spec = importlib.util.spec_from_file_location('guest_config_test', ROOT / 'vm/guest.py')
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class GuestConfigurationTests(unittest.TestCase):
    def test_shared_protocol_defaults_match_worker_endpoint_and_paths(self):
        protocol = json.loads((ROOT / 'resources/config/protocol.json').read_text(encoding='utf-8'))
        self.assertEqual(guest.guest_bind({}), ('127.0.0.1', protocol['guestPort']))
        self.assertEqual(guest.PROTOCOL, protocol)
        self.assertEqual(guest.PATHS['health'], '/health')
        self.assertEqual(guest.PATHS['screen'], '/screen')

    def test_environment_overrides_accept_only_exact_loopback_and_valid_ports(self):
        self.assertEqual(guest.guest_bind({'DANT_GUEST_HOST': 'localhost', 'DANT_GUEST_PORT': '5480'}), ('localhost', 5480))
        self.assertEqual(guest.guest_bind({'DANT_GUEST_HOST': '', 'DANT_GUEST_PORT': ''}), ('127.0.0.1', guest.PROTOCOL['guestPort']))
        self.assertEqual(guest.guest_bind({'DANT_GUEST_PORT': '4320'}), ('127.0.0.1', 4320))
        for host in ('0.0.0.0', '192.0.2.1', 'localhost.evil', 'localhost.', '127.1', 'http://localhost', '::1', ' localhost', False, None, {}):
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, 'DANT_GUEST_HOST must be'):
                guest.guest_bind({'DANT_GUEST_HOST': host})
        for port in ('0', '-1', '65536', '4320.0', '+4320', '04320', ' 4320', '4320 ', '4e3', 'private-test-sentinel', True, False, None, 0, 4320):
            with self.subTest(port=port), self.assertRaisesRegex(ValueError, '^DANT_GUEST_PORT must be an integer from 1 to 65535$'):
                guest.guest_bind({'DANT_GUEST_PORT': port})

    def test_main_uses_configured_bind_without_starting_a_real_listener(self):
        server = Mock()
        with patch.dict(guest.os.environ, {'DANT_GUEST_HOST': 'localhost', 'DANT_GUEST_PORT': '5480'}, clear=True), patch.object(guest, 'ROOT') as output, patch.object(guest, 'HTTPServer', return_value=server) as factory:
            guest.main()
        factory.assert_called_once_with(('localhost', 5480), guest.Handler)
        output.mkdir.assert_called_once_with(parents=True, exist_ok=True)
        server.serve_forever.assert_called_once_with()

    def test_installed_helper_reads_the_deployed_protocol_and_missing_config_fails_closed(self):
        folder_root = ROOT / '.cache/tests'
        folder_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='guest-config-', dir=folder_root) as temporary:
            home = pathlib.Path(temporary)
            helper = home / 'vm/guest.py'
            with patch.object(guest, '__file__', str(helper)), self.assertRaisesRegex(RuntimeError, 'configuration is missing'):
                guest.load_protocol()
            config = home / 'app/resources/config/protocol.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps(guest.PROTOCOL), encoding='utf-8')
            with patch.object(guest, '__file__', str(helper)):
                self.assertEqual(guest.load_protocol(), guest.PROTOCOL)

    def test_guest_file_root_uses_current_home_without_changing_seed_account_contract(self):
        for home in (pathlib.Path('/home/dant'), pathlib.Path('/home/another-user')):
            with self.subTest(default=home.name == 'dant'), patch.object(pathlib.Path, 'home', return_value=home):
                namespace = runpy.run_path(str(ROOT / 'vm/guest.py'), run_name='guest_home_fixture')
            self.assertEqual(namespace['ROOT'], home / 'work')


if __name__ == '__main__':
    unittest.main()
