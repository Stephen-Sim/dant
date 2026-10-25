"""Read-only desktop-guest service and listener ownership at Worker cutover."""
import hashlib
import itertools
import os
import pathlib
import re
import shlex
import stat
import subprocess
import tempfile

SERVICE_TIMEOUT = 5
SERVICE_BYTES = 16 * 1024
PROCESS_BYTES = 128 * 1024
SOCKET_BYTES = 1024 * 1024
SOCKET_TABLE_NAMES = ('tcp', 'tcp6')
MAXIMUM_FDS = 1024
SCRIPT_BYTES = 256 * 1024
SYSTEM_UNIT = 'dant-guest.service'
USER_UNIT = 'dant-guest-local.service'
SERVICE_FIELDS = ('LoadState', 'ActiveState', 'MainPID', 'ControlGroup', 'Environment', 'EnvironmentFiles')
SYSTEMD_BUS_NAME = 'org.freedesktop.systemd1'
SYSTEMD_MANAGER_PATH = '/org/freedesktop/systemd1'
SYSTEMD_MANAGER_INTERFACE = 'org.freedesktop.systemd1.Manager'
SYSTEMD_SERVICE_INTERFACE = 'org.freedesktop.systemd1.Service'
UNIT_OBJECT_PATH = re.compile(r'/org/freedesktop/systemd1/unit/[A-Za-z0-9_]{1,768}\Z')
# Exact maintained vm/guest.py bytes: foundation 28d96290, Beta14 f3f0925,
# and bootstrap split 3e43f70. Historical seeds remain separately proven by
# their process identity and owned listening socket, never by hash alone.
# Missing legacy port environment is resolved from its owned listening socket,
# never from the new candidate's default protocol.
KNOWN_SEED_SOURCES = frozenset({
    '7826248268557a23c549addc0de0a8ec22933efde2b04528fa06f7daa70c31a5',
    '62cc445b719ba49e790b0748a814836322f4e9bc1ffb059340990421b4288fd8',
    '7e145a071c10999ae901419ce2d81b52aadc2b6afa66684ae816f044a09a1ba8',
})


class GuestProofError(Exception):
    pass


def unconfirmed():
    raise GuestProofError('guest-endpoint-unconfirmed')


def read_bounded(path, maximum):
    path = pathlib.Path(path)
    admitted = path.lstat()
    if not stat.S_ISREG(admitted.st_mode) or admitted.st_nlink != 1:
        unconfirmed()
    # A replacement FIFO must not block open before its handle can be checked.
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, 'rb') as source:
        before = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            (admitted.st_dev, admitted.st_ino, admitted.st_size, admitted.st_mtime_ns) !=
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        ):
            unconfirmed()
        raw = source.read(maximum + 1)
        after = os.fstat(source.fileno())
    if len(raw) > maximum or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
    ):
        unconfirmed()
    return raw


def read_socket_table(path):
    path = pathlib.Path(path)
    if path.name not in SOCKET_TABLE_NAMES:
        unconfirmed()
    admitted = path.lstat()
    if not stat.S_ISREG(admitted.st_mode) or admitted.st_nlink != 1:
        unconfirmed()
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, 'rb') as source:
        before = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            (admitted.st_dev, admitted.st_ino) != (before.st_dev, before.st_ino)
        ):
            unconfirmed()
        # procfs generates socket tables on read. Traffic can change their
        # size/mtime without changing this opened table's identity. Callers
        # separately recheck the exact owned listening sockets and process.
        raw = source.read(SOCKET_BYTES + 1)
        after = os.fstat(source.fileno())
        current = path.lstat()
    if (
        len(raw) > SOCKET_BYTES or
        not stat.S_ISREG(after.st_mode) or after.st_nlink != 1 or
        not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or
        (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) or
        (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino)
    ):
        unconfirmed()
    return raw


def environment_values(raw, separator):
    values = {}
    entries = shlex.split(raw) if separator == 'shell' else raw.split('\x00')
    for entry in entries:
        if not entry:
            continue
        key, equal, value = entry.partition('=')
        if not equal or key in values:
            unconfirmed()
        values[key] = value
    return values


