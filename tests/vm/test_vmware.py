"""Offline VMware creation contract tests; no hypervisor or network is invoked."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import struct
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('dant_vmware', ROOT / 'scripts/vmware.py')
vm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vm)


def vmdk(kind='streamOptimized', capacity=8 * 1024**3):
    header = bytearray(512)
    header[:4] = b'KDMV'
    struct.pack_into('<I', header, 4, 3 if kind == 'streamOptimized' else 1)
    struct.pack_into('<QQQQ', header, 12, capacity // 512, 128, 1, 2)
    filename = 'dant.vmdk' if kind == 'monolithicSparse' else 'image.vmdk'
    descriptor = (f'# Disk DescriptorFile\nversion=1\ncreateType="{kind}"\n'
                  f'RW {capacity // 512} SPARSE "{filename}"\n').encode()
    return bytes(header) + descriptor.ljust(1024, b'\0')


class FakeHost:
    def __init__(self):
        self.calls = []
        self.fetches = []
        self.seconds = 0
        self.running = False
        self.ip = '192.168.99.12'
        self.ssh_user = 'dant'
        self.fail_command = None
        self.start_timeout = False
        self.on_ip = None
        self.services = {name: 'Running' for name in vm.NAT_SERVICES}

    def clock(self):
        return self.seconds

    def sleep(self, value):
        self.seconds += value

    def fetch(self, url, destination, limit):
        self.fetches.append(url)
        value = (hashlib.sha256(vmdk()).hexdigest() + ' *' + vm.IMAGE + '\n').encode() if url.endswith('SHA256SUMS') else vmdk()
        pathlib.Path(destination).write_bytes(value)

    def run(self, args, timeout, env=None):
        args = list(map(str, args))
        self.calls.append(args)
        if self.fail_command and self.fail_command in args:
            return subprocess.CompletedProcess(args, 7, '', 'injected failure')
        if args[0] == 'powershell.exe':
            return subprocess.CompletedProcess(args, 0, json.dumps([
                {'name': name, 'status': state} for name, state in self.services.items()]), '')
        elif len(args) > 1 and args[1].endswith('vm-key.py'):
            pathlib.Path(args[2]).write_text('fake private key', encoding='utf-8')
            pathlib.Path(args[2] + '.pub').write_text('ssh-ed25519 fake-test-key dant-local-vm', encoding='utf-8')
        elif len(args) > 1 and args[1].endswith('seed.py'):
            cache = pathlib.Path(args[args.index('--cache-directory') + 1])
            cache.joinpath('seed.iso').write_bytes(b'fake seed iso')
        elif '-c' in args:
            return subprocess.CompletedProcess(args, 1, '', 'not installed')
        elif '-r' in args:
            pathlib.Path(args[-1]).write_bytes(vmdk('monolithicSparse'))
        elif '-x' in args:
            pathlib.Path(args[-1]).write_bytes(vmdk('monolithicSparse', int(args[-2][:-2]) * 1024**3))
        elif 'list' in args:
            return subprocess.CompletedProcess(args, 0, 'Total running VMs: ' + ('1\n' + str(self.vmx) if self.running else '0') + '\n', '')
        elif 'start' in args:
            self.vmx = pathlib.Path(args[-2])
            self.running = True
            if self.start_timeout:
                raise subprocess.TimeoutExpired(args, timeout)
        elif 'getGuestIPAddress' in args:
            self.seconds += min(0.1, timeout)
            if self.on_ip:
                self.on_ip()
            return subprocess.CompletedProcess(args, 0, self.ip + '\n', '')
        elif args[0] == 'ssh':
            return subprocess.CompletedProcess(args, 0, self.ssh_user + '\n', '')
        return subprocess.CompletedProcess(args, 0, '', '')


class VmwareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dant-vmware-')
        self.addCleanup(self.temp.cleanup)
        self.data = pathlib.Path(self.temp.name) / 'data'
        self.host = FakeHost()
        self.provisioner = vm.Provisioner(ROOT, self.data, runner=self.host.run, fetch=self.host.fetch,
                                         clock=self.host.clock, sleeper=self.host.sleep,
                                         tool_finder=lambda name, explicit: explicit or name,
                                         free_space=lambda path: 100 * 1024**3)
        self.quiet = contextlib.redirect_stdout(io.StringIO())
        self.quiet.__enter__()
        self.addCleanup(self.quiet.__exit__, None, None, None)

    def prepare(self, **kwargs):
        return self.provisioner.prepare(**kwargs)

    def create(self, **kwargs):
        return self.provisioner.create(cpu=2, memory_gb=3, disk_gb=40, ip_timeout_seconds=5, **kwargs)

    def test_new_vm_defaults_are_8gib_memory_and_64gib_disk(self):
        self.prepare()
        self.provisioner.create(ip_timeout_seconds=5)
        manifest = vm.read_json(self.provisioner.manifest_path)
        self.assertEqual((manifest['cpu'], manifest['memoryGB'], manifest['diskGB']), (4, 8, 64))
        self.assertEqual(vm.parse_vmx(self.provisioner.vmx)['memsize'], '8192')
        self.assertEqual(vm.vmdk_info(self.provisioner.disk, 'monolithicSparse')['capacityBytes'], 64 * 1024**3)
        self.assertTrue(any(call[1:3] == ['-x', '64GB'] for call in self.host.calls))

    def test_resume_defaults_preserve_larger_configured_memory_and_disk_bytes(self):
        self.prepare()
        self.provisioner.create(cpu=12, memory_gb=16, disk_gb=128, ip_timeout_seconds=5)
        original_vmx = self.provisioner.vmx.read_bytes()
        original_disk = self.provisioner.disk.read_bytes()
        original_manifest = vm.read_json(self.provisioner.manifest_path)
        self.host.calls.clear()

        self.provisioner.create(resume=True, ip_timeout_seconds=5)

        resumed = vm.read_json(self.provisioner.manifest_path)
        self.assertEqual((resumed['cpu'], resumed['memoryGB'], resumed['diskGB']), (12, 16, 128))
        self.assertEqual(resumed['id'], original_manifest['id'])
        self.assertEqual(self.provisioner.vmx.read_bytes(), original_vmx)
        self.assertEqual(self.provisioner.disk.read_bytes(), original_disk)
        self.assertFalse(any('-r' in call or '-x' in call for call in self.host.calls))

    def test_cli_uses_same_defaults_without_contacting_vmware(self):
        with mock.patch.object(vm.sys, 'argv', ['vmware.py', 'create']), \
                mock.patch.object(vm.sys, 'platform', 'win32'), \
                mock.patch.object(vm, 'Provisioner') as provisioner:
            vm.main()
        arguments = provisioner.return_value.create.call_args.kwargs
        self.assertEqual((arguments['cpu'], arguments['memory_gb'], arguments['disk_gb']), (4, 8, 64))

    def test_checksum_exact_unique_filename(self):
        digest = 'a' * 64
        self.assertEqual(vm.checksum_for(f'{digest} *{vm.IMAGE}\n'), digest)
        self.assertEqual(vm.checksum_for(f'{digest}  {vm.IMAGE}\n'), digest)
        for text in ('', f'{digest} *other.vmdk', f'{digest} *{vm.IMAGE}\n' * 2):
            with self.assertRaises(vm.VmwareError):
                vm.checksum_for(text)

    def test_prepare_isolated_verified_and_reusable(self):
        self.data.mkdir()
        (self.data / 'vm-key').write_text('existing Hyper-V key')
        self.prepare(admin_sudo=True)
        self.assertEqual((self.data / 'vm-key').read_text(), 'existing Hyper-V key')
        self.assertTrue(self.provisioner.key.is_file())
        seed_call = next(call for call in self.host.calls if len(call) > 1 and call[1].endswith('seed.py'))
        self.assertEqual(seed_call[seed_call.index('--provider') + 1], 'vmware')
        self.assertEqual(seed_call[seed_call.index('--data-directory') + 1], str(self.provisioner.base))
        self.assertTrue(any('pycdlib==1.14.0' in call for call in self.host.calls))
        before = len(self.host.calls)
        self.prepare(admin_sudo=True)
        self.assertEqual(len(self.host.calls), before + 1, 'Reusing prepared data still checks host NAT services')
        self.assertEqual(self.host.calls[-1][0], 'powershell.exe')
        self.assertEqual(len(self.host.fetches), 2)
        with self.assertRaisesRegex(vm.VmwareError, 'permission'):
            self.prepare(admin_sudo=False)

    def test_prepare_rejects_checksum_mismatch_without_generating_key(self):
        self.provisioner.cache.mkdir(parents=True)
        (self.provisioner.cache / vm.IMAGE).write_bytes(b'corrupted image')
        with self.assertRaisesRegex(vm.VmwareError, 'SHA256 mismatch'):
            self.prepare()
        self.assertFalse(self.provisioner.key.exists())
        self.assertEqual((self.provisioner.cache / vm.IMAGE).read_bytes(), b'corrupted image')
        self.assertEqual(vm.read_json(self.data / 'vm-setup-status.json')['provider'], 'vmware')

    def test_prepare_rejects_seed_without_metadata(self):
        self.provisioner.cache.mkdir(parents=True)
        self.provisioner.seed.write_bytes(b'old seed')
        with self.assertRaisesRegex(vm.VmwareError, 'without prepared metadata'):
            self.prepare()
        self.assertEqual(self.provisioner.seed.read_bytes(), b'old seed')

    def test_existing_binding_refused_before_status_or_key_changes(self):
        self.data.mkdir()
        binding = {'provider': 'hyperv', 'host': '172.20.27.249'}
        vm.write_json(self.data / 'vm.json', binding)
        (self.data / 'vm-setup-status.json').write_text('unchanged')
        for action in (self.prepare, self.create, lambda: self.create(resume=True)):
            with self.assertRaisesRegex(vm.VmwareError, 'binding already exists'):
                action()
        self.assertEqual(vm.read_json(self.data / 'vm.json'), binding)
        self.assertEqual((self.data / 'vm-setup-status.json').read_text(), 'unchanged')
        self.assertFalse(self.provisioner.base.exists())
        self.assertEqual(self.host.calls, [])

    def test_create_converts_expands_nat_vmx_then_verifies_ssh(self):
        self.prepare()
        binding = self.create()
        self.assertEqual(binding['provider'], 'vmware')
        self.assertEqual(binding['host'], self.host.ip)
        converter = next(call for call in self.host.calls if '-r' in call)
        self.assertEqual(converter[-3:], ['-t', '0', str(self.provisioner.disk)])
        self.assertTrue(any(call[1:3] == ['-x', '40GB'] for call in self.host.calls))
        self.assertTrue(any(call[-2:] == [str(self.provisioner.vmx), 'nogui'] for call in self.host.calls))
        config = vm.parse_vmx(self.provisioner.vmx)
        self.assertEqual(config['ethernet0.connectiontype'], 'nat')
        self.assertEqual(config['ethernet0.virtualdev'], 'e1000')
        self.assertEqual(config['ide1:0.filename'], 'cache/seed.iso')
        self.assertEqual(config['memsize'], '3072')
        self.assertEqual(vm.read_json(self.data / 'vm-setup-status.json')['stage'], 'guest-installing')
        self.assertEqual(vm.read_json(self.provisioner.manifest_path)['phase'], 'connected')
        self.assertFalse((self.provisioner.base / '.operation.lock').exists())

    def test_creation_refuses_existing_disk_and_never_reconverts(self):
        self.prepare()
        self.provisioner.disk.write_bytes(b'do not overwrite')
        with self.assertRaisesRegex(vm.VmwareError, 'preserved'):
            self.create()
        self.assertEqual(self.provisioner.disk.read_bytes(), b'do not overwrite')
        self.assertFalse(any('-r' in call for call in self.host.calls))

    def test_resume_uses_owned_running_vm_without_convert_or_start(self):
        self.prepare()
        original = self.create()
        self.host.calls.clear()
        # VMware adds runtime settings. They do not invalidate creator identity.
        with self.provisioner.vmx.open('a', encoding='utf-8') as output:
            output.write('uuid.bios = "generated-by-vmware"\n')
        refreshed = self.create(resume=True)
        self.assertEqual(refreshed, original)
        self.assertFalse(any('-r' in call or '-x' in call or 'start' in call for call in self.host.calls))

    def test_resume_refuses_tampered_vmx_disk_seed_and_binding(self):
        self.prepare()
        self.create()
        manifest = vm.read_json(self.provisioner.manifest_path)
        changes = [
            (self.provisioner.vmx, self.provisioner.vmx.read_bytes().replace(b'"nat"', b'"bridged"')),
            (self.provisioner.seed, b'changed seed'),
            (self.provisioner.manifest_path, json.dumps({**manifest, 'diskIdentity': {'device': -1, 'inode': -1}}).encode()),
            (self.data / 'vm.json', json.dumps({'provider': 'vmware', 'vmwareId': 'foreign'}).encode()),
        ]
        for target, changed in changes:
            previous = target.read_bytes()
            target.write_bytes(changed)
            self.host.calls.clear()
            with self.assertRaises(vm.VmwareError):
                self.create(resume=True)
            self.assertFalse(any('start' in call for call in self.host.calls))
            target.write_bytes(previous)

    def test_resume_rejects_additional_disk_network_and_foreign_extents(self):
        self.prepare()
        self.create()
        original_vmx = self.provisioner.vmx.read_bytes()
        for setting in ('scsi0:1.fileName = "foreign.vmdk"\n', 'ethernet1.present = "TRUE"\n',
                        'workingDir = "C:/foreign"\n'):
            self.provisioner.vmx.write_bytes(original_vmx + setting.encode())
            with self.assertRaises(vm.VmwareError):
                self.create(resume=True)
        self.provisioner.vmx.write_bytes(original_vmx)
        content = self.provisioner.disk.read_bytes().replace(b'"dant.vmdk"', b'"evil.vmdk"')
        self.provisioner.disk.write_bytes(content)
        with self.assertRaisesRegex(vm.VmwareError, 'own single sparse extent'):
            self.create(resume=True)

    def test_converter_failure_preserves_manifest_and_never_starts(self):
        self.prepare()
        self.host.fail_command = '-r'
        with self.assertRaisesRegex(vm.VmwareError, 'exit 7'):
            self.create()
        self.assertEqual(vm.read_json(self.provisioner.manifest_path)['phase'], 'building')
        self.assertEqual(vm.read_json(self.data / 'vm-setup-status.json')['stage'], 'failed')
        self.assertFalse(self.provisioner.binding.exists())
        with self.assertRaisesRegex(vm.VmwareError, 'incomplete'):
            self.create(resume=True)
        self.assertFalse(any('start' in call for call in self.host.calls))

    def test_unknown_start_not_automatically_retried_and_explicit_resume_inspects_list(self):
        self.prepare()
        self.host.start_timeout = True
        with self.assertRaises(subprocess.TimeoutExpired):
            self.create()
        self.assertEqual(sum('start' in call for call in self.host.calls), 1)
        self.assertFalse(self.provisioner.binding.exists())
        self.host.calls.clear()
        self.create(resume=True)
        self.assertFalse(any('start' in call for call in self.host.calls))

    def test_ip_deadline_preserves_started_vm_and_has_no_binding(self):
        self.prepare()
        self.host.ip = '203.0.113.1'
        with self.assertRaisesRegex(vm.VmwareError, 'Timed out after 5s'):
            self.create()
        self.assertLessEqual(self.host.seconds, 5)
        self.assertTrue(self.host.running)
        self.assertTrue(self.provisioner.disk.exists())
        self.assertFalse(self.provisioner.binding.exists())
        self.assertFalse(any(call[0] == 'ssh' for call in self.host.calls))

    def test_ssh_authentication_must_match_before_binding(self):
        self.prepare()
        self.host.ssh_user = 'other-user'
        with self.assertRaisesRegex(vm.VmwareError, 'authentication is not ready'):
            self.create()
        self.assertFalse(self.provisioner.binding.exists())

    def test_new_binding_appearing_while_starting_is_preserved(self):
        self.prepare()
        foreign = {'provider': 'hyperv', 'host': '10.0.0.99'}
        self.host.on_ip = lambda: vm.write_json(self.data / 'vm.json', foreign)
        with self.assertRaisesRegex(vm.VmwareError, 'binding already exists'):
            self.create()
        self.assertEqual(vm.read_json(self.data / 'vm.json'), foreign)

    def test_capacity_and_space_guard_run_before_disk_mutation(self):
        self.prepare()
        self.provisioner.free_space = lambda path: 1
        with self.assertRaisesRegex(vm.VmwareError, '8 GiB'):
            self.create()
        self.assertFalse(self.provisioner.disk.exists())
        self.assertFalse(self.provisioner.manifest_path.exists())

    def test_admin_permission_mismatch_does_not_rewrite_seed(self):
        self.prepare()
        seed = self.provisioner.seed.read_bytes()
        with self.assertRaisesRegex(vm.VmwareError, 'AdminSudo differs'):
            self.create(admin_sudo=True)
        self.assertEqual(self.provisioner.seed.read_bytes(), seed)

    def test_ip_parser_accepts_only_private_ipv4(self):
        for value in ('192.168.1.2', '172.16.0.9', '10.0.0.5'):
            self.assertEqual(vm.guest_ip(value + '\n'), value)
        for value in ('127.0.0.1', '169.254.1.4', '0.0.0.0', '203.0.113.1', '8.8.8.8', '::1', 'Error\n192.168.1.2'):
            self.assertIsNone(vm.guest_ip(value))

    def test_vmdk_header_bounds_parent_and_type(self):
        path = pathlib.Path(self.temp.name) / 'test.vmdk'
        for content in (b'bad', vmdk('monolithicSparse'), vmdk().replace(b'version=1', b'parentFileNameHint="evil"')):
            path.write_bytes(content)
            with self.assertRaises(vm.VmwareError):
                vm.vmdk_info(path, 'streamOptimized')
        path.write_bytes(vmdk())
        self.assertEqual(vm.vmdk_info(path, 'streamOptimized')['capacityBytes'], 8 * 1024**3)

    def test_vmx_rejects_duplicate_settings_and_control_characters(self):
        path = pathlib.Path(self.temp.name) / 'test.vmx'
        path.write_text('guestOS = "ubuntu-64"\nguestos = "other"\n')
        with self.assertRaisesRegex(vm.VmwareError, 'duplicate'):
            vm.parse_vmx(path)
        self.assertEqual(vm.vmx_escape('a|"b'), 'a|7C|22b')
        with self.assertRaises(vm.VmwareError):
            vm.vmx_escape('a\nb')

    def test_hardlinked_artifact_is_rejected(self):
        path = pathlib.Path(self.temp.name) / 'source'
        path.write_text('owned')
        try:
            os.link(path, pathlib.Path(self.temp.name) / 'linked')
        except OSError:
            self.skipTest('Hard links unavailable')
        with self.assertRaisesRegex(vm.VmwareError, 'unlinked'):
            vm.regular(path)

    def test_symlink_cache_is_rejected_before_fetch(self):
        outside = pathlib.Path(self.temp.name) / 'outside'
        outside.mkdir()
        self.provisioner.base.mkdir(parents=True)
        try:
            self.provisioner.cache.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('Symlink privilege unavailable')
        with self.assertRaisesRegex(vm.VmwareError, 'link/reparse'):
            self.prepare()
        self.assertEqual(self.host.fetches, [])
        self.assertEqual(list(outside.iterdir()), [])

    def test_operation_lock_blocks_overlapping_creation(self):
        self.provisioner.base.mkdir(parents=True)
        lock = self.provisioner.base / '.operation.lock'
        lock.write_text('another process')
        with self.assertRaisesRegex(vm.VmwareError, 'interrupted operation'):
            self.prepare()
        self.assertEqual(lock.read_text(), 'another process')

    def test_download_restricts_host_size_redirect_and_existing_destinations(self):
        target = pathlib.Path(self.temp.name) / 'download'
        for url in ('http://cloud-images.ubuntu.com/releases/noble/release/file',
                    'https://evil.test/releases/noble/release/file',
                    'https://cloud-images.ubuntu.com/other/file'):
            with self.assertRaisesRegex(vm.VmwareError, 'official Ubuntu'):
                vm.download(url, target, 10)
        target.write_bytes(b'preserved')
        with self.assertRaisesRegex(vm.VmwareError, 'destination exists'):
            vm.download(vm.BASE_URL + vm.IMAGE, target, 10)
        self.assertEqual(target.read_bytes(), b'preserved')
        target.unlink()

        class Response(io.BytesIO):
            headers = {}
            url = vm.BASE_URL + vm.IMAGE

            def geturl(self):
                return self.url

        response = Response(b'payload')
        response.url = 'https://evil.test/image'
        with mock.patch.object(vm.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(vm.VmwareError, 'trusted HTTPS host'):
                vm.download(vm.BASE_URL + vm.IMAGE, target, 10)
        response = Response(b'payload-too-large')
        with mock.patch.object(vm.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(vm.VmwareError, 'size limit'):
                vm.download(vm.BASE_URL + vm.IMAGE, target, 4)
        self.assertFalse(target.exists())
        partial = target.with_name(target.name + '.part')
        self.assertTrue(partial.exists())
        with self.assertRaisesRegex(vm.VmwareError, 'incomplete download'):
            vm.download(vm.BASE_URL + vm.IMAGE, target, 10)
        partial.unlink()
        with mock.patch.object(vm.urllib.request, 'urlopen', return_value=Response(b'payload')):
            vm.download(vm.BASE_URL + vm.IMAGE, target, 10)
        self.assertEqual(target.read_bytes(), b'payload')
        self.assertFalse(partial.exists())

    def test_download_does_not_replace_file_appearing_during_stream(self):
        target = pathlib.Path(self.temp.name) / 'download'

        class RacingResponse(io.BytesIO):
            headers = {}

            def geturl(self):
                return vm.BASE_URL + vm.IMAGE

            def read(self, length):
                if not target.exists():
                    target.write_bytes(b'foreign')
                return super().read(length)

        with mock.patch.object(vm.urllib.request, 'urlopen', return_value=RacingResponse(b'payload')):
            with self.assertRaises(FileExistsError):
                vm.download(vm.BASE_URL + vm.IMAGE, target, 10)
        self.assertEqual(target.read_bytes(), b'foreign')

    def test_missing_tools_failure_does_not_download_or_create_key(self):
        def missing(name, explicit):
            raise vm.VmwareError('VMware Workstation tools unavailable')
        self.provisioner.tool_finder = missing
        with self.assertRaisesRegex(vm.VmwareError, 'tools unavailable'):
            self.prepare()
        self.assertEqual(self.host.fetches, [])
        self.assertEqual(self.host.calls, [])
        self.assertFalse(self.provisioner.key.exists())

    def legacy_failed_vm(self):
        self.prepare()
        self.host.start_timeout = True
        with self.assertRaises(subprocess.TimeoutExpired):
            self.create()
        self.host.running = False
        manifest = vm.read_json(self.provisioner.manifest_path)
        manifest.pop('networkAdapter')
        manifest.pop('configurationRevision')
        vm.write_json(self.provisioner.manifest_path, manifest)
        text = self.provisioner.vmx.read_text().replace('"e1000"', '"vmxnet3"')
        text += 'ethernet0.pciSlotNumber = "21"\nuuid.bios = "keep-this-uuid"\n'
        self.provisioner.vmx.write_text(text, encoding='utf-8')
        (self.provisioner.base / 'vmware.log').write_text(
            '[msg.pci.noslotavail] No PCIe slot available for Ethernet0.\nVMX exit (0).\n')
        self.host.calls.clear()
        return manifest

    def test_network_repair_only_owned_failed_stopped_vmx_preserves_disk_and_identity(self):
        manifest = self.legacy_failed_vm()
        original_vmx = self.provisioner.vmx.read_bytes()
        original_disk = self.provisioner.disk.read_bytes()
        repaired = self.provisioner.repair_network(manifest['id'])
        self.assertEqual(repaired['networkAdapter'], 'e1000')
        self.assertEqual(repaired['phase'], 'created')
        config = vm.parse_vmx(self.provisioner.vmx)
        self.assertEqual(config['ethernet0.virtualdev'], 'e1000')
        self.assertNotIn('ethernet0.pcislotnumber', config)
        self.assertEqual(config['uuid.bios'], 'keep-this-uuid')
        self.assertEqual(self.provisioner.disk.read_bytes(), original_disk)
        audit = vm.read_json(self.provisioner.base / 'network-repair.json')
        self.assertEqual(pathlib.Path(audit['backup']).read_bytes(), original_vmx)
        self.assertEqual(audit['newVmxSha256'], vm.sha256(self.provisioner.vmx))
        self.assertEqual(repaired['diskIdentity'], manifest['diskIdentity'])
        self.assertEqual(len(self.host.calls), 1)
        self.assertIn('list', self.host.calls[0])
        self.host.calls.clear()
        self.host.start_timeout = False
        self.create(resume=True)
        self.assertFalse(any('-r' in call or '-x' in call for call in self.host.calls))

    def test_network_repair_rejects_wrong_identity_running_vm_and_unrelated_failure(self):
        manifest = self.legacy_failed_vm()
        before = self.provisioner.vmx.read_bytes()
        with self.assertRaisesRegex(vm.VmwareError, 'identity does not match'):
            self.provisioner.repair_network('another-vm-id')
        self.host.running = True
        with self.assertRaisesRegex(vm.VmwareError, 'VM is running'):
            self.provisioner.repair_network(manifest['id'])
        self.host.running = False
        (self.provisioner.base / 'vmware.log').write_text('Different startup failure')
        with self.assertRaisesRegex(vm.VmwareError, 'PCIe-slot failure was not found'):
            self.provisioner.repair_network(manifest['id'])
        self.assertEqual(before, self.provisioner.vmx.read_bytes())
        self.assertFalse((self.provisioner.base / 'network-repair.json').exists())
        self.assertFalse(any('start' in call for call in self.host.calls))

    def test_unrecognized_vmrun_list_is_not_treated_as_stopped(self):
        for value in ('', 'unexpected error', 'Total running VMs: 1\n'):
            with self.assertRaisesRegex(vm.VmwareError, 'not confirmed'):
                vm.running_vmx_paths(value)

    def test_stopped_or_missing_nat_service_refuses_before_download_key_or_disk_changes(self):
        for name, state in (('VMnetDHCP', 'Stopped'), ('VMware NAT Service', 'Stopped'),
                            ('VMnetDHCP', 'Missing')):
            self.host.services = {service: 'Running' for service in vm.NAT_SERVICES}
            self.host.services[name] = state
            with self.assertRaisesRegex(vm.VmwareError, name + '=' + state) as caught:
                self.prepare()
            self.assertIn('services.msc', str(caught.exception))
            self.assertEqual(self.host.fetches, [])
            self.assertFalse(self.provisioner.key.exists())
            self.assertFalse(self.provisioner.disk.exists())
            self.assertFalse(self.provisioner.manifest_path.exists())
            status = vm.read_json(self.data / 'vm-setup-status.json')
            self.assertEqual(status['provider'], 'vmware')
            self.assertEqual(status['stage'], 'failed')
        self.assertTrue(all(call[0] == 'powershell.exe' for call in self.host.calls))
        script = self.host.calls[0][-1]
        self.assertIn('Get-Service', script)
        self.assertNotIn('Start-Service', script)
        self.assertNotIn('Set-Service', script)

    def test_initial_creation_rechecks_nat_but_resume_does_not_block_existing_vm(self):
        self.prepare()
        self.host.services['VMnetDHCP'] = 'Stopped'
        with self.assertRaisesRegex(vm.VmwareError, 'VMnetDHCP=Stopped'):
            self.create()
        self.assertFalse(self.provisioner.disk.exists())
        self.host.services['VMnetDHCP'] = 'Running'
        self.create()
        self.host.services['VMnetDHCP'] = 'Stopped'
        self.host.calls.clear()
        self.create(resume=True)
        self.assertFalse(any(call[0] == 'powershell.exe' for call in self.host.calls))

    def test_unconfirmed_service_probe_fails_closed_without_actions(self):
        for stdout in ('invalid', '{}', '[]', json.dumps([{'name': 'VMnetDHCP', 'status': 'Running'}]),
                       json.dumps([{'name': 'VMnetDHCP', 'status': 'Running'}] * 2)):
            self.provisioner.runner = lambda args, timeout, env=None, output=stdout: subprocess.CompletedProcess(args, 0, output, '')
            with self.assertRaisesRegex(vm.VmwareError, 'Could not verify VMware NAT services'):
                self.provisioner.network_preflight()
        def timeout(args, timeout, env=None):
            raise subprocess.TimeoutExpired(args, timeout)
        self.provisioner.runner = timeout
        with self.assertRaisesRegex(vm.VmwareError, 'Could not verify VMware NAT services'):
            self.provisioner.network_preflight()


if __name__ == '__main__':
    unittest.main()
