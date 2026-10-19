#!/usr/bin/env python3
"""Verified Go Worker cutover. No Node execution or automatic rollback to Node."""

import contextlib
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

MANIFEST_LIMIT = 64 * 1024
FILE_LIMIT = 512 * 1024 * 1024
BUNDLE_LIMIT = 1024 * 1024 * 1024
HTTP_LIMIT = 8 * 1024 * 1024
SERVICE_LIMIT = 4096
SERVICE_TIMEOUT = 30
PREPARE_TIMEOUT = 15 * 60
READY_ATTEMPTS = 60
BINARY = 'resources/core/dant-core-linux-amd64'
BUNDLE_MANIFEST = 'resources/core/bundle-manifest.json'
ALLOWLIST = frozenset({
    BINARY, 'src/config/protocol.json', 'vm/bootstrap.sh', 'vm/control.py',
    'vm/desktop.py', 'vm/desktop_mcp.py', 'vm/guest.py', 'vm/install-speech.sh',
    'vm/install-transcription.sh', 'vm/install-worker.sh', 'vm/worker-install.py',
    'vm/start-codex.sh', 'vm/transcribe_audio.py',
    'vm/transcription-requirements.txt', 'vm/voice_message.py',
})
REQUIRED = frozenset({
    BINARY, 'src/config/protocol.json', 'vm/control.py', 'vm/desktop.py',
    'vm/desktop_mcp.py', 'vm/guest.py', 'vm/install-worker.sh',
    'vm/worker-install.py', 'vm/start-codex.sh', 'vm/voice_message.py',
    'vm/transcribe_audio.py',
})
HELPERS = (
    'guest.py', 'desktop.py', 'control.py', 'voice_message.py',
    'transcribe_audio.py', 'desktop_mcp.py',
)
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\Z')
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
LEASE = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
PHASE_RESERVING = 'reserving'
PHASE_STOPPING = 'stopping'
PHASE_PREPARING = 'preparing'
PHASE_ACTIVATING = 'activating'
PHASE_COMMITTED = 'committed'
PREPARATION_FILE = 'worker-preparation.json'
BACKUP_LIMIT = 10 * 1024 * 1024 * 1024 * 3 // 2 + 64 * 1024 * 1024


class InstallError(Exception):
    """Only the fixed public reason is exposed by the entrypoint."""


def reject(reason):
    raise InstallError(reason)


def ordinary_directory(path, create=False):
    path = pathlib.Path(path)
    if not path.is_absolute():
        reject('path-invalid')
    for parent in reversed((path, *path.parents)):
        if create and not parent.exists():
            parent.mkdir(mode=0o700)
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            reject('path-invalid')
    return path


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def shared_file_identity(info):
    # Windows Python 3.12 can report different ctime epochs through stat and
    # fstat. Compare common fields across APIs, while retaining full same-API
    # before/after comparisons, including ctime, throughout each read.
    return file_identity(info)[:-1]


@contextlib.contextmanager
def regular_file(path, limit):
    path = pathlib.Path(path)
    ordinary_directory(path.parent)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        reject('file-invalid')
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if shared_file_identity(opened) != shared_file_identity(before):
            reject('file-changed')
        yield stream
        after = path.lstat()
        if (
            file_identity(after) != file_identity(before) or
            file_identity(os.fstat(stream.fileno())) != file_identity(opened)
        ):
            reject('file-changed')


def read_regular(path, limit):
    with regular_file(path, limit) as stream:
        data = stream.read(limit + 1)
        if len(data) > limit:
            reject('file-invalid')
        return data


def json_object(raw):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                reject('manifest-invalid')
            result[key] = value
        return result

    result = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_pairs,
                        parse_constant=lambda _: reject('manifest-invalid'))
    if not isinstance(result, dict):
        reject('manifest-invalid')
    return result


