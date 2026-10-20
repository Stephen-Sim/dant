"""Read the canonical loopback protocol shared by VM helpers and the Go core."""

import json
import os
import pathlib
import re
import stat
import sys
import urllib.request

MAX_PROTOCOL_BYTES = 64 * 1024
MIN_PORT = 1
MAX_PORT = 65535
SCREEN_CHECK_TIMEOUT_SECONDS = 10
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
LOOPBACK_HOSTS = frozenset(('127.0.0.1', 'localhost'))
CANONICAL_LOOPBACK_HOST = '127.0.0.1'
MIN_PATH_LENGTH = 2
MAX_PATH_LENGTH = 128
PROTOCOL_KEYS = frozenset(('loopbackHost', 'loopbackHosts', 'apiPort', 'devPort', 'bootstrapGuestPort', 'guestPort', 'paths'))
PATH_KEYS = frozenset(('api', 'events', 'session', 'version', 'state', 'health', 'screen', 'input', 'control', 'file', 'readFile'))
PROTOCOL_RESOURCE = pathlib.Path('resources/config/protocol.json')
CREDENTIAL_BRIDGE_PATH = '/api/internal/credentials'


def _identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError('The desktop bridge protocol is invalid')
        result[name] = value
    return result


def read_protocol(path):
    path = pathlib.Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_PROTOCOL_BYTES:
        raise ValueError('The desktop bridge protocol file is invalid')

    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags), 'rb') as stream:
        if _identity(os.fstat(stream.fileno())) != _identity(before):
            raise ValueError('The desktop bridge protocol changed')
        data = stream.read(MAX_PROTOCOL_BYTES + 1)
        if len(data) > MAX_PROTOCOL_BYTES or _identity(os.fstat(stream.fileno())) != _identity(before):
            raise ValueError('The desktop bridge protocol changed')
    after = path.lstat()
    if not stat.S_ISREG(after.st_mode) or after.st_nlink != 1 or _identity(after) != _identity(before):
        raise ValueError('The desktop bridge protocol changed')

    protocol = json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object)
    if not isinstance(protocol, dict) or set(protocol) != PROTOCOL_KEYS:
        raise ValueError('The desktop bridge protocol is invalid')
    hosts = protocol['loopbackHosts']
    if (
        not isinstance(hosts, list) or
        not all(isinstance(host, str) for host in hosts) or
        len(hosts) != len(LOOPBACK_HOSTS) or
        set(hosts) != LOOPBACK_HOSTS or
        protocol['loopbackHost'] != CANONICAL_LOOPBACK_HOST
    ):
        raise ValueError('The desktop bridge must use loopback hosts')
    ports = [protocol[name] for name in ('apiPort', 'devPort', 'bootstrapGuestPort', 'guestPort')]
    if any(type(port) is not int or not MIN_PORT <= port <= MAX_PORT for port in ports) or len(set(ports)) != len(ports):
        raise ValueError('The desktop bridge ports are invalid')
    paths = protocol['paths']
    if (
        not isinstance(paths, dict) or set(paths) != PATH_KEYS or
        any(
            not isinstance(path, str) or
            not MIN_PATH_LENGTH <= len(path) <= MAX_PATH_LENGTH or
            re.fullmatch(r'/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*', path) is None
            for path in paths.values()
        )
    ):
        raise ValueError('The desktop bridge paths are invalid')
    if len(set(paths.values())) != len(PATH_KEYS) or any(
        not paths[name].startswith(paths['api'] + '/') for name in ('session', 'version', 'state')
    ):
        raise ValueError('The desktop bridge paths are invalid')
    return protocol


def load_protocol(helper_file=None):
    folder = pathlib.Path(__file__ if helper_file is None else helper_file).resolve().parent
    for root in (folder, folder.parent, folder.parent / 'app'):
        try:
            return read_protocol(root / PROTOCOL_RESOURCE)
        except FileNotFoundError:
            continue
    raise RuntimeError('The desktop bridge protocol configuration is missing')


PROTOCOL = load_protocol()


def api_origin():
    return f"http://{PROTOCOL['loopbackHost']}:{PROTOCOL['apiPort']}"


def guest_bind(environment=None, protocol=None):
    environment = os.environ if environment is None else environment
    protocol = PROTOCOL if protocol is None else protocol
    host = environment.get('DANT_GUEST_HOST', '')
    if host == '':
        host = protocol['loopbackHost']
    if not isinstance(host, str) or host not in LOOPBACK_HOSTS:
        raise ValueError('DANT_GUEST_HOST must be 127.0.0.1 or localhost')
    port = environment.get('DANT_GUEST_PORT', '')
    if port == '':
        port = str(protocol['guestPort'])
    if not isinstance(port, str) or re.fullmatch(r'[1-9][0-9]{0,4}', port) is None or not MIN_PORT <= int(port) <= MAX_PORT:
        raise ValueError('DANT_GUEST_PORT must be an integer from 1 to 65535')
    return host, int(port)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def screen_check(environment=None):
    host, port = guest_bind(environment)
    _screen_check(host, port)


def bootstrap_screen_check():
    _screen_check(PROTOCOL['loopbackHost'], PROTOCOL['bootstrapGuestPort'])


def _screen_check(host, port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(f"http://{host}:{port}{PROTOCOL['paths']['screen']}", timeout=SCREEN_CHECK_TIMEOUT_SECONDS) as response:
        if response.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
            raise ValueError('The desktop screenshot bridge is not ready')


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    if arguments == ['screen-check']:
        screen_check()
    elif arguments == ['bootstrap-screen-check']:
        bootstrap_screen_check()
    else:
        raise ValueError('Invalid desktop network helper operation')


if __name__ == '__main__':
    main()
