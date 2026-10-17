"""One desktop lease shared by CLI model tools and human HTTP input."""
import contextlib
import json
import os
import pathlib
import tempfile
import time
import uuid
try:
    import fcntl
except ImportError:  # Windows tests only; the worker runs on Linux.
    fcntl = None
    import threading
    _test_lock = threading.RLock()

LEASE_SECONDS = 120

def control_path():
    return pathlib.Path(os.environ.get('DANT_CONTROL_FILE', str(pathlib.Path.home() / 'dant/data/computer-control.json')))

@contextlib.contextmanager
def locked():
    target = control_path()
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.parent.is_symlink():
        raise ValueError('Control directory cannot be a symbolic link')
    fd = os.open(str(target) + '.lock', os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            _test_lock.acquire()
        if target.is_symlink():
            raise ValueError('Control state cannot be a symbolic link')
        if target.exists():
            if target.stat().st_size > 4096:
                raise ValueError('Invalid desktop control state')
            state = json.loads(target.read_text())
        else:
            state = {'status': 'dant', 'sessionId': None, 'expiresAt': 0}
        if state.get('expiresAt', 0) <= time.time() * 1000:
            state = {'status': 'dant', 'sessionId': None, 'expiresAt': 0}
        yield state
        handle, temporary = tempfile.mkstemp(prefix='.computer-', dir=target.parent)
        try:
            with os.fdopen(handle, 'w') as out:
                json.dump(state, out)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    finally:
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_UN)
        else:
            _test_lock.release()
        os.close(fd)

def command(body):
    action = body.get('action')
    with locked() as state:
        if action == 'acquire':
            if state['status'] != 'dant':
                raise ValueError('The desktop already has a human control reservation')
            state.update(status='taking-over', sessionId=str(uuid.uuid4()), expiresAt=int((time.time() + LEASE_SECONDS) * 1000))
        elif action == 'status':
            pass
        elif action in ('confirm', 'renew', 'release'):
            if not body.get('sessionId') or state.get('sessionId') != body['sessionId']:
                raise ValueError('Desktop control session expired or does not match')
            if action == 'confirm':
                state['status'] = 'human'
            elif action == 'renew' and state['status'] != 'human':
                raise ValueError('Desktop takeover has not finished')
            if action == 'release':
                state.update(status='dant', sessionId=None, expiresAt=0)
            else:
                state['expiresAt'] = int((time.time() + LEASE_SECONDS) * 1000)
        else:
            raise ValueError('Unknown desktop control action')
        return dict(state)

@contextlib.contextmanager
def desktop_access(session_id=None):
    with locked() as state:
        if session_id is None:
            if state['status'] != 'dant':
                raise ValueError('Desktop is reserved for human control; stop and wait')
        elif state['status'] != 'human' or state.get('sessionId') != session_id:
            raise ValueError('Desktop control session expired or takeover is not confirmed')
        yield
        if session_id is not None:
            state['expiresAt'] = int((time.time() + LEASE_SECONDS) * 1000)