def verify_bundle(source, home):
    home = ordinary_directory(home)
    source = ordinary_directory(source)
    releases = home / 'dant' / 'releases'
    if source.parent != releases or not source.name.startswith('source.'):
        reject('source-invalid')

    manifest = json_object(read_regular(source / BUNDLE_MANIFEST, MANIFEST_LIMIT))
    if (
        set(manifest) != {'schemaVersion', 'version', 'sourceCommit', 'files'} or
        type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1
    ):
        reject('manifest-invalid')
    version, commit, entries = manifest['version'], manifest['sourceCommit'], manifest['files']
    if (
        not isinstance(version, str) or not VERSION.fullmatch(version) or
        not isinstance(commit, str) or not COMMIT.fullmatch(commit) or
        not isinstance(entries, list) or not entries or len(entries) > len(ALLOWLIST)
    ):
        reject('manifest-invalid')

    seen, total, normalized = set(), 0, []
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'path', 'bytes', 'sha256'}:
            reject('manifest-invalid')
        name, size, expected = entry['path'], entry['bytes'], entry['sha256']
        if (
            not isinstance(name, str) or name not in ALLOWLIST or name in seen or
            type(size) is not int or not 0 < size <= FILE_LIMIT or
            not isinstance(expected, str) or not SHA256.fullmatch(expected)
        ):
            reject('manifest-invalid')
        seen.add(name)
        total += size
        if total > BUNDLE_LIMIT:
            reject('manifest-invalid')
        with regular_file(source / name, FILE_LIMIT) as stream:
            if (
                os.fstat(stream.fileno()).st_size != size or
                hashlib.file_digest(stream, 'sha256').hexdigest() != expected
            ):
                reject('bundle-changed')
        normalized.append({'path': name, 'bytes': size, 'sha256': expected})
    if not REQUIRED <= seen:
        reject('manifest-invalid')

    normalized.sort(key=lambda entry: entry['path'])
    canonical = {'schemaVersion': 1, 'version': version, 'sourceCommit': commit, 'files': normalized}
    canonical_raw = json.dumps(canonical, separators=(',', ':'), ensure_ascii=False).encode()
    digest = hashlib.sha256(canonical_raw).hexdigest()
    deployment = json_object(read_regular(source / 'deploy-manifest.json', MANIFEST_LIMIT))
    if (
        set(deployment) != {'schemaVersion', 'sha256', 'publicEnvironment'} or
        type(deployment['schemaVersion']) is not int or deployment['schemaVersion'] != 2 or
        deployment['sha256'] != digest
    ):
        reject('manifest-invalid')

    protocol = json_object(read_regular(source / 'src/config/protocol.json', MANIFEST_LIMIT))
    environment = deployment['publicEnvironment']
    if not isinstance(environment, dict) or set(environment) != {'DANT_GUEST_HOST', 'DANT_GUEST_PORT'}:
        reject('network-invalid')
    host, port = environment['DANT_GUEST_HOST'], environment['DANT_GUEST_PORT']
    worker_port = protocol['apiPort']
    if (
        not isinstance(host, str) or host not in ('127.0.0.1', 'localhost') or
        host not in protocol['loopbackHosts'] or
        not isinstance(port, str) or re.fullmatch(r'[1-9][0-9]{0,4}', port) is None or
        not 1 <= int(port) <= 65535 or
        type(worker_port) is not int or not 1 <= worker_port <= 65535
    ):
        reject('network-invalid')
    return {'source': source, 'home': home, 'version': version, 'commit': commit,
            'entries': {entry['path']: entry for entry in normalized},
            'digest': digest, 'guestHost': host, 'guestPort': int(port), 'port': worker_port}


