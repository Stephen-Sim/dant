#!/usr/bin/env python3
"""Create only dant-owned Workstation VMs; never alter host virtualization/network policy.

Commands are argument arrays and injectable for offline tests. Only the CLI entry point
performs network or VMware actions. Downloads are official Ubuntu release VMDKs,
verified against the release's SHA256SUMS before conversion.
"""
import argparse
import contextlib
import datetime
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

BASE_URL = 'https://cloud-images.ubuntu.com/releases/noble/release/'
IMAGE = 'ubuntu-24.04-server-cloudimg-amd64.vmdk'
MAX_IMAGE_BYTES = 4 * 1024**3
OWNER = 'dant-vmware-v1'
DEFAULT_CPU = 4
DEFAULT_MEMORY_GB = 8
DEFAULT_DISK_GB = 64
NAT_SERVICES = ('VMnetDHCP', 'VMware NAT Service')
# Fixed read-only service lookup. Never start/reconfigure services or networks.
NETWORK_PREFLIGHT_SCRIPT = r'''[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$dantServiceNames = @('VMnetDHCP', 'VMware NAT Service')
$dantServiceStates = @(foreach ($dantServiceName in $dantServiceNames) {
  $dantService = Get-Service -Name $dantServiceName -ErrorAction SilentlyContinue
  $dantState = if ($dantService) { [string]$dantService.Status } else { 'Missing' }
  [pscustomobject]@{name=$dantServiceName;status=$dantState}
})
ConvertTo-Json -InputObject $dantServiceStates -Compress
'''


class VmwareError(ValueError):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def regular(path):
    """Reject links, Windows reparse points, and multiple hard links."""
    path = pathlib.Path(path)
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
            getattr(info, 'st_file_attributes', 0) & 0x400):
        raise VmwareError(f'Expected a regular, unlinked file: {path}')
    return info


def safe_directory(path):
    path = pathlib.Path(os.path.abspath(path))
    for item in [path, *path.parents]:
        if item.exists() or item.is_symlink():
            info = item.lstat()
            if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise VmwareError(f'Directory is a link/reparse point or not a directory: {item}')
    return path


def read_json(path):
    if regular(path).st_size > 1024 * 1024:
        raise VmwareError(f'Metadata exceeds size limit: {path}')
    value = json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))
    if not isinstance(value, dict):
        raise VmwareError(f'Invalid metadata object: {path}')
    return value


def write_json(path, value, *, exclusive=False):
    path = pathlib.Path(path)
    if exclusive:
        with path.open('x', encoding='utf-8', newline='\n') as out:
            json.dump(value, out, indent=2)
        return
    if path.exists() or path.is_symlink():
        regular(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as out:
            json.dump(value, out, indent=2)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def sha256(path):
    regular(path)
    result = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def checksum_for(text, filename=IMAGE):
    matches = []
    for line in text.splitlines():
        match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *](\S+)', line.strip())
        if match and match.group(2) == filename:
            matches.append(match.group(1).lower())
    if len(matches) != 1:
        raise VmwareError('Official SHA256SUMS must contain exactly one matching VMDK checksum')
    return matches[0]


