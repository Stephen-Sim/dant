#!/bin/bash
set -euo pipefail
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 - "$script_dir/transcription-requirements.txt" <<'PY'
import fcntl, hashlib, json, os, pathlib, platform, shutil, stat, subprocess, sys, tempfile, time, urllib.request, uuid, venv

REVISION = '536b0662742c02347bc0e980a01041f333bce120'
FILES = {
    'config.json': (2370, 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828'),
    'model.bin': (483546902, '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'),
    'tokenizer.json': (2203239, 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab'),
    'vocabulary.txt': (459861, '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913'),
}


class SetupError(Exception):
    pass


def safe_directory(directory, home, create=False):
    if directory != home and home not in directory.parents:
        raise SetupError('unsafe_path')
    # Inspect each component before mkdir; never follow a symlink into a new root.
    current = home
    for component in [None] + list(directory.relative_to(home).parts):
        if component is not None:
            current = current / component
        if current.is_symlink():
            raise SetupError('unsafe_path')
        if not current.exists():
            if not create:
                raise SetupError('unsafe_path')
            current.mkdir(mode=0o700)
        if not current.is_dir() or current.absolute() != current.resolve():
            raise SetupError('unsafe_path')


def remove_staging(directory, parent):
    if (directory.parent != parent or directory.is_symlink() or
        not directory.name.startswith(('.transcription-stage-', '.transcription-old-'))):
        raise SetupError('unsafe_path')
    if directory.exists():
        safe_directory(directory, pathlib.Path.home().absolute())
        shutil.rmtree(directory)


def model_valid(directory):
    try:
        if directory.is_symlink() or not directory.is_dir():
            return False
        for name, (size, digest) in FILES.items():
            file = directory / name
            if file.is_symlink() or not file.is_file() or file.stat().st_size != size:
                return False
            with file.open('rb') as source:
                if hashlib.file_digest(source, 'sha256').hexdigest() != digest:
                    return False
        return True
    except OSError:
        return False


def imports_valid(root):
    result = subprocess.run([str(root / 'venv/bin/python'), '-c',
                             'import av,ctranslate2,faster_whisper,numpy'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45,
                            env={**os.environ, 'HF_HUB_OFFLINE': '1', 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2'})
    return result.returncode == 0


def install():
    if os.geteuid() == 0 or sys.version_info[:2] != (3, 12) or platform.machine() != 'x86_64':
        raise SetupError('unsupported_platform')
    home = pathlib.Path.home().absolute()
    parent = home / 'dant/runtime'
    safe_directory(parent, home, create=True)
    root = parent / 'transcription'
    if root.exists() or root.is_symlink():
        safe_directory(root, home)
    requirements = pathlib.Path(sys.argv[1])
    if requirements.is_symlink() or not requirements.is_file() or requirements.stat().st_size > 65536:
        raise SetupError('invalid_lock')
    lock = requirements.read_bytes()
    identity = {'format': 1, 'engine': 'faster-whisper==1.2.1', 'model': 'Systran/faster-whisper-small',
                'revision': REVISION, 'files': FILES, 'requirementsSha256': hashlib.sha256(lock).hexdigest()}
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    descriptor = os.open(parent / '.transcription-install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as guard:
        if not stat.S_ISREG(os.fstat(guard.fileno()).st_mode) or os.fstat(guard.fileno()).st_nlink != 1:
            raise SetupError('unsafe_path')
        fcntl.flock(guard, fcntl.LOCK_EX)
        marker = root / 'deployment.json'
        if marker.is_file() and not marker.is_symlink() and marker.stat().st_size <= 65536:
            try:
                current = json.loads(marker.read_text())
                if current.get('fingerprint') == fingerprint and model_valid(root / 'model') and imports_valid(root):
                    print('The pinned local transcription engine is already available.')
                    return
            except (ValueError, OSError, subprocess.SubprocessError):
                pass
        stage = pathlib.Path(tempfile.mkdtemp(prefix='.transcription-stage-', dir=parent))
        backup = parent / ('.transcription-old-' + uuid.uuid4().hex)
        try:
            venv.EnvBuilder(with_pip=False).create(stage / 'venv')
            (stage / 'requirements.lock').write_bytes(lock)
            command = [sys.executable, '-m', 'pip', '--python', str(stage / 'venv/bin/python'), '--isolated',
                       'install', '--disable-pip-version-check', '--no-input', '--no-cache-dir',
                       '--only-binary=:all:', '--require-hashes', '--index-url', 'https://pypi.org/simple',
                       '-r', str(stage / 'requirements.lock')]
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=240)
            if result.returncode:
                raise SetupError('dependency_install')
            model = stage / 'model'
            model.mkdir(mode=0o700)
            deadline = time.monotonic() + 300
            for name, (size, digest) in FILES.items():
                url = 'https://huggingface.co/Systran/faster-whisper-small/resolve/' + REVISION + '/' + name
                checksum, received = hashlib.sha256(), 0
                with urllib.request.urlopen(url, timeout=60) as response, (model / name).open('xb') as target:
                    while chunk := response.read(1024 * 1024):
                        received += len(chunk)
                        if received > size or time.monotonic() > deadline:
                            raise SetupError('model_download')
                        checksum.update(chunk)
                        target.write(chunk)
                if received != size or checksum.hexdigest() != digest:
                    raise SetupError('model_verification')
            if not model_valid(model) or not imports_valid(stage):
                raise SetupError('runtime_verification')
            (stage / 'deployment.json').write_text(json.dumps({**identity, 'fingerprint': fingerprint}, indent=2))
            if root.exists():
                os.replace(root, backup)
            try:
                os.replace(stage, root)
            except BaseException:
                if backup.exists() and not root.exists():
                    os.replace(backup, root)
                raise
            if backup.exists():
                remove_staging(backup, parent)
            print('Pinned local transcription installed; audio stays inside the VM.')
        finally:
            if stage.exists():
                remove_staging(stage, parent)


try:
    install()
except Exception as error:
    code = str(error) if isinstance(error, SetupError) else 'setup_failed'
    print('Local transcription setup failed (' + code + '); existing runtime preserved.', file=sys.stderr)
    sys.exit(1)
PY