def atomic_write(path, data, mode=0o600):
    path = pathlib.Path(path)
    ordinary_directory(path.parent)
    if path.exists() or path.is_symlink():
        with regular_file(path, max(len(data), MANIFEST_LIMIT)):
            pass
    temporary = path.with_name('.' + path.name + '.' + str(uuid.uuid4()) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def verified_copy(source, target, entry, mode):
    target = pathlib.Path(target)
    ordinary_directory(target.parent)
    if target.exists() or target.is_symlink():
        with regular_file(target, FILE_LIMIT):
            pass
    temporary = target.with_name('.' + target.name + '.' + str(uuid.uuid4()) + '.tmp')
    try:
        with regular_file(source, FILE_LIMIT) as incoming:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
            digest, size = hashlib.sha256(), 0
            with os.fdopen(descriptor, 'wb') as output:
                while block := incoming.read(1024 * 1024):
                    output.write(block)
                    digest.update(block)
                    size += len(block)
                output.flush()
                os.fsync(output.fileno())
            if size != entry['bytes'] or digest.hexdigest() != entry['sha256']:
                reject('bundle-changed')
        os.replace(temporary, target)
        sync_directory(target.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def sync_directory(path):
    if os.name == 'nt':
        return
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def run_quiet(arguments, timeout=SERVICE_TIMEOUT, environment=None, output=None):
    try:
        result = subprocess.run(arguments, stdin=subprocess.DEVNULL,
                                stdout=output or subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env=environment, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        reject('process-unconfirmed')
    if result.returncode != 0:
        reject('process-unconfirmed')


def service_state():
    try:
        result = subprocess.run(
            ['systemctl', '--user', 'show', 'dant-worker.service', '--property=LoadState',
             '--property=ActiveState', '--property=MainPID', '--property=ControlGroup', '--no-pager'],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=SERVICE_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired):
        reject('shutdown-unconfirmed')
    if result.returncode != 0 or len(result.stdout) > SERVICE_LIMIT:
        reject('shutdown-unconfirmed')
    fields = {}
    for line in result.stdout.decode('utf-8').splitlines():
        key, separator, value = line.partition('=')
        if not separator or key in fields or key not in {'LoadState', 'ActiveState', 'MainPID', 'ControlGroup'}:
            reject('shutdown-unconfirmed')
        fields[key] = value
    if set(fields) != {'LoadState', 'ActiveState', 'MainPID', 'ControlGroup'}:
        reject('shutdown-unconfirmed')
    if (
        fields['LoadState'] not in ('loaded', 'not-found') or
        fields['ActiveState'] not in ('active', 'inactive', 'failed') or
        re.fullmatch(r'(?:0|[1-9][0-9]{0,9})', fields['MainPID']) is None or
        (fields['ActiveState'] == 'active') != (fields['MainPID'] != '0')
    ):
        reject('shutdown-unconfirmed')
    return fields


def assert_stopped(home, state=None, proc_root=pathlib.Path('/proc'), cgroup_root=pathlib.Path('/sys/fs/cgroup')):
    state = service_state() if state is None else state
    if (
        state['LoadState'] not in ('loaded', 'not-found') or
        state['ActiveState'] not in ('inactive', 'failed') or state['MainPID'] != '0'
    ):
        reject('shutdown-unconfirmed')
    group = state['ControlGroup']
    if group:
        pure = pathlib.PurePosixPath(group)
        if (
            not group.startswith('/') or str(pure) != group or '..' in pure.parts or
            not group.endswith('/dant-worker.service')
        ):
            reject('shutdown-unconfirmed')
        processes = cgroup_root.joinpath(*pure.parts[1:]) / 'cgroup.procs'
        try:
            if processes.read_bytes().strip():
                reject('shutdown-unconfirmed')
        except FileNotFoundError:
            pass

    expected_data = os.fsencode(str(pathlib.Path(home) / 'dant/data'))
    expected_codex = os.fsencode(str(pathlib.Path(home) / '.dant-codex'))
    # A child can survive a legacy parent or escape its old service cgroup.
    # Its inherited exact data/Codex home still binds it to this Worker.
    for process in proc_root.iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            with (process / 'cmdline').open('rb') as stream:
                arguments = stream.read(32 * 1024 + 1)
            if len(arguments) > 32 * 1024:
                reject('shutdown-unconfirmed')
            command = pathlib.PurePosixPath(os.fsdecode(arguments.split(b'\0', 1)[0])).name
            if command not in ('node', 'nodejs', 'codex', 'dant-core'):
                continue
            with (process / 'environ').open('rb') as stream:
                environment = stream.read(128 * 1024 + 1)
            if len(environment) > 128 * 1024:
                reject('shutdown-unconfirmed')
            fields = environment.split(b'\0')
            if b'DANT_DATA=' + expected_data in fields or b'CODEX_HOME=' + expected_codex in fields:
                reject('shutdown-unconfirmed')
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            reject('shutdown-unconfirmed')


def service_units(configuration):
    host, port, worker_port = configuration['guestHost'], configuration['guestPort'], configuration['port']
    guest = f'''[Unit]
Description=dant local desktop bridge with shared control lease

[Service]
Type=simple
WorkingDirectory=%h/dant/vm
ExecStart=/usr/bin/python3 %h/dant/vm/guest.py
Environment=DISPLAY=:0
Environment=DANT_GUEST_HOST={host}
Environment=DANT_GUEST_PORT={port}
Environment=DANT_CONTROL_FILE=%h/dant/data/computer-control.json
Restart=on-failure
RestartSec=2
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
'''
    worker = f'''[Unit]
Description=dant authoritative Go VM worker
After=default.target dant-guest-local.service
Requires=dant-guest-local.service

[Service]
Type=simple
WorkingDirectory=%h/dant/app
ExecStart=%h/dant/bin/dant-core --role=worker --root=%h/dant/app --data-dir=%h/dant/data --workspace-root=%h/dant/workspaces
Environment=DANT_DATA=%h/dant/data
Environment=DANT_WORKSPACE_ROOT=%h/dant/workspaces
Environment=DISPLAY=:0
Environment=CODEX_HOME=%h/.dant-codex
Environment=DANT_CONTROL_FILE=%h/dant/data/computer-control.json
Environment=DANT_PORT={worker_port}
Environment=DANT_GUEST_HOST={host}
Environment=DANT_GUEST_PORT={port}
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
'''
    return {'dant-guest-local.service': guest.encode(), 'dant-worker.service': worker.encode()}


def local_opener():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, url):
            return None
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def local_session(opener, base, expected=None):
    with opener.open(base + '/api/session', timeout=3) as response:
        session = json_object(response.read(MANIFEST_LIMIT + 1))
    token = session.get('token')
    if not isinstance(token, str) or not 0 < len(token) <= 512:
        reject('session-unconfirmed')
    if expected is not None and (
        session.get('product') != 'dant' or session.get('mode') != 'worker' or
        session.get('runtime') != 'go' or type(session.get('protocol')) is not int or
        session['protocol'] != 1 or session.get('version') != expected['version'] or
        session.get('source') != expected['commit']
    ):
        reject('session-unconfirmed')
    return token


def maintenance_request(opener, base, token, method):
    headers = {'X-Dant-Token': token}
    body = None
    if method == 'POST':
        body = b'{}'
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(
        base + '/api/updates/worker-maintenance', data=body, headers=headers, method=method)
    with opener.open(request, timeout=SERVICE_TIMEOUT) as response:
        raw = response.read(MANIFEST_LIMIT + 1)
    if len(raw) > MANIFEST_LIMIT:
        reject('maintenance-unconfirmed')
    if raw.strip() == b'null':
        return None
    value = json_object(raw)
    if set(value) != {'id'} or not isinstance(value['id'], str) or not LEASE.fullmatch(value['id']):
        reject('maintenance-unconfirmed')
    return value['id']


def reserve_maintenance(configuration):
    opener = local_opener()
    base = f"http://127.0.0.1:{configuration['port']}"
    try:
        token = local_session(opener, base)
        try:
            existing = maintenance_request(opener, base, token, 'GET')
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None  # Only a positively identified legacy route may omit the fence.
            raise
        if existing is not None:
            reject('maintenance-unconfirmed')
        lease = maintenance_request(opener, base, token, 'POST')
        if lease is None:
            reject('maintenance-unconfirmed')
        return lease
    except Exception:
        # The POST may already have acquired the fence. Never resend it, release
        # an uncertain owner, or start a legacy worker as a timeout recovery.
        reject('maintenance-unconfirmed')


def ready(configuration):
    base = f"http://127.0.0.1:{configuration['port']}"
    opener = local_opener()
    try:
        token = local_session(opener, base, configuration)
        request = urllib.request.Request(base + '/api/version', headers={'X-Dant-Token': token})
        with opener.open(request, timeout=2) as response:
            version = json_object(response.read(MANIFEST_LIMIT + 1))
        return version.get('version') == configuration['version']
    except Exception:
        return False


def unix_username():
    import pwd
    return pwd.getpwuid(os.getuid()).pw_name


def ensure_linger():
    username = unix_username()
    run_quiet(['loginctl', 'enable-linger', username])
    try:
        result = subprocess.run(
            ['loginctl', 'show-user', username, '--property=Linger', '--value'],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=SERVICE_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired):
        reject('linger-unconfirmed')
    if result.returncode != 0 or result.stdout.strip() != b'yes':
        reject('linger-unconfirmed')


def activate(configuration, manual=False):
    import fcntl

    home, source = configuration['home'], configuration['source']
    root = ordinary_directory(home / 'dant')
    for directory in ('data', 'workspaces', 'bin', 'vm', 'installation-backups'):
        ordinary_directory(root / directory, create=True)
    service_directory = ordinary_directory(home / '.config/systemd/user', create=True)
    lock_path = root / '.worker-install.lock'
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'rb') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            reject('install-busy')
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            reject('install-busy')
        _activate_locked(configuration, manual, service_directory)


def validate_previous_attempt(previous):
    legacy_fields = {'schemaVersion', 'source', 'phase', 'backup', 'maintenanceId'}
    proof_fields = {
        'attemptId', 'sourceCommit', 'version', 'directory', 'backupBytes',
        'backupModifiedNS', 'backupIdentity', 'backupSha256', 'preparationSha256',
    }
    if (
        set(previous) - (legacy_fields | proof_fields) or
        type(previous.get('schemaVersion')) is not int or previous['schemaVersion'] != 1 or
        not isinstance(previous.get('source'), str) or not SHA256.fullmatch(previous['source']) or
        previous.get('phase') != PHASE_COMMITTED or
        not isinstance(previous.get('backup'), str) or
        re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.raw', previous['backup']) is None or
        'maintenanceId' in previous and (
            not isinstance(previous['maintenanceId'], str) or not LEASE.fullmatch(previous['maintenanceId'])
        )
    ):
        reject('previous-install-unconfirmed')
    # A committed legacy installer receipt can be upgraded. A partial modern
    # receipt cannot masquerade as that legacy format to replay a failed update.
    if not proof_fields.intersection(previous):
        return
    if (
        not proof_fields <= set(previous) or
        not isinstance(previous['attemptId'], str) or not LEASE.fullmatch(previous['attemptId']) or
        not isinstance(previous['sourceCommit'], str) or not COMMIT.fullmatch(previous['sourceCommit']) or
        not isinstance(previous['version'], str) or not VERSION.fullmatch(previous['version']) or
        not isinstance(previous['directory'], str) or
        re.fullmatch(r'source\.[A-Za-z0-9._-]{1,160}', previous['directory']) is None or
        type(previous['backupBytes']) is not int or not 0 < previous['backupBytes'] <= BACKUP_LIMIT or
        not isinstance(previous['backupModifiedNS'], str) or
        re.fullmatch(r'-?[0-9]{1,20}', previous['backupModifiedNS']) is None or
        not isinstance(previous['backupIdentity'], str) or
        re.fullmatch(r'[a-f0-9]{1,16}:[a-f0-9]{1,16}', previous['backupIdentity']) is None or
        not isinstance(previous['backupSha256'], str) or not SHA256.fullmatch(previous['backupSha256']) or
        not isinstance(previous['preparationSha256'], str) or not SHA256.fullmatch(previous['preparationSha256'])
    ):
        reject('previous-install-unconfirmed')


def _activate_locked(configuration, manual, service_directory):
    home, source = configuration['home'], configuration['source']
    root = home / 'dant'
    attempt_path = root / 'install-attempt.json'
    if attempt_path.exists() or attempt_path.is_symlink():
        previous = json_object(read_regular(attempt_path, MANIFEST_LIMIT))
        validate_previous_attempt(previous)

    # Validate busy-work policy again while owning the installation lock.
    arguments = ['bash', str(source / 'vm/install-worker.sh'), str(source), '--guard-only']
    if manual:
        arguments.append('--update-running-work')
    run_quiet(arguments, timeout=PREPARE_TIMEOUT)
    observed_service = service_state()
    attempt = {
        'schemaVersion': 1, 'attemptId': str(uuid.uuid4()),
        'source': configuration['digest'], 'sourceCommit': configuration['commit'],
        'version': configuration['version'], 'directory': source.name,
        'phase': PHASE_RESERVING,
    }
    atomic_write(attempt_path, json.dumps(attempt).encode())
    # The new Worker atomically rejects task/Telegram admission while held. A
    # confirmed old-Node 404 retains its legacy guard plus stopped-process proof.
    lease = reserve_maintenance(configuration) if observed_service['ActiveState'] == 'active' else None
    if lease is not None:
        attempt['maintenanceId'] = lease
    attempt['phase'] = PHASE_STOPPING
    atomic_write(attempt_path, json.dumps(attempt).encode())

    state = service_state()
    if state != observed_service:
        reject('shutdown-unconfirmed')
    if state['LoadState'] != 'not-found':
        run_quiet(['systemctl', '--user', 'stop', 'dant-worker.service'])
    assert_stopped(home)

    # Install only the verified Go binary before schema preparation. A later
    # failure cannot leave a restartable legacy Node unit against migrated data.
    binary_path = root / 'bin/dant-core'
    verified_copy(source / BINARY, binary_path, configuration['entries'][BINARY], 0o700)
    os.chmod(binary_path, 0o700)
    units = service_units(configuration)
    atomic_write(service_directory / 'dant-worker.service', units['dant-worker.service'])
    run_quiet(['systemctl', '--user', 'daemon-reload'])

    environment = dict(os.environ)
    environment.update({
        'DANT_DATA': str(root / 'data'),
        'DANT_WORKSPACE_ROOT': str(root / 'workspaces'),
        'DANT_GUEST_HOST': configuration['guestHost'],
        'DANT_GUEST_PORT': str(configuration['guestPort']),
    })
    backup = root / 'installation-backups' / (str(uuid.uuid4()) + '.raw')
    backup_descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(backup_descriptor, 'wb') as output:
        run_quiet([str(binary_path), '--role=backup-cli', 'export', '--data-dir', str(root / 'data'),
                   '--workspace-root', str(root / 'workspaces'), '--source-id', configuration['digest']],
                  timeout=PREPARE_TIMEOUT, environment=environment, output=output)
        output.flush()
        os.fsync(output.fileno())
    backup_info = backup.lstat()
    if backup_info.st_size == 0:
        reject('backup-unconfirmed')

    attempt['phase'] = PHASE_PREPARING
    attempt['backup'] = backup.name
    attempt['backupBytes'] = backup_info.st_size
    attempt['backupModifiedNS'] = str(backup_info.st_mtime_ns)
    attempt['backupIdentity'] = f'{backup_info.st_dev:x}:{backup_info.st_ino:x}'
    atomic_write(attempt_path, json.dumps(attempt).encode())
    assert_stopped(home)
    run_quiet([str(binary_path), '--role=prepare-worker', '--root=' + str(source),
               '--data-dir=' + str(root / 'data'), '--workspace-root=' + str(root / 'workspaces'),
               '--backup=' + str(backup)], timeout=PREPARE_TIMEOUT, environment=environment)
    assert_stopped(home)
    proof_raw = read_regular(root / PREPARATION_FILE, MANIFEST_LIMIT)
    proof = json_object(proof_raw)
    expected_proof = {key: attempt[key] for key in (
        'schemaVersion', 'attemptId', 'source', 'sourceCommit', 'version', 'directory',
        'backup', 'backupBytes', 'backupModifiedNS', 'backupIdentity')}
    expected_proof.update({'dataDir': str(root / 'data'), 'workspaceRoot': str(root / 'workspaces')})
    expected_proof['backupSha256'] = proof.get('backupSha256')
    if (
        proof != expected_proof or type(proof.get('schemaVersion')) is not int or
        type(proof.get('backupBytes')) is not int or
        not isinstance(proof.get('backupSha256'), str) or not SHA256.fullmatch(proof['backupSha256']) or
        file_identity(backup.lstat()) != file_identity(backup_info)
    ):
        reject('preparation-unconfirmed')
    attempt['backupSha256'] = proof['backupSha256']
    attempt['preparationSha256'] = hashlib.sha256(proof_raw).hexdigest()

    for name in HELPERS:
        relative = 'vm/' + name
        verified_copy(source / relative, root / 'vm' / name, configuration['entries'][relative], 0o700)
        os.chmod(root / 'vm' / name, 0o700)
    atomic_write(service_directory / 'dant-guest-local.service', units['dant-guest-local.service'])
    app = root / 'app'
    if app.exists() and not app.is_symlink():
        reject('app-path-invalid')
    next_link = root / ('.app.' + str(uuid.uuid4()))
    os.symlink(source, next_link, target_is_directory=True)
    os.replace(next_link, app)

    ensure_linger()
    run_quiet(['systemctl', '--user', 'daemon-reload'])
    run_quiet(['systemctl', '--user', 'enable', 'dant-guest-local.service', 'dant-worker.service'])
    run_quiet(['systemctl', '--user', 'restart', 'dant-guest-local.service'])
    attempt['phase'] = PHASE_ACTIVATING
    atomic_write(attempt_path, json.dumps(attempt).encode())
    run_quiet(['systemctl', '--user', 'start', 'dant-worker.service'])
    for _ in range(READY_ATTEMPTS):
        if ready(configuration):
            attempt['phase'] = PHASE_COMMITTED
            atomic_write(attempt_path, json.dumps(attempt).encode())
            atomic_write(root / 'deployed-source.json', read_regular(source / 'deploy-manifest.json', MANIFEST_LIMIT))
            print('DANT_UPDATE_DEPLOYED')
            return
        time.sleep(1)
    reject('readiness-unconfirmed')


def main(arguments):
    if (
        len(arguments) not in (3, 4) or arguments[0] not in ('verify', 'current', 'activate') or
        len(arguments) == 4 and arguments[3] != '--update-running-work'
    ):
        reject('arguments-invalid')
    configuration = verify_bundle(pathlib.Path(arguments[1]), pathlib.Path(arguments[2]))
    if arguments[0] == 'verify':
        print(configuration['guestHost'], configuration['guestPort'], configuration['port'],
              configuration['version'], configuration['digest'], sep='\t')
        return
    if arguments[0] == 'current':
        if not ready(configuration):
            reject('readiness-unconfirmed')
        return
    if os.name != 'posix' or os.getuid() == 0 or sys.platform != 'linux':
        reject('vm-user-required')
    activate(configuration, len(arguments) == 4)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        reason = str(error) if isinstance(error, InstallError) else 'installation-unconfirmed'
        print('DANT_UPDATE_FAILED:' + reason + ':cutover', file=sys.stderr)
        print('The Go Worker cutover was not confirmed. Saved data and its private backup were preserved; no legacy worker was restarted.', file=sys.stderr)
        sys.exit(1)