def declared_port(environment):
    host = environment.get('DANT_GUEST_HOST', '127.0.0.1')
    if host not in ('127.0.0.1', 'localhost'):
        unconfirmed()
    port = environment.get('DANT_GUEST_PORT')
    if port is None:
        return None
    if re.fullmatch(r'[1-9][0-9]{0,4}', port) is None or int(port) > 65535:
        unconfirmed()
    return int(port)


class GuestServiceObserver:
    def __init__(self, run=None, proc=None, uid=None, seed=None, readlink=None):
        self.run = subprocess.run if run is None else run
        self.proc = pathlib.Path('/proc') if proc is None else pathlib.Path(proc)
        self.uid = os.getuid() if uid is None else uid
        self.seed = pathlib.Path('/opt/dant/guest.py') if seed is None else pathlib.Path(seed)
        self.readlink = os.readlink if readlink is None else readlink

    def query(self, command):
        # Native output never accumulates in a pipe-backed Python heap. The
        # private anonymous file closes even on timeout; only the bounded prefix
        # may enter the parser, and no native text is copied into diagnostics.
        with tempfile.TemporaryFile() as output:
            reply = self.run(command, stdin=subprocess.DEVNULL, stdout=output,
                             stderr=subprocess.DEVNULL, timeout=SERVICE_TIMEOUT, check=False)
            output.seek(0)
            raw = output.read(SERVICE_BYTES + 1)
        if len(raw) > SERVICE_BYTES:
            unconfirmed()
        return reply.returncode, raw

    def assert_empty_environment_files(self, user):
        prefix = ['busctl', '--user' if user else '--system', '--no-pager']
        status, raw = self.query(prefix + ['call', SYSTEMD_BUS_NAME, SYSTEMD_MANAGER_PATH,
            SYSTEMD_MANAGER_INTERFACE, 'GetUnit', 's', USER_UNIT if user else SYSTEM_UNIT])
        if status != 0:
            unconfirmed()
        try:
            identity = shlex.split(raw.decode('utf-8'))
        except (UnicodeError, ValueError):
            unconfirmed()
        if len(identity) != 2 or identity[0] != 'o' or UNIT_OBJECT_PATH.fullmatch(identity[1]) is None:
            unconfirmed()
        status, raw = self.query(prefix + ['get-property', SYSTEMD_BUS_NAME, identity[1],
            SYSTEMD_SERVICE_INTERFACE, 'EnvironmentFiles'])
        # systemctl v255 omits this empty array even with --all. Missing text
        # is never proof: require the actual Service property and exact type.
        if status != 0 or raw.strip() != b'a(sb) 0':
            unconfirmed()

    def service(self, user=False):
        command = ['systemctl'] + (['--user'] if user else [])
        command += ['show', USER_UNIT if user else SYSTEM_UNIT]
        command += ['--property=' + field for field in SERVICE_FIELDS]
        command += ['--no-pager']
        status, raw = self.query(command)
        fields = environment_values(raw.decode('utf-8').replace('\n', '\x00'), 'nul')
        expected = set(SERVICE_FIELDS)
        missing_environment_files = set(fields) == expected - {'EnvironmentFiles'}
        if set(fields) != expected and not missing_environment_files:
            unconfirmed()
        pid = fields['MainPID']
        if re.fullmatch(r'0|[1-9][0-9]{0,9}', pid) is None or int(pid) > 2147483647:
            unconfirmed()
        if fields['LoadState'] == 'not-found':
            if status not in (0, 1) or fields['ActiveState'] != 'inactive' or pid != '0' or fields['ControlGroup']:
                unconfirmed()
        elif status != 0 or fields['LoadState'] != 'loaded' or fields['ActiveState'] not in ('active', 'inactive', 'failed'):
            unconfirmed()
        if missing_environment_files:
            if fields['LoadState'] == 'not-found':
                # The complete inactive/not-found projection proves absence;
                # querying its nonexistent Service interface cannot add proof.
                if fields['Environment']:
                    unconfirmed()
            else:
                self.assert_empty_environment_files(user)
            fields['EnvironmentFiles'] = ''
        if fields['EnvironmentFiles']:
            unconfirmed()
        return fields

    def process(self, service, script, hashes):
        pid = service['MainPID']
        if service['ActiveState'] != 'active' or pid == '0' or not service['ControlGroup'].startswith('/'):
            unconfirmed()
        root = self.proc / pid
        raw = read_bounded(root / 'stat', PROCESS_BYTES).decode('ascii')
        end = raw.rfind(') ')
        fields = raw[end + 2:].split()
        if (
            not raw.startswith(pid + ' (') or end < 0 or len(fields) < 20 or
            re.fullmatch(r'[1-9][0-9]*', fields[19]) is None
        ):
            unconfirmed()
        status = read_bounded(root / 'status', PROCESS_BYTES).decode('utf-8')
        uids = [line.split()[1:] for line in status.splitlines() if line.startswith('Uid:')]
        if len(uids) != 1 or uids[0] != [str(self.uid)] * 4:
            unconfirmed()
        argv = read_bounded(root / 'cmdline', PROCESS_BYTES).decode('utf-8').rstrip('\x00').split('\x00')
        executable = self.readlink(root / 'exe')
        if (
            len(argv) != 2 or argv[0] != '/usr/bin/python3' or argv[1] != str(script) or
            re.fullmatch(r'/usr/bin/python3(?:\.[0-9]+)?', executable) is None
        ):
            unconfirmed()
        cgroup = read_bounded(root / 'cgroup', PROCESS_BYTES).decode('utf-8').splitlines()
        if cgroup != ['0::' + service['ControlGroup']]:
            unconfirmed()
        digest = hashlib.sha256(read_bounded(script, SCRIPT_BYTES)).hexdigest()
        if digest not in hashes:
            unconfirmed()
        environment = environment_values(read_bounded(root / 'environ', PROCESS_BYTES).decode('utf-8'), 'nul')
        return fields[19], digest, environment, executable

    def socket_inodes(self, service):
        root = self.proc / service['MainPID']
        with os.scandir(root / 'fd') as entries:
            descriptors = [pathlib.Path(entry.path) for entry in itertools.islice(entries, MAXIMUM_FDS + 1)]
        if len(descriptors) > MAXIMUM_FDS:
            unconfirmed()
        sockets = set()
        for descriptor in descriptors:
            try:
                target = self.readlink(descriptor)
            except FileNotFoundError:
                # Connections can close after enumeration. Callers still prove
                # the listener and recheck the service/process identity.
                continue
            match = re.fullmatch(r'socket:\[([1-9][0-9]*)\]', target)
            if match:
                sockets.add(match[1])
        return sockets

    def socket_records(self, directory):
        records = set()
        for name in SOCKET_TABLE_NAMES:
            lines = read_socket_table(directory / name).decode('ascii').splitlines()
            for line in lines[1:]:
                fields = line.split()
                if len(fields) < 10:
                    unconfirmed()
                if fields[3] != '0A':
                    continue
                address, separator, port = fields[1].partition(':')
                address_bytes = 8 if name == 'tcp' else 32
                if not separator or re.fullmatch(r'[A-Fa-f0-9]{' + str(address_bytes) + '}', address) is None or re.fullmatch(r'[A-Fa-f0-9]{4}', port) is None:
                    unconfirmed()
                if re.fullmatch(r'[1-9][0-9]*', fields[9]) is None:
                    unconfirmed()
                records.add((address.upper(), int(port, 16), fields[9]))
        return records

    def listeners(self, service):
        sockets = self.socket_inodes(service)
        records = self.socket_records(self.proc / service['MainPID'] / 'net')
        return {(address, port) for address, port, inode in records if inode in sockets}

    def candidate_listeners(self, configuration):
        records = self.socket_records(self.proc / 'net')
        loopback_or_wildcard = {
            '0100007F', '00000000', '00000000000000000000000000000000',
            '00000000000000000000000001000000', '0000000000000000FFFF00000100007F',
        }
        return {(address, port, inode) for address, port, inode in records
                if port == configuration['guestPort'] and address in loopback_or_wildcard}

    def candidate_available(self, configuration):
        occupied = self.candidate_listeners(configuration)
        if not occupied:
            return
        user = self.service(user=True)
        if not user['ControlGroup'].endswith('/' + USER_UNIT):
            raise GuestProofError('guest-endpoint-conflict')
        script = configuration['home'] / 'dant/vm/guest.py'
        allowed = KNOWN_SEED_SOURCES | {configuration['entries']['vm/guest.py']['sha256']}
        process = self.process(user, script, allowed)
        for environment in (process[2], environment_values(user['Environment'], 'shell')):
            if declared_port(environment) != configuration['guestPort'] or environment.get('DANT_CONTROL_FILE') != str(configuration['home'] / 'dant/data/computer-control.json'):
                unconfirmed()
        sockets = self.socket_inodes(user)
        if any(inode not in sockets for _, _, inode in occupied):
            raise GuestProofError('guest-endpoint-conflict')
        if self.listeners(user) != {('0100007F', configuration['guestPort'])}:
            unconfirmed()
        if self.service(user=True) != user or self.process(user, script, allowed) != process or self.candidate_listeners(configuration) != occupied:
            unconfirmed()

    def system_available(self, configuration):
        self.seed_available(configuration)
        self.candidate_available(configuration)

    def seed_available(self, configuration):
        before = self.service()
        if before['LoadState'] == 'not-found':
            return
        declared = declared_port(environment_values(before['Environment'], 'shell'))
        if declared == configuration['guestPort']:
            raise GuestProofError('guest-endpoint-conflict')
        if before['MainPID'] == '0':
            if declared is None or before['ActiveState'] == 'active':
                unconfirmed()
            return
        if not before['ControlGroup'].endswith('/' + SYSTEM_UNIT):
            unconfirmed()
        allowed = KNOWN_SEED_SOURCES | {configuration['entries']['vm/guest.py']['sha256']}
        process = self.process(before, self.seed, allowed)
        effective = declared_port(process[2])
        if effective is None:
            listeners = self.listeners(before)
            if len(listeners) != 1:
                unconfirmed()
            address, effective = next(iter(listeners))
            if address not in ('0100007F', '00000000000000000000000001000000'):
                unconfirmed()
        if effective == configuration['guestPort']:
            raise GuestProofError('guest-endpoint-conflict')
        if self.service() != before or self.process(before, self.seed, allowed) != process:
            unconfirmed()

    def user_ready(self, configuration):
        before = self.service(user=True)
        if not before['ControlGroup'].endswith('/' + USER_UNIT):
            unconfirmed()
        script = configuration['home'] / 'dant/vm/guest.py'
        expected = {configuration['entries']['vm/guest.py']['sha256']}
        process = self.process(before, script, expected)
        environment = process[2]
        control_file = str(configuration['home'] / 'dant/data/computer-control.json')
        for actual in (environment, environment_values(before['Environment'], 'shell')):
            if (
                declared_port(actual) != configuration['guestPort'] or
                actual.get('DANT_GUEST_HOST') != configuration['guestHost'] or
                actual.get('DANT_CONTROL_FILE') != control_file
            ):
                unconfirmed()
        if self.listeners(before) != {('0100007F', configuration['guestPort'])}:
            unconfirmed()
        # The PID's private network namespace is insufficient: the Worker uses
        # this installer's loopback namespace, whose listener must be the same
        # descriptor-owned socket, with no wildcard or competing listener.
        occupied = self.candidate_listeners(configuration)
        sockets = self.socket_inodes(before)
        if len(occupied) != 1 or any(
            address != '0100007F' or inode not in sockets
            for address, _, inode in occupied
        ):
            unconfirmed()
        if (
            self.service(user=True) != before or
            self.process(before, script, expected) != process or
            self.candidate_listeners(configuration) != occupied
        ):
            unconfirmed()