def download(url, destination, limit):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'cloud-images.ubuntu.com' or not parsed.path.startswith('/releases/noble/release/'):
        raise VmwareError('Only the official Ubuntu noble release download endpoint is allowed')
    destination = pathlib.Path(destination)
    if destination.exists() or destination.is_symlink():
        raise VmwareError(f'Download destination exists; preserved: {destination}')
    partial = destination.with_name(destination.name + '.part')
    if partial.exists() or partial.is_symlink():
        raise VmwareError(f'An incomplete download was preserved: {partial}. Inspect/remove only this file before retrying.')
    request = urllib.request.Request(url, headers={'User-Agent': 'dant-vmware-setup/1'})
    with urllib.request.urlopen(request, timeout=60) as response:
        final = urllib.parse.urlsplit(response.geturl())
        if final.scheme != 'https' or final.netloc != 'cloud-images.ubuntu.com':
            raise VmwareError('Ubuntu download redirected outside the trusted HTTPS host')
        length = response.headers.get('Content-Length')
        if length and int(length) > limit:
            raise VmwareError('Ubuntu download exceeds its size limit')
        total = 0
        with partial.open('xb') as output:
            while True:
                chunk = response.read(min(1024 * 1024, limit - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise VmwareError('Ubuntu download exceeds its size limit; partial file retained')
                output.write(chunk)
    if not total:
        raise VmwareError('Ubuntu download is empty; partial file retained')
    # Exclusive creation also protects against a destination appearing after the
    # initial check. Path.rename alone would overwrite it on POSIX test hosts.
    with partial.open('rb') as source, destination.open('xb') as target:
        shutil.copyfileobj(source, target, 1024 * 1024)
    partial.unlink()


def vmdk_info(path, expected_type=None):
    size = regular(path).st_size
    with pathlib.Path(path).open('rb') as disk:
        header = disk.read(512)
        if len(header) != 512 or header[:4] != b'KDMV':
            raise VmwareError('Unsupported VMDK header: expected VMware sparse extent')
        version = struct.unpack_from('<I', header, 4)[0]
        capacity, _, offset, sectors = struct.unpack_from('<QQQQ', header, 12)
        if version not in (1, 3) or not capacity or not (0 < sectors <= 128) or offset * 512 + sectors * 512 > size:
            raise VmwareError('Unsupported VMDK sparse descriptor layout')
        disk.seek(offset * 512)
        descriptor = disk.read(sectors * 512).split(b'\0', 1)[0].decode('ascii', errors='strict')
    match = re.search(r'^createType\s*=\s*"([a-zA-Z]+)"\s*$', descriptor, re.M)
    if not match or (expected_type and match.group(1) != expected_type):
        raise VmwareError(f'Unexpected VMDK createType; expected {expected_type or "sparse"}')
    if re.search(r'^parentFileNameHint\s*=', descriptor, re.M):
        raise VmwareError('Parent/snapshot VMDKs are not supported by this creator')
    if match.group(1) == 'monolithicSparse':
        extents = [line.strip() for line in descriptor.splitlines()
                   if re.match(r'^\s*(?:RW|RDONLY|NOACCESS)\s', line)]
        expected_extent = f'RW {capacity} SPARSE "{pathlib.Path(path).name}"'
        if extents != [expected_extent]:
            raise VmwareError('Growable VMDK must contain only its own single sparse extent')
    return {'type': match.group(1), 'capacityBytes': capacity * 512, 'descriptor': descriptor}


def vmx_escape(value):
    value = str(value)
    if any(ord(char) < 32 for char in value):
        raise VmwareError('VMX value contains a control character')
    return value.replace('|', '|7C').replace('"', '|22')


def vmx_settings(owner_id, cpu, memory_gb, network_adapter='e1000'):
    # e1000 uses conventional PCI. vmxnet3 requires an explicit PCIe bridge
    # topology which a hand-written minimal VMX does not automatically receive.
    if network_adapter not in ('e1000', 'vmxnet3'):
        raise VmwareError('Unsupported managed network adapter')
    return {'.encoding': 'UTF-8', 'config.version': '8', 'virtualHW.version': '19',
            'displayName': 'dant', 'annotation': f'{OWNER}:{owner_id}', 'guestOS': 'ubuntu-64',
            'firmware': 'bios', 'numvcpus': str(cpu), 'memsize': str(memory_gb * 1024),
            'scsi0.present': 'TRUE', 'scsi0.virtualDev': 'lsilogic', 'scsi0:0.present': 'TRUE',
            'scsi0:0.fileName': 'dant.vmdk', 'ide1:0.present': 'TRUE',
            'ide1:0.deviceType': 'cdrom-image', 'ide1:0.fileName': 'cache/seed.iso',
            'ide1:0.startConnected': 'TRUE', 'ethernet0.present': 'TRUE',
            'ethernet0.connectionType': 'nat', 'ethernet0.virtualDev': network_adapter,
            'ethernet0.addressType': 'generated', 'ethernet0.startConnected': 'TRUE',
            'floppy0.present': 'FALSE', 'usb.present': 'FALSE', 'sound.present': 'FALSE',
            'isolation.tools.hgfs.disable': 'TRUE', 'sharedFolder.maxNum': '0',
            'uuid.action': 'keep', 'msg.autoAnswer': 'TRUE', 'logging': 'TRUE'}


def parse_vmx(path):
    if regular(path).st_size > 256 * 1024:
        raise VmwareError('VMX exceeds size limit')
    result = {}
    for line in pathlib.Path(path).read_text(encoding='utf-8-sig').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'\s*([\w.:]+)\s*=\s*"([^"\r\n]*)"\s*', line)
        if not match or match.group(1).lower() in result:
            raise VmwareError('Malformed or duplicate VMX setting')
        result[match.group(1).lower()] = match.group(2)
    return result


def guest_ip(text):
    try:
        ip = ipaddress.ip_address(text.strip())
    except ValueError:
        return None
    if ip.version != 4 or not any(ip in ipaddress.ip_network(network) for network in
                                  ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        return None
    return str(ip)


def running_vmx_paths(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    match = re.fullmatch(r'Total running VMs: (\d+)', lines[0]) if lines else None
    if not match or int(match.group(1)) != len(lines) - 1:
        raise VmwareError('Unrecognized vmrun list output; VM power state was not confirmed')
    return {os.path.normcase(os.path.abspath(line)) for line in lines[1:]}


def find_tool(name, explicit=None):
    if explicit:
        result = pathlib.Path(explicit).absolute()
        regular(result)
        return str(result)
    found = shutil.which(name)
    if found:
        regular(found)
        return found
    for env in ('ProgramFiles(x86)', 'ProgramFiles'):
        if os.environ.get(env):
            item = pathlib.Path(os.environ[env]) / 'VMware' / 'VMware Workstation' / (name + '.exe')
            if item.is_file():
                regular(item)
                return str(item)
    raise VmwareError(f'{name} is unavailable. Install VMware Workstation separately; no software was installed.')


def run_command(args, timeout, env=None):
    return subprocess.run([str(value) for value in args], capture_output=True, text=True,
                          stdin=subprocess.DEVNULL, timeout=timeout, env=env, check=False)


class Provisioner:
    def __init__(self, root, data, *, runner=run_command, fetch=download, clock=time.monotonic,
                 sleeper=time.sleep, tool_finder=find_tool, free_space=None):
        self.root, self.data = safe_directory(root), safe_directory(data)
        self.base = safe_directory(self.data / 'vmware')
        self.cache = self.base / 'cache'
        self.manifest_path = self.base / 'manifest.json'
        self.prepared_path = self.base / 'prepared.json'
        self.vmx, self.disk = self.base / 'dant.vmx', self.base / 'dant.vmdk'
        self.seed, self.key = self.cache / 'seed.iso', self.base / 'vm-key'
        self.binding = self.data / 'vm.json'
        self.runner, self.fetch, self.clock, self.sleeper = runner, fetch, clock, sleeper
        self.tool_finder = tool_finder
        self.free_space = free_space or (lambda path: shutil.disk_usage(path).free)
        self.log_path = None

    def guard_binding(self, *, resume=False):
        if not self.binding.exists() and not self.binding.is_symlink():
            return
        binding = read_json(self.binding)
        if not resume or binding.get('provider') != 'vmware' or not self.manifest_path.exists():
            raise VmwareError('A VM binding already exists. It was preserved; use a separate DataDirectory for a new VM.')
        manifest = read_json(self.manifest_path)
        if (binding.get('vmwareId') != manifest.get('id') or
                os.path.normcase(os.path.abspath(binding.get('keyPath', ''))) != os.path.normcase(str(self.key))):
            raise VmwareError('Existing binding does not belong to this VMware manifest; it was preserved')

    @contextlib.contextmanager
    def operation(self, action):
        self.base.mkdir(parents=True, exist_ok=True)
        lock = self.base / '.operation.lock'
        try:
            descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise VmwareError('Another VMware operation or an interrupted operation owns .operation.lock; inspect it before recovery')
        try:
            os.write(descriptor, f'{os.getpid()} {action}\n'.encode())
            os.close(descriptor)
            logs = safe_directory(self.base / 'logs')
            logs.mkdir(exist_ok=True)
            self.log_path = logs / f'{action}-{uuid.uuid4().hex}.log'
            self.log_path.touch(exist_ok=False)
            try:
                yield
            except Exception as error:
                try:
                    self.stage('failed', str(error))
                except OSError as status_error:
                    self.log(f'Could not persist failure status: {status_error}; original error: {error}')
                raise
        finally:
            lock.unlink()

    def stage(self, value, error=''):
        write_json(self.data / 'vm-setup-status.json', {
            'name': 'dant', 'provider': 'vmware', 'stage': value, 'updatedAt': now(),
            'log': str(self.log_path) if self.log_path else None, 'error': error[:4000]})
        self.log(f'VM setup: {value}' + (f' — {error[:4000]}' if error else ''))

    def log(self, text):
        print(text, flush=True)
        if self.log_path:
            with self.log_path.open('a', encoding='utf-8') as log:
                log.write(f'{now()} {text}\n')

    def command(self, args, timeout=60, env=None, quiet=False):
        result = self.runner([str(value) for value in args], timeout=timeout, env=env)
        if not quiet:
            text = ((result.stdout or '') + '\n' + (result.stderr or '')).strip()
            if text:
                self.log(text[-8000:])
        if result.returncode:
            raise VmwareError(f'{pathlib.Path(args[0]).name} failed with exit {result.returncode}' +
                              (f': {((result.stderr or result.stdout or "").strip())[-1500:]}' if quiet else '; see setup log'))
        return result

    def tools(self, vmrun_path=None, vdiskmanager_path=None):
        return (self.tool_finder('vmrun', vmrun_path), self.tool_finder('vmware-vdiskmanager', vdiskmanager_path))

    def network_preflight(self):
        guidance = ('New VMware NAT setup requires VMnetDHCP and VMware NAT Service to be Running. '
                    'Open Windows Services (services.msc) and ask the computer administrator to '
                    'start or repair these VMware services, then retry. dant did not change host '
                    'services or network settings; existing SSH connections remain usable.')
        try:
            result = self.runner(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
                                  '-Command', NETWORK_PREFLIGHT_SCRIPT], timeout=15, env=None)
            if result.returncode or len(result.stdout) > 16 * 1024:
                raise ValueError('Service lookup failed')
            values = json.loads(result.stdout.lstrip('\ufeff'))
            if (not isinstance(values, list) or len(values) != len(NAT_SERVICES) or
                    any(not isinstance(value, dict) or value.get('name') not in NAT_SERVICES or
                        not isinstance(value.get('status'), str) for value in values)):
                raise ValueError('Invalid service lookup')
            states = {value['name']: value['status'] for value in values}
            if set(states) != set(NAT_SERVICES):
                raise ValueError('Incomplete service lookup')
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise VmwareError('Could not verify VMware NAT services. ' + guidance) from error
        blocked = [f'{name}={states[name][:32]}' for name in NAT_SERVICES if states[name] != 'Running']
        if blocked:
            raise VmwareError('VMware NAT services are not running: ' + ', '.join(blocked) + '. ' + guidance)
        self.log('VMware NAT preflight passed: VMnetDHCP and VMware NAT Service are Running (read only).')
        return states

    def prepare(self, admin_sudo=False, vmrun_path=None, vdiskmanager_path=None):
        self.guard_binding()
        with self.operation('prepare'):
            self.stage('checking-vmware')
            self.tools(vmrun_path, vdiskmanager_path)
            self.stage('checking-vmware-network')
            self.network_preflight()
            if any(path.exists() or path.is_symlink() for path in (self.disk, self.vmx, self.manifest_path)):
                raise VmwareError('VMware VM/disk/manifest already exists. Preparation does not rewrite an existing VM; use -Resume.')
            safe_directory(self.cache).mkdir(exist_ok=True)
            old = read_json(self.prepared_path) if self.prepared_path.exists() else None
            if old and (old.get('owner') != OWNER or old.get('adminSudo') != bool(admin_sudo)):
                raise VmwareError('Prepared image permission selection differs; existing seed was preserved')
            self.stage('downloading-image')
            sums_path = self.cache / 'SHA256SUMS'
            if not sums_path.exists():
                self.fetch(BASE_URL + 'SHA256SUMS', sums_path, 256 * 1024)
            if regular(sums_path).st_size > 256 * 1024:
                raise VmwareError('SHA256SUMS exceeds size limit')
            expected = checksum_for(sums_path.read_text(encoding='utf-8'))
            image = self.cache / IMAGE
            if not image.exists():
                if self.free_space(self.base) < 3 * 1024**3:
                    raise VmwareError('At least 3 GiB free disk space is required to prepare the image')
                self.fetch(BASE_URL + IMAGE, image, MAX_IMAGE_BYTES)
            self.stage('verifying-image')
            if sha256(image) != expected:
                raise VmwareError('Official VMDK SHA256 mismatch. Cached file was preserved; do not use it.')
            vmdk_info(image, 'streamOptimized')
            if old:
                self.validate_prepared(old)
                self.stage('prepared')
                return old
            if self.seed.exists() or self.seed.is_symlink():
                raise VmwareError('Seed ISO exists without prepared metadata; preserved for inspection')
            for key_file in (self.key, pathlib.Path(str(self.key) + '.pub')):
                if key_file.exists() or key_file.is_symlink():
                    regular(key_file)
            self.stage('preparing-seed')
            self.command([sys.executable, self.root / 'scripts/vm-key.py', self.key], quiet=True)
            tools_dir = safe_directory(self.base / 'tools/python')
            tools_dir.mkdir(parents=True, exist_ok=True)
            env = os.environ.copy()
            env['PYTHONPATH'] = str(tools_dir) + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
            probe = self.runner([sys.executable, '-c', 'import pycdlib'], timeout=30, env=env)
            if probe.returncode:
                self.command([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
                              '--target', tools_dir, 'pycdlib==1.14.0'], timeout=300, env=env)
            self.command([sys.executable, self.root / 'scripts/seed.py', self.root,
                          'true' if admin_sudo else 'false', '--provider', 'vmware',
                          '--data-directory', self.base, '--cache-directory', self.cache], env=env)
            prepared = {'owner': OWNER, 'version': 1, 'provider': 'vmware', 'adminSudo': bool(admin_sudo),
                        'imageUrl': BASE_URL + IMAGE, 'imageSha256': expected,
                        'seedSha256': sha256(self.seed), 'publicKeySha256': sha256(str(self.key) + '.pub'),
                        'createdAt': now()}
            regular(self.key)
            write_json(self.prepared_path, prepared, exclusive=True)
            self.stage('prepared')
            return prepared

    def validate_prepared(self, prepared):
        if (prepared.get('owner') != OWNER or prepared.get('version') != 1 or
                prepared.get('imageUrl') != BASE_URL + IMAGE):
            raise VmwareError('Unrecognized VMware preparation metadata')
        for path, field in ((self.cache / IMAGE, 'imageSha256'), (self.seed, 'seedSha256'),
                            (pathlib.Path(str(self.key) + '.pub'), 'publicKeySha256')):
            if sha256(path) != prepared.get(field):
                raise VmwareError(f'Prepared artifact changed: {path.name}; no VM was modified')
        regular(self.key)

    def validate_owned(self, manifest):
        try:
            uuid.UUID(manifest.get('id', ''))
        except (ValueError, AttributeError):
            raise VmwareError('Invalid VMware manifest identity')
        if (manifest.get('owner') != OWNER or manifest.get('version') != 1 or
                manifest.get('phase') not in ('created', 'starting', 'started', 'connected') or
                manifest.get('vmx') != str(self.vmx) or manifest.get('disk') != str(self.disk)):
            raise VmwareError('VM manifest is unrecognized or incomplete; preserved for manual inspection')
        prepared = read_json(self.prepared_path)
        # Image remains immutable, but a running growable disk intentionally changes.
        self.validate_prepared(prepared)
        actual = parse_vmx(self.vmx)
        expected = vmx_settings(manifest['id'], manifest['cpu'], manifest['memoryGB'],
                                manifest.get('networkAdapter', 'vmxnet3'))
        for key, value in expected.items():
            if actual.get(key.lower()) != vmx_escape(value):
                raise VmwareError(f'Owned VMX setting changed: {key}; refusing to operate on this VM')
        for key, value in actual.items():
            if re.fullmatch(r'(?:scsi|sata|ide|nvme|floppy)\d+(?::\d+)?\.filename', key):
                if key not in ('scsi0:0.filename', 'ide1:0.filename'):
                    raise VmwareError('VMX references an additional disk/device; refusing to operate on this VM')
            if re.fullmatch(r'ethernet[1-9]\d*\.present', key) and value.upper() != 'FALSE':
                raise VmwareError('VMX has an additional network adapter; refusing to operate on this VM')
            if key in ('workingdir', 'snapshotdirectory') and value not in ('', '.'):
                raise VmwareError('VMX relocates runtime files; refusing to operate on this VM')
        info = regular(self.disk)
        identity = manifest.get('diskIdentity', {})
        if identity != {'device': info.st_dev, 'inode': info.st_ino}:
            raise VmwareError('Owned virtual disk was replaced; refusing to operate on this VM')
        disk_info = vmdk_info(self.disk, 'monolithicSparse')
        if disk_info['capacityBytes'] != manifest['diskGB'] * 1024**3:
            raise VmwareError('Owned virtual disk capacity changed; refusing to operate on this VM')
        return manifest

    def repair_network(self, expected_vm_id, vmrun_path=None):
        """Explicit recovery for this creator's early failed vmxnet3 topology.

        Never starts a VM or edits a disk. The caller must identify the exact VM,
        and both its stopped state and original ownership are verified first.
        """
        self.guard_binding(resume=True)
        with self.operation('repair-network'):
            manifest = read_json(self.manifest_path)
            if manifest.get('id') != expected_vm_id:
                raise VmwareError('Expected VM identity does not match; no VM was modified')
            self.validate_owned(manifest)
            if manifest.get('networkAdapter') == 'e1000':
                self.log('Owned VM already uses the repaired e1000 adapter; no files changed.')
                return manifest
            if manifest.get('phase') not in ('created', 'starting') or self.binding.exists():
                raise VmwareError('Network repair is restricted to an unconnected creation failure')
            vmrun = self.tool_finder('vmrun', vmrun_path)
            listed = self.command([vmrun, '-T', 'ws', 'list'], timeout=20, quiet=True)
            if os.path.normcase(str(self.vmx)) in running_vmx_paths(listed.stdout):
                raise VmwareError('Owned VM is running; no VM was modified')
            log_path = self.base / 'vmware.log'
            regular(log_path)
            with log_path.open('rb') as log:
                log.seek(max(0, log_path.stat().st_size - 64 * 1024))
                log_tail = log.read(64 * 1024).decode('utf-8', errors='replace')
            if not re.search(r'\[msg\.pci\.noslotavail\].*Ethernet0', log_tail):
                raise VmwareError('Expected Ethernet0 PCIe-slot failure was not found; no VM was modified')
            original = self.vmx.read_bytes()
            text = original.decode('utf-8-sig')
            text, changes = re.subn(r'(?im)^(\s*ethernet0\.virtualDev\s*=\s*)"vmxnet3"\s*$',
                                    r'\1"e1000"', text)
            if changes != 1:
                raise VmwareError('Expected exactly one original vmxnet3 setting; no VM was modified')
            text = re.sub(r'(?im)^\s*ethernet0\.pciSlotNumber\s*=\s*"[^"\r\n]*"\s*\n?', '', text)
            replacement = text.replace('\r\n', '\n').encode('utf-8')
            old_hash, new_hash = hashlib.sha256(original).hexdigest(), hashlib.sha256(replacement).hexdigest()
            backup = self.base / f'dant.vmx.before-network-repair-{old_hash[:16]}.bak'
            audit = self.base / 'network-repair.json'
            with backup.open('xb') as output:
                output.write(original)
            record = {'owner': OWNER, 'vmId': manifest['id'], 'createdAt': now(),
                      'oldVmxSha256': old_hash, 'newVmxSha256': new_hash, 'backup': str(backup),
                      'fromAdapter': 'vmxnet3', 'toAdapter': 'e1000', 'diskUnmodified': True}
            write_json(audit, record, exclusive=True)
            temporary = self.base / f'dant.vmx.{uuid.uuid4().hex}.tmp'
            try:
                with temporary.open('xb') as output:
                    output.write(replacement)
                # Refuse changes made after validation. vmrun list remains the
                # only VMware command executed by this explicit repair action.
                if sha256(self.vmx) != old_hash:
                    raise VmwareError('VMX changed during repair; original files preserved')
                os.replace(temporary, self.vmx)
            finally:
                if temporary.exists():
                    temporary.unlink()
            manifest.update(networkAdapter='e1000', configurationRevision=2,
                            networkRepair=record, phase='created')
            write_json(self.manifest_path, manifest)
            self.validate_owned(manifest)
            if sha256(self.vmx) != new_hash:
                raise VmwareError('Repaired VMX verification failed; inspect backup and audit')
            self.stage('network-repaired')
            self.log('Repaired only the owned VMX Ethernet0 adapter. Disk preserved; use create-vmware.ps1 -Resume to start.')
            return manifest

    def create(self, cpu=DEFAULT_CPU, memory_gb=DEFAULT_MEMORY_GB, disk_gb=DEFAULT_DISK_GB,
               resume=False, ip_timeout_seconds=600,
               admin_sudo=False, vmrun_path=None, vdiskmanager_path=None):
        if not (1 <= cpu <= 64 and 2 <= memory_gb <= 128 and 32 <= disk_gb <= 2048 and 1 <= ip_timeout_seconds <= 3600):
            raise VmwareError('Invalid VM resource settings or IP timeout')
        self.guard_binding(resume=resume)
        had_binding = self.binding.exists()
        with self.operation('create'):
            self.stage('checking-vmware')
            vmrun, diskmanager = self.tools(vmrun_path, vdiskmanager_path)
            if not resume:
                self.stage('checking-vmware-network')
                self.network_preflight()
            if resume:
                manifest = self.validate_owned(read_json(self.manifest_path))
            else:
                if any(path.exists() or path.is_symlink() for path in (self.vmx, self.disk, self.manifest_path)):
                    raise VmwareError('VMware VM/disk/manifest exists. It was preserved; use -Resume only for its own completed manifest.')
                prepared = read_json(self.prepared_path)
                self.validate_prepared(prepared)
                if admin_sudo and not prepared.get('adminSudo'):
                    raise VmwareError('AdminSudo differs from the prepared seed; creation never changes guest permissions')
                source_info = vmdk_info(self.cache / IMAGE, 'streamOptimized')
                if disk_gb * 1024**3 < source_info['capacityBytes']:
                    raise VmwareError('Requested disk is smaller than the official image capacity')
                if self.free_space(self.base) < max(8 * 1024**3, (self.cache / IMAGE).stat().st_size * 3):
                    raise VmwareError('At least 8 GiB free space is required for sparse disk conversion; no disk was created')
                manifest = {'owner': OWNER, 'version': 1, 'provider': 'vmware', 'id': str(uuid.uuid4()),
                            'phase': 'building', 'vmx': str(self.vmx), 'disk': str(self.disk),
                            'cpu': cpu, 'memoryGB': memory_gb, 'diskGB': disk_gb, 'createdAt': now(),
                            'networkAdapter': 'e1000', 'configurationRevision': 2}
                write_json(self.manifest_path, manifest, exclusive=True)
                self.stage('converting-image')
                self.command([diskmanager, '-r', self.cache / IMAGE, '-t', '0', self.disk], timeout=900)
                vmdk_info(self.disk, 'monolithicSparse')
                if source_info['capacityBytes'] < disk_gb * 1024**3:
                    self.stage('expanding-disk')
                    self.command([diskmanager, '-x', f'{disk_gb}GB', self.disk], timeout=300)
                if vmdk_info(self.disk, 'monolithicSparse')['capacityBytes'] != disk_gb * 1024**3:
                    raise VmwareError('Converted virtual disk capacity does not match requested size; preserved')
                with self.vmx.open('x', encoding='utf-8', newline='\n') as output:
                    output.write('\n'.join(f'{key} = "{vmx_escape(value)}"' for key, value in
                                           vmx_settings(manifest['id'], cpu, memory_gb).items()) + '\n')
                info = regular(self.disk)
                manifest.update(phase='created', diskIdentity={'device': info.st_dev, 'inode': info.st_ino})
                write_json(self.manifest_path, manifest)
            # No configure/convert/expand operation runs during Resume.
            listed = self.command([vmrun, '-T', 'ws', 'list'], timeout=20, quiet=True)
            running = running_vmx_paths(listed.stdout)
            if os.path.normcase(str(self.vmx)) not in running:
                self.stage('starting-vm')
                manifest['phase'] = 'starting'
                write_json(self.manifest_path, manifest)
                self.command([vmrun, '-T', 'ws', 'start', self.vmx, 'nogui'], timeout=90)
            manifest['phase'] = 'started'
            write_json(self.manifest_path, manifest)
            self.stage('waiting-for-ip')
            host = self.wait_for_ip(vmrun, ip_timeout_seconds)
            # Recheck before the only top-level binding write; never replace another VM.
            self.guard_binding(resume=True)
            binding = {'provider': 'vmware', 'vmwareId': manifest['id'], 'host': host, 'user': 'dant',
                       'port': 22, 'keyPath': str(self.key), 'knownHosts': str(self.base / 'known_hosts')}
            write_json(self.binding, binding, exclusive=not had_binding)
            manifest.update(phase='connected', host=host, connectedAt=now())
            write_json(self.manifest_path, manifest)
            self.stage('guest-installing')
            self.log('VMware SSH is verified. Guest bootstrap continues; run check-vm.ps1 with the same DataDirectory.')
            return binding

    def wait_for_ip(self, vmrun, timeout):
        known_hosts = self.base / 'known_hosts'
        if known_hosts.exists() or known_hosts.is_symlink():
            regular(known_hosts)
        deadline = self.clock() + timeout
        last = 'Guest tools have not reported an address yet'
        while self.clock() < deadline:
            try:
                result = self.runner([vmrun, '-T', 'ws', 'getGuestIPAddress', str(self.vmx), '-wait'],
                                     timeout=min(10, max(0.1, deadline - self.clock())), env=None)
                host = guest_ip(result.stdout) if result.returncode == 0 else None
                if host:
                    ssh = self.runner(['ssh', '-T', '-p', '22', '-i', str(self.key), '-o', 'BatchMode=yes',
                                       '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=5', '-o',
                                       'StrictHostKeyChecking=accept-new', '-o',
                                       f'UserKnownHostsFile={self.base / "known_hosts"}', f'dant@{host}', 'id -un'],
                                      timeout=min(8, max(0.1, deadline - self.clock())), env=None)
                    if ssh.returncode == 0 and ssh.stdout.strip() == 'dant':
                        return host
                    last = 'Guest address exists but SSH machine-key authentication is not ready'
                else:
                    last = 'Guest tools did not report a valid private IPv4 address'
            except subprocess.TimeoutExpired:
                last = 'Guest tools/SSH probe timed out'
            self.sleeper(min(3, max(0, deadline - self.clock())))
        raise VmwareError(f'Timed out after {timeout}s waiting for VMware guest SSH. {last}. '
                          'The VM and disk were preserved and may still be running. Use -Resume after inspecting the log.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'create', 'repair-network'])
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument('--data-directory', type=pathlib.Path)
    parser.add_argument('--vmrun-path')
    parser.add_argument('--vdiskmanager-path')
    parser.add_argument('--admin-sudo', action='store_true')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--cpu', type=int, default=DEFAULT_CPU)
    parser.add_argument('--memory-gb', type=int, default=DEFAULT_MEMORY_GB)
    parser.add_argument('--disk-gb', type=int, default=DEFAULT_DISK_GB)
    parser.add_argument('--ip-timeout-seconds', type=int, default=600)
    parser.add_argument('--expected-vm-id')
    args = parser.parse_args()
    try:
        if sys.platform != 'win32':
            raise VmwareError('These launchers support Windows VMware Workstation only')
        provisioner = Provisioner(args.root, args.data_directory or args.root / 'data')
        tools = {'vmrun_path': args.vmrun_path, 'vdiskmanager_path': args.vdiskmanager_path}
        if args.action == 'prepare':
            provisioner.prepare(admin_sudo=args.admin_sudo, **tools)
        elif args.action == 'repair-network':
            if not args.expected_vm_id:
                raise VmwareError('Network repair requires --expected-vm-id for the exact failed VM')
            provisioner.repair_network(args.expected_vm_id, vmrun_path=args.vmrun_path)
        else:
            provisioner.create(cpu=args.cpu, memory_gb=args.memory_gb, disk_gb=args.disk_gb,
                               resume=args.resume, ip_timeout_seconds=args.ip_timeout_seconds,
                               admin_sudo=args.admin_sudo, **tools)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'VMware setup failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
