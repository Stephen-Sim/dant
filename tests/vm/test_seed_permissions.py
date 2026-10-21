"""Real seed ISO output with synthetic SSH public-key text, never a VM."""
import io
import importlib.util
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPENDENCY = ROOT / '.tools/python'
if DEPENDENCY.is_dir():
    sys.path.insert(0, str(DEPENDENCY))
import pycdlib


class SeedPermissionTests(unittest.TestCase):
    def test_invalid_public_key_never_creates_seed_and_explicit_sudo_is_recorded(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = pathlib.Path(temporary) / 'data'
            cache = pathlib.Path(temporary) / 'cache'
            data.mkdir()
            public = data / 'vm-key.pub'
            public.write_text('invalid synthetic public key')
            command = [sys.executable, str(ROOT / 'scripts/seed.py'), str(ROOT), 'true',
                '--data-directory', str(data), '--cache-directory', str(cache)]
            environment = dict(os.environ)
            if DEPENDENCY.exists():
                environment['PYTHONPATH'] = str(DEPENDENCY)
            rejected = subprocess.run(command, env=environment, capture_output=True, timeout=30)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse((cache / 'seed.iso').exists())
            self.assertFalse((cache / 'seed-summary.json').exists())
            public.write_text('ssh-ed25519 AAAAsynthetic fixture')
            created = subprocess.run(command, env=environment, capture_output=True, timeout=30)
            self.assertEqual(created.returncode, 0, created.stderr.decode())
            summary = json.loads((cache / 'seed-summary.json').read_bytes())
            self.assertIs(summary['adminSudo'], True)
            self.assertEqual(summary['resourceDefaults'], {'cpu': 4, 'memoryGB': 8, 'diskGB': 64})
            self.assertTrue({'cpu', 'memoryGB', 'diskGB'}.isdisjoint(summary))
            iso = pycdlib.PyCdlib()
            iso.open(str(cache / 'seed.iso'))
            try:
                output = io.BytesIO()
                iso.get_file_from_iso_fp(output, joliet_path='/user-data')
                configuration = json.loads(output.getvalue().split(b'\n', 1)[1])
                self.assertEqual(configuration['users'][0]['sudo'], 'ALL=(ALL) NOPASSWD:ALL')
                self.assertIs(configuration['ssh_pwauth'], False)
                self.assertIs(configuration['disable_root'], True)
                self.assertIs(configuration['users'][0]['lock_passwd'], True)
                files = {entry['path']: entry for entry in configuration['write_files']}
                protocol_entry = files['/opt/dant/resources/config/protocol.json']
                self.assertEqual(protocol_entry['permissions'], '0644')
                self.assertEqual(json.loads(protocol_entry['content']), json.loads(
                    (ROOT / 'resources/config/protocol.json').read_text(encoding='utf-8')))
                protocol = json.loads(protocol_entry['content'])
                bootstrap_unit = files['/etc/systemd/system/dant-guest.service']['content']
                bootstrap_environment = dict(line.removeprefix('Environment=').split('=', 1)
                    for line in bootstrap_unit.splitlines() if line.startswith('Environment='))
                self.assertEqual(bootstrap_environment['DANT_GUEST_HOST'], protocol['loopbackHost'])
                self.assertEqual(bootstrap_environment['DANT_GUEST_PORT'], str(protocol['bootstrapGuestPort']))
                self.assertNotEqual(protocol['bootstrapGuestPort'], protocol['guestPort'])

                spec = importlib.util.spec_from_file_location('seed_worker_units', ROOT / 'vm/worker-install.py')
                installer = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(installer)
                worker_unit = installer.service_units({'guestHost': protocol['loopbackHost'],
                    'guestPort': protocol['guestPort'], 'port': protocol['apiPort'],
                    'source': pathlib.Path(temporary) / 'source.seed-fixture'})['dant-guest-local.service'].decode()
                worker_environment = dict(line.removeprefix('Environment=').split('=', 1)
                    for line in worker_unit.splitlines() if line.startswith('Environment='))
                self.assertEqual(worker_environment['DANT_GUEST_PORT'], str(protocol['guestPort']))

                # cloud-init's flat /opt/dant layout must initialize before a
                # Worker release or ~/dant/app exists. Replay only the ISO's
                # Python imports and bind selection, never start a service.
                seed_root = pathlib.Path(temporary) / 'opt/dant'
                for name, entry in files.items():
                    if name.startswith('/opt/dant/'):
                        destination = seed_root / name.removeprefix('/opt/dant/')
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_text(entry['content'], encoding='utf-8')
                modules = {name: sys.modules.pop(name) for name in ('network_config', 'desktop', 'control')
                           if name in sys.modules}
                fixture_home = pathlib.Path(temporary) / 'home/dant'
                try:
                    with patch.object(sys, 'path', [str(seed_root), *sys.path]), \
                            patch.dict(os.environ, bootstrap_environment, clear=True), \
                            patch.object(pathlib.Path, 'home', return_value=fixture_home):
                        namespace = runpy.run_path(str(seed_root / 'guest.py'), run_name='seed_guest_fixture')
                        self.assertEqual(namespace['ROOT'], fixture_home / 'work')
                        self.assertEqual(namespace['guest_bind'](), (protocol['loopbackHost'], protocol['bootstrapGuestPort']))
                        server = Mock()
                        factory = Mock(return_value=server)
                        with patch.dict(namespace['main'].__globals__, {'HTTPServer': factory,
                                'ROOT': Mock()}):
                            namespace['main']()
                            with patch.dict(os.environ, worker_environment, clear=True):
                                namespace['main']()
                        self.assertEqual(factory.call_args_list[0].args[0], (protocol['loopbackHost'], protocol['bootstrapGuestPort']))
                        self.assertEqual(factory.call_args_list[1].args[0], (protocol['loopbackHost'], protocol['guestPort']))
                        self.assertEqual(server.serve_forever.call_count, 2)
                        with patch.object(pathlib.Path, 'home', return_value=pathlib.Path('/home/dant')):
                            bootstrap_control = sys.modules['control'].control_path()
                        self.assertEqual(bootstrap_control, pathlib.Path(worker_environment['DANT_CONTROL_FILE'].replace('%h', '/home/dant')))
                        self.assertEqual(sys.modules['network_config'].PROTOCOL,
                                         json.loads(protocol_entry['content']))
                finally:
                    for name in ('network_config', 'desktop', 'control'):
                        sys.modules.pop(name, None)
                    sys.modules.update(modules)
            finally:
                iso.close()


if __name__ == '__main__':
    unittest.main()
