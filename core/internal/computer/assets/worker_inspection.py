"""Read-only worker probes embedded in the Go deployer, including before first deployment."""

import json
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request

MAX_CONFIGURATION_BYTES = 64 * 1024
MAX_DEPLOYMENT_BYTES = 4096
MAX_STATE_BYTES = 8 * 1024 * 1024
MAX_PORT = 65_535
DEPLOYMENT_TIMEOUT_SECONDS = 2
STATE_TIMEOUT_SECONDS = 5
LOOPBACK_HOSTS = frozenset({'127.0.0.1', 'localhost'})
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
TOKEN = re.compile(r'[a-fA-F0-9]{32,512}\Z')
ROUTE = re.compile(r'/[a-zA-Z0-9/_-]+\Z')
SERVICE_UNITS = ('dant-worker.service', 'dant-guest-local.service')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def read_configuration(raw):
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_CONFIGURATION_BYTES:
        raise ValueError('invalid_worker_probe_configuration')
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {'origin', 'session', 'version', 'state'}:
        raise ValueError('invalid_worker_probe_configuration')
    if not isinstance(value['origin'], str):
        raise ValueError('invalid_worker_probe_configuration')
    origin = urllib.parse.urlsplit(value['origin'])
    if (origin.scheme != 'http' or origin.hostname not in LOOPBACK_HOSTS or
            origin.username is not None or origin.password is not None or
            origin.path or origin.query or origin.fragment or
            origin.port is None or not 1 <= origin.port <= MAX_PORT):
        raise ValueError('invalid_worker_probe_configuration')
    if any(not isinstance(value[key], str) or not ROUTE.fullmatch(value[key])
           for key in ('session', 'version', 'state')):
        raise ValueError('invalid_worker_probe_configuration')
    return value


def read_response(opener, configuration, route, token, limit, timeout):
    headers = {} if token is None else {'X-Dant-Token': token}
    request = urllib.request.Request(configuration['origin'] + configuration[route], headers=headers)
    with opener.open(request, timeout=timeout) as response:
        raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('worker_probe_response_too_large')
    return json.loads(raw)


def session_token(session):
    if not isinstance(session, dict) or session.get('product') != 'dant' or session.get('mode') != 'worker':
        raise ValueError('invalid_worker_probe_session')
    token = session.get('token')
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError('invalid_worker_probe_session')
    return token


def inspect_deployment(configuration, opener):
    marker = pathlib.Path.home() / 'dant/deployed-source.json'
    fingerprint = None
    try:
        with marker.open('rb') as source:
            data = source.read(MAX_DEPLOYMENT_BYTES + 1)
        if len(data) <= MAX_DEPLOYMENT_BYTES:
            value = json.loads(data).get('sha256')
            if isinstance(value, str) and SHA256.fullmatch(value):
                fingerprint = value
    except (OSError, ValueError, AttributeError):
        pass

    active = all(subprocess.run(
        ['systemctl', '--user', 'is-active', '--quiet', unit],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=DEPLOYMENT_TIMEOUT_SECONDS,
    ).returncode == 0 for unit in SERVICE_UNITS)
    version, build = None, None
    if active:
        try:
            session = read_response(opener, configuration, 'session', None,
                                    MAX_DEPLOYMENT_BYTES, DEPLOYMENT_TIMEOUT_SECONDS)
            token = session_token(session)
            if any(key in session for key in ('runtime', 'protocol', 'source')):
                build = {key: session.get(key) for key in
                         ('product', 'mode', 'runtime', 'protocol', 'version', 'source')}
            candidate = read_response(opener, configuration, 'version', token,
                                      MAX_DEPLOYMENT_BYTES, DEPLOYMENT_TIMEOUT_SECONDS).get('version')
            if isinstance(candidate, str) and 0 < len(candidate) <= 64:
                version = candidate
        except (OSError, ValueError, AttributeError):
            pass
    return {'sha256': fingerprint, 'active': active, 'version': version, 'session': build}


def inspect_quiescence(configuration, opener):
    session = read_response(opener, configuration, 'session', None,
                            MAX_STATE_BYTES, STATE_TIMEOUT_SECONDS)
    token = session_token(session)
    return read_response(opener, configuration, 'state', token,
                         MAX_STATE_BYTES, STATE_TIMEOUT_SECONDS)


def main(arguments):
    if len(arguments) != 2 or arguments[0] not in ('deployment', 'quiescence'):
        raise ValueError('invalid_worker_probe_arguments')
    configuration = read_configuration(arguments[1])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    operation = inspect_deployment if arguments[0] == 'deployment' else inspect_quiescence
    print(json.dumps(operation(configuration, opener), separators=(',', ':')))


if __name__ == '__main__':
    main(sys.argv[1:])
