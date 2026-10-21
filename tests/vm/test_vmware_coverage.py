"""Additional failure/ownership behavior through the isolated VMware host fixture."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('vmware_boundary_fixture', pathlib.Path(__file__).with_name('test_vmware.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
vm = fixture.vm


class VmwareBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.f = fixture.VmwareTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.p = self.f.provisioner

    def test_metadata_bounds_bad_directory_and_failed_atomic_write_preserve_original(self):
        self.f.data.mkdir()
        target = self.f.data / 'metadata.json'
        for raw in (b'[]', b'x' * (1024 * 1024 + 1)):
            target.write_bytes(raw)
            with self.assertRaises(vm.VmwareError):
                vm.read_json(target)
        target.write_bytes(b'{"preserve":true}')
        with patch.object(vm.os, 'replace', side_effect=OSError('isolated write failure')), self.assertRaises(OSError):
            vm.write_json(target, {'replacement': True})
        self.assertEqual(target.read_bytes(), b'{"preserve":true}')
        self.assertEqual(list(self.f.data.glob('*.tmp')), [])
        with self.assertRaises(vm.VmwareError):
            vm.safe_directory(target / 'child')

    def test_tool_resolution_uses_only_regular_explicit_path_or_known_installation(self):
        binary = self.f.data / 'tool.exe'
        binary.parent.mkdir()
        binary.write_bytes(b'fixture executable; never run')
        self.assertEqual(vm.find_tool('vmrun', str(binary)), str(binary.absolute()))
        with patch.object(vm.shutil, 'which', return_value=str(binary)):
            self.assertEqual(vm.find_tool('vmrun'), str(binary))
        installed = self.f.data / 'VMware/VMware Workstation/vmrun.exe'
        installed.parent.mkdir(parents=True)
        installed.write_bytes(b'fixture executable; never run')
        with patch.object(vm.shutil, 'which', return_value=None), patch.dict(os.environ,
                {'ProgramFiles': str(self.f.data), 'ProgramFiles(x86)': ''}, clear=True):
            self.assertEqual(vm.find_tool('vmrun'), str(installed))

    def test_command_wrapper_uses_argument_array_stdin_closed_and_bounded_output(self):
        with patch.object(vm.subprocess, 'run', return_value='receipt') as process:
            self.assertEqual(vm.run_command(['synthetic', pathlib.Path('a b')], 5, {'FIXTURE': 'true'}), 'receipt')
        process.assert_called_once_with(['synthetic', 'a b'], capture_output=True, text=True,
            stdin=subprocess.DEVNULL, timeout=5, env={'FIXTURE': 'true'}, check=False)
        self.p.runner = Mock(return_value=types.SimpleNamespace(returncode=0, stdout='x' * 9000, stderr=''))
        self.p.log = Mock()
        self.p.command(['synthetic'])
        self.assertEqual(len(self.p.log.call_args.args[0]), 8000)
        self.p.runner.return_value = types.SimpleNamespace(returncode=4, stdout='', stderr='synthetic failure')
        with self.assertRaisesRegex(vm.VmwareError, 'exit 4'):
            self.p.command(['synthetic'], quiet=True)

    def test_empty_download_retains_partial_and_existing_partial_never_contacts_network(self):
        target = self.f.data / 'image'
        target.parent.mkdir()
        partial = target.with_name('image.part')
        partial.write_bytes(b'preserve incomplete')
        with patch.object(vm.urllib.request, 'urlopen') as opening, self.assertRaisesRegex(vm.VmwareError, 'incomplete'):
            vm.download(vm.BASE_URL + vm.IMAGE, target, 100)
        opening.assert_not_called()
        partial.unlink()
        response = io.BytesIO()
        response.headers = {}
        response.geturl = lambda: vm.BASE_URL + vm.IMAGE
        with patch.object(vm.urllib.request, 'urlopen', return_value=response), self.assertRaisesRegex(vm.VmwareError, 'empty'):
            vm.download(vm.BASE_URL + vm.IMAGE, target, 100)
        self.assertTrue(partial.exists())
        self.assertFalse(target.exists())

    def test_vmx_size_comments_invalid_adapter_and_foreign_sparse_extent_fail_closed(self):
        self.f.data.mkdir()
        config = self.f.data / 'dant.vmx'
        config.write_text('# comment\n\nmemsize = "8192"\n')
        self.assertEqual(vm.parse_vmx(config), {'memsize': '8192'})
        config.write_bytes(b'x' * (256 * 1024 + 1))
        with self.assertRaisesRegex(vm.VmwareError, 'size limit'):
            vm.parse_vmx(config)
        with self.assertRaisesRegex(vm.VmwareError, 'network adapter'):
            vm.vmx_settings('fixture', 4, 8, 'unsupported')
        disk = self.f.data / 'dant.vmdk'
        disk.write_bytes(fixture.vmdk('monolithicSparse').replace(b'dant.vmdk', b'evil.vmdk'))
        with self.assertRaisesRegex(vm.VmwareError, 'own single sparse extent'):
            vm.vmdk_info(disk)

    def test_prepare_existing_vm_oversized_sums_and_low_space_stop_before_disk_or_key(self):
        self.p.base.mkdir(parents=True)
        self.p.manifest_path.write_text('{}')
        with self.assertRaisesRegex(vm.VmwareError, 'already exists'):
            self.f.prepare()
        self.p.manifest_path.unlink()
        self.p.cache.mkdir()
        sums = self.p.cache / 'SHA256SUMS'
        sums.write_bytes(b'x' * (256 * 1024 + 1))
        with self.assertRaisesRegex(vm.VmwareError, 'size limit'):
            self.f.prepare()
        sums.unlink()
        self.p.free_space = lambda _: 1
        with self.assertRaisesRegex(vm.VmwareError, '3 GiB'):
            self.f.prepare()
        self.assertFalse(self.p.key.exists())
        self.assertFalse(self.p.disk.exists())

    def test_prepared_identity_and_all_artifact_digests_are_checked_before_creation(self):
        original = self.f.prepare()
        self.f.host.calls.clear()
        for field in ('owner', 'version', 'imageUrl', 'imageSha256', 'seedSha256', 'publicKeySha256'):
            changed = dict(original, **{field: 'foreign'})
            with self.subTest(field=field), self.assertRaises(vm.VmwareError):
                self.p.validate_prepared(changed)
        self.assertEqual(self.f.host.calls, [])

    def test_owned_identity_phase_runtime_directory_disk_identity_and_capacity_are_authoritative(self):
        self.f.prepare()
        self.f.create()
        original = vm.read_json(self.p.manifest_path)
        for changes in ({'id': 'invalid'}, {'phase': 'foreign'}, {'diskIdentity': {'device': 0, 'inode': 0}}, {'diskGB': 64}):
            with self.subTest(changes=tuple(changes)), self.assertRaises(vm.VmwareError):
                self.p.validate_owned(dict(original, **changes))
        with self.p.vmx.open('a') as stream:
            stream.write('workingDir = "elsewhere"\n')
        with self.assertRaisesRegex(vm.VmwareError, 'relocates'):
            self.p.validate_owned(original)

    def test_capacity_mismatch_preserves_building_manifest_without_starting(self):
        self.f.prepare()
        original_run = self.f.host.run
        def conversion(arguments, **options):
            if '-x' in arguments:
                return types.SimpleNamespace(returncode=0, stdout='', stderr='')
            return original_run(arguments, **options)
        self.p.runner = conversion
        with self.assertRaisesRegex(vm.VmwareError, 'capacity does not match'):
            self.f.create()
        self.assertEqual(vm.read_json(self.p.manifest_path)['phase'], 'building')
        self.assertTrue(self.p.disk.exists())
        self.assertFalse(self.p.binding.exists())
        self.assertFalse(any('start' in call for call in self.f.host.calls))

    def test_existing_e1000_repair_is_noop_and_probe_timeout_never_starts_another_vm(self):
        self.f.prepare()
        self.f.create()
        manifest = vm.read_json(self.p.manifest_path)
        self.f.host.calls.clear()
        self.assertEqual(self.p.repair_network(manifest['id']), manifest)
        self.assertEqual(self.f.host.calls, [])
        known_hosts = self.p.base / 'known_hosts'
        known_hosts.write_text('synthetic known host')
        self.p.runner = Mock(side_effect=subprocess.TimeoutExpired('synthetic vmrun', 1))
        with self.assertRaisesRegex(vm.VmwareError, 'probe timed out'):
            self.p.wait_for_ip('synthetic vmrun', 1)
        self.assertEqual(self.p.runner.call_count, 1)
        self.assertEqual(known_hosts.read_text(), 'synthetic known host')

    def test_duplicate_service_probe_and_failed_failure_status_do_not_hide_original_error(self):
        self.p.runner = Mock(return_value=types.SimpleNamespace(returncode=0,
            stdout=json.dumps([{'name': vm.NAT_SERVICES[0], 'status': 'Running'}] * 2)))
        with self.assertRaisesRegex(vm.VmwareError, 'Could not verify'):
            self.p.network_preflight()
        self.p.stage = Mock(side_effect=OSError('isolated status failure'))
        self.p.log = Mock()
        with self.assertRaisesRegex(vm.VmwareError, 'original failure'):
            with self.p.operation('fixture'):
                raise vm.VmwareError('original failure')
        self.assertFalse((self.p.base / '.operation.lock').exists())
        self.assertTrue(self.p.log.called)

    def test_cli_preparation_repair_identity_and_unsupported_platform_are_explicit(self):
        for arguments, platform, expected in ((['prepare'], 'win32', 0),
                (['repair-network', '--expected-vm-id', 'synthetic'], 'win32', 0),
                (['repair-network'], 'win32', 1), (['prepare'], 'linux', 1)):
            with self.subTest(arguments=arguments), patch.object(vm.sys, 'argv', ['vmware.py', *arguments]), \
                    patch.object(vm.sys, 'platform', platform), patch.object(vm, 'Provisioner') as provisioner, \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(vm.main(), expected)
            if expected:
                self.assertFalse(provisioner.return_value.create.called)
                self.assertFalse(provisioner.return_value.prepare.called)
                self.assertFalse(provisioner.return_value.repair_network.called)

    def test_missing_tools_and_oversized_network_probe_are_explicit_without_actions(self):
        with patch.object(vm.shutil, 'which', return_value=None), patch.dict(os.environ,
                {'ProgramFiles': str(self.f.data), 'ProgramFiles(x86)': str(self.f.data / 'absent')}, clear=True), \
                self.assertRaisesRegex(vm.VmwareError, 'unavailable'):
            vm.find_tool('missing')
        for code, output in ((1, ''), (0, 'x' * (16 * 1024 + 1))):
            self.p.runner = Mock(return_value=types.SimpleNamespace(returncode=code, stdout=output))
            with self.assertRaisesRegex(vm.VmwareError, 'Could not verify'):
                self.p.network_preflight()
            self.assertEqual(self.p.runner.call_count, 1)

    def test_advertised_download_and_malformed_disk_layout_reject_before_artifact_creation(self):
        self.f.data.mkdir()
        target = self.f.data / 'image'
        response = io.BytesIO(b'unread')
        response.headers = {'Content-Length': '101'}
        response.geturl = lambda: vm.BASE_URL + vm.IMAGE
        with patch.object(vm.urllib.request, 'urlopen', return_value=response), self.assertRaisesRegex(vm.VmwareError, 'size limit'):
            vm.download(vm.BASE_URL + vm.IMAGE, target, 100)
        self.assertFalse(target.exists())
        self.assertFalse(target.with_name('image.part').exists())
        target.write_bytes(fixture.vmdk()[:512])
        with self.assertRaisesRegex(vm.VmwareError, 'descriptor layout'):
            vm.vmdk_info(target)

    def test_existing_key_is_checked_and_too_small_requested_disk_never_converts(self):
        self.p.base.mkdir(parents=True)
        self.p.key.write_text('synthetic existing key')
        pathlib.Path(str(self.p.key) + '.pub').write_text('synthetic existing public key')
        prepared = self.f.prepare()
        image = self.p.cache / vm.IMAGE
        image.write_bytes(fixture.vmdk(capacity=128 * 1024 ** 3))
        vm.write_json(self.p.prepared_path, dict(prepared, imageSha256=vm.sha256(image)))
        self.f.host.calls.clear()
        with self.assertRaisesRegex(vm.VmwareError, 'smaller than'):
            self.f.create()
        self.assertFalse(self.p.manifest_path.exists())
        self.assertFalse(any('-r' in call or '-x' in call for call in self.f.host.calls))
        self.f.host.calls.clear()
        with self.assertRaisesRegex(vm.VmwareError, 'Invalid VM resource'):
            self.p.create(cpu=0)
        self.assertEqual(self.f.host.calls, [])
        for settings in ({'cpu': True}, {'memory_gb': None}, {'disk_gb': '64'},
                         {'ip_timeout_seconds': 0}, {'ip_timeout_seconds': True}):
            with self.subTest(settings=settings), self.assertRaisesRegex(vm.VmwareError, 'Invalid VM resource'):
                self.p.create(**settings)
            self.assertEqual(self.f.host.calls, [])

    def test_network_repair_connected_or_changed_configuration_never_overwrites_it(self):
        manifest = self.f.legacy_failed_vm()
        vm.write_json(self.p.manifest_path, dict(manifest, phase='connected'))
        before = self.p.vmx.read_bytes()
        with self.assertRaisesRegex(vm.VmwareError, 'unconnected'):
            self.p.repair_network(manifest['id'])
        self.assertEqual(self.p.vmx.read_bytes(), before)
        vm.write_json(self.p.manifest_path, manifest)
        original = self.p.validate_owned
        def change_after_validation(value):
            result = original(value)
            self.p.vmx.write_bytes(before.replace(b'"vmxnet3"', b'"e1000"'))
            return result
        with patch.object(self.p, 'validate_owned', side_effect=change_after_validation), \
                self.assertRaisesRegex(vm.VmwareError, 'exactly one original'):
            self.p.repair_network(manifest['id'])
        self.assertEqual(self.p.vmx.read_bytes(), before.replace(b'"vmxnet3"', b'"e1000"'))
        self.assertFalse((self.p.base / 'network-repair.json').exists())

    def test_network_repair_detects_changed_source_before_replace_and_keeps_audit(self):
        manifest = self.f.legacy_failed_vm()
        before = self.p.vmx.read_bytes()
        original_hash = vm.sha256
        def changed(path):
            if pathlib.Path(path) == self.p.vmx:
                self.p.vmx.write_bytes(before + b'# external change\n')
            return original_hash(path)
        with patch.object(vm, 'sha256', side_effect=changed), self.assertRaisesRegex(vm.VmwareError, 'changed during repair'):
            self.p.repair_network(manifest['id'])
        self.assertEqual(self.p.vmx.read_bytes(), before + b'# external change\n')
        self.assertTrue((self.p.base / 'network-repair.json').exists())
        self.assertEqual(list(self.p.base.glob('*.tmp')), [])
        self.assertFalse(any('start' in call for call in self.f.host.calls))

    def test_network_repair_post_write_change_stays_unconfirmed_without_replay(self):
        manifest = self.f.legacy_failed_vm()
        original_hash = vm.sha256
        calls = []
        def changed(path):
            if pathlib.Path(path) == self.p.vmx:
                calls.append(path)
                if len(calls) == 2:
                    with self.p.vmx.open('ab') as stream:
                        stream.write(b'# external change\n')
            return original_hash(path)
        with patch.object(vm, 'sha256', side_effect=changed), self.assertRaisesRegex(vm.VmwareError, 'verification failed'):
            self.p.repair_network(manifest['id'])
        self.assertTrue((self.p.base / 'network-repair.json').exists())
        self.assertEqual(len(list(self.p.base.glob('*.bak'))), 1)
        self.assertFalse(any('start' in call for call in self.f.host.calls))

    def test_script_entrypoint_rejects_unsupported_platform_without_any_process(self):
        with patch.object(sys, 'platform', 'linux'), patch.object(sys, 'argv', ['vmware.py', 'prepare']), \
                patch('subprocess.run') as process, contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as failure:
            runpy.run_path(str(ROOT / 'scripts/vmware.py'), run_name='__main__')
        self.assertEqual(failure.exception.code, 1)
        process.assert_not_called()


if __name__ == '__main__':
    unittest.main()
