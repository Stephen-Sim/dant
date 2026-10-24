#!/usr/bin/env python3
"""Explicit root preparation for Ubuntu's per-program user namespace policy.

Only bootstrap or an operator invokes this installer. Worker updates only probe
the existing namespace boundary and must never call this privileged helper.
Policy form: https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces
"""

import argparse
import fnmatch
import os
import pathlib
import re
import shlex
import stat
import subprocess
import sys
import tempfile

TIMEOUT_SECONDS = 10
FILE_LIMIT = 1024 * 1024
TREE_LIMIT = 16 * FILE_LIMIT
ENTRY_LIMIT = 4096
DEPTH_LIMIT = 8
ATTACHMENT_LIMIT = 4096
PROFILE_NAME = 'dant-conversation-bwrap'
PROFILE = b'''# Managed by dant conversation-namespace.py; exact system executable only.
abi <abi/4.0>,
/usr/bin/bwrap flags=(default_allow) {
    userns,
}
'''
PATHS = {
    'bwrap': '/usr/bin/bwrap',
    'true': '/usr/bin/true',
    'runuser': '/usr/sbin/runuser',
    'parser': '/usr/sbin/apparmor_parser',
    'policies': '/etc/apparmor.d',
    'enabled': '/sys/module/apparmor/parameters/enabled',
    'restricted': '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    'loaded': '/sys/kernel/security/apparmor/profiles',
    'kernel': '/sys/kernel/security/apparmor/policy',
}
SKIP_DIRECTORIES = frozenset({'cache', 'disable', 'force-complain'})
USERNAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.-]{0,31}\Z')


class NamespaceError(Exception):
    """Fixed operational code, never a raw parser/process/filesystem error."""


def reject(code):
    raise NamespaceError(code)


def validate_info(info, directory=False):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if info.st_uid != 0 or info.st_mode & 0o022 or not kind(info.st_mode):
        reject('untrusted-system-path')


def trusted_path(value, directory=False):
    path = pathlib.Path(value)
    if not path.is_absolute():
        reject('untrusted-system-path')
    # Ubuntu's usrmerge links are allowed only when every original and resolved
    # ancestor is controlled by root. A writable ancestor invalidates the path.
    for item in reversed((path, *path.parents)):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode):
            if info.st_uid != 0:
                reject('untrusted-system-path')
        else:
            validate_info(info, directory=item != path or directory)
    resolved = path.resolve(strict=True)
    for item in reversed((resolved, *resolved.parents)):
        validate_info(item.lstat(), directory=item != resolved or directory)
    return resolved


def read_trusted(value, limit=FILE_LIMIT):
    path = trusted_path(value)
    return read_regular(path, limit)


def read_regular(path, limit):
    before = path.stat()
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            reject('system-path-changed')
        raw = stream.read(limit + 1)
        after = path.stat()
        if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            reject('system-path-changed')
    if len(raw) > limit:
        reject('policy-limit')
    return raw


def may_attach_bwrap(raw):
    """Conservative superset of AARE; an ambiguous match must stop installation.

    The kernel exports the effective attachment, including variable expansion,
    or <unknown>. Brace/character alternatives are widened to a wildcard, never
    narrowed to Python glob semantics. No policy content is executed or logged.
    """
    try:
        value = raw.decode('utf-8').rstrip('\n')
    except UnicodeError:
        return True
    if not value or '<' in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        return True
    if '\\' in value or '^' in value:
        return True
    widened, index = '', 0
    while index < len(value):
        char = value[index]
        if char in '{[':
            closing, depth = ('}' if char == '{' else ']'), 1
            index += 1
            while index < len(value) and depth:
                if value[index] == char:
                    depth += 1
                elif value[index] == closing:
                    depth -= 1
                index += 1
            if depth:
                return True
            widened += '*'
        elif char in '}]':
            return True
        elif char == '@' and index + 1 < len(value) and value[index + 1] == '{':
            # The following iteration widens the whole variable expression.
            index += 1
        else:
            widened += char
            index += 1
    return any(fnmatch.fnmatchcase(path, widened) for path in ('/usr/bin/bwrap', '/bin/bwrap'))


def ordinary_account(username):
    if not isinstance(username, str) or not USERNAME.fullmatch(username):
        reject('ordinary-user-required')
    import pwd
    account = pwd.getpwnam(username)
    if account.pw_uid <= 0 or account.pw_gid < 0 or not pathlib.PurePosixPath(account.pw_dir).is_absolute():
        reject('ordinary-user-required')
    return account


def check_configured_attachments(raw):
    """Accept conventional single-line headers; reject unresolved syntax.

    This is deliberately not another AppArmor parser. The kernel inspection
    proves loaded attachments; this extra conservative check protects configured
    but inactive headers. Variables in ordinary rules/tunables are not headers.
    """
    try:
        lines = raw.decode('utf-8').splitlines()
    except UnicodeError:
        reject('policy-inspection-unavailable')
    for line in lines:
        line = line.strip()
        if line.startswith('#') and not line.startswith('#include'):
            continue
        if re.match(r'#?include\s', line) and re.search(r'["\']|<\s*/', line):
            reject('policy-inspection-unavailable')
        if re.match(r'@\{[A-Za-z][A-Za-z0-9_]*\}\s*\+?=', line):
            continue
        openings = list(re.finditer(r'(?:^|\s|\))\{', line))
        if len(openings) > 1 or re.search(r'(?:^|\s)namespace\s', line):
            reject('policy-inspection-unavailable')
        if not re.match(r'(?:profile\b|[/"@])', line):
            if openings and re.search(r'(?:^|\s)(?:profile\b|[/"@])', line[:openings[0].start()]):
                reject('policy-inspection-unavailable')
            continue
        body = openings[0] if openings else None
        if body is None:
            if line.endswith(',') and not line.startswith('profile'):
                continue
            reject('policy-inspection-unavailable')
        header = line[:body.start()].strip()
        if '\\' in header or len(header) > ATTACHMENT_LIMIT:
            reject('policy-inspection-unavailable')
        try:
            tokens = shlex.split(header, comments=True)
        except ValueError:
            reject('policy-inspection-unavailable')
        if tokens and tokens[0] == 'profile':
            tokens = tokens[1:]
        if not tokens:
            reject('policy-inspection-unavailable')
        attachment = tokens[0] if tokens[0].startswith(('/', '@', '*', '?', '[')) else None
        if len(tokens) > 1 and not tokens[1].startswith(('flags=', 'xattrs=', '(', 'flags(', 'xattrs(')):
            attachment = tokens[1]
        if attachment is not None and may_attach_bwrap(attachment.encode('utf-8')):
            reject('existing-bwrap-policy')


class NamespaceSetup:
    def __init__(self, paths=None, runner=None):
        # Injection is for isolated tests, never exposed as CLI path overrides.
        self.paths = dict(PATHS if paths is None else paths)
        self.runner = subprocess.run if runner is None else runner

    def run(self, arguments, raw=None):
        options = {
            'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL,
            'timeout': TIMEOUT_SECONDS, 'check': False, 'close_fds': True,
            'shell': False, 'cwd': '/',
            'env': {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'},
        }
        if raw is None:
            options['stdin'] = subprocess.DEVNULL
        else:
            options['input'] = raw
        try:
            return self.runner(arguments, **options).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            reject('system-command-unavailable')

    def probe(self, username):
        return self.run([
            self.paths['runuser'], '--user', username, '--',
            self.paths['bwrap'], '--die-with-parent', '--new-session',
            '--unshare-all', '--share-net', '--cap-drop', 'ALL',
            '--ro-bind', '/', '/', '--remount-ro', '/', '--', self.paths['true'],
        ])

    def check_conflicts(self):
        loaded = read_trusted(self.paths['loaded'], 4 * FILE_LIMIT)
        if b'bwrap' in loaded.lower():
            reject('existing-bwrap-policy')
        self.check_loaded_attachments(loaded)
        root = trusted_path(self.paths['policies'], directory=True)
        pending = [(root, 0)]
        count, total = 0, 0
        while pending:
            directory, depth = pending.pop()
            for item in directory.iterdir():
                count += 1
                if count > ENTRY_LIMIT or depth > DEPTH_LIMIT:
                    reject('policy-limit')
                info = item.lstat()
                if stat.S_ISDIR(info.st_mode):
                    trusted_path(item, directory=True)
                    if item.name not in SKIP_DIRECTORIES:
                        pending.append((item, depth + 1))
                    continue
                # These conventional inactive-profile directories are never
                # traversed. Elsewhere links or unsafe policy inputs fail closed.
                if stat.S_ISLNK(info.st_mode):
                    reject('untrusted-system-path')
                raw = read_trusted(item)
                total += len(raw)
                if total > TREE_LIMIT:
                    reject('policy-limit')
                if 'bwrap' in item.name.lower() or b'bwrap' in raw.lower():
                    reject('existing-bwrap-policy')
                check_configured_attachments(raw)
        if read_trusted(self.paths['loaded'], 4 * FILE_LIMIT) != loaded:
            reject('system-path-changed')
        return root

    def check_loaded_attachments(self, loaded):
        # AppArmor's policy entry is a kernel magic link, not a filesystem
        # symlink that realpath() can resolve. Only this fixed entry is allowed;
        # all other components and exposed files must be root-owned/nonwritable.
        # Linux security/apparmor/apparmorfs.c: policy_readlink and
        # seq_profile_attach_show define this read-only introspection interface.
        root = pathlib.Path(self.paths['kernel'])
        trusted_path(root.parent, directory=True)
        info = root.lstat()
        if stat.S_ISLNK(info.st_mode):
            if info.st_uid != 0 or not re.fullmatch(r'apparmorfs:\[[0-9]+\]', os.readlink(root)):
                reject('policy-inspection-unavailable')
        else:
            validate_info(info, directory=True)
        validate_info(root.stat(), directory=True)
        pending, count, names = [(root / 'profiles', 0, b'')], 0, []
        while pending:
            directory, depth, prefix = pending.pop()
            validate_info(directory.lstat(), directory=True)
            for profile in directory.iterdir():
                count += 1
                if count > ENTRY_LIMIT or depth > DEPTH_LIMIT:
                    reject('policy-limit')
                validate_info(profile.lstat(), directory=True)
                for name in ('attach', 'name'):
                    validate_info((profile / name).lstat())
                if may_attach_bwrap(read_regular(profile / 'attach', ATTACHMENT_LIMIT)):
                    reject('existing-bwrap-policy')
                name = read_regular(profile / 'name', ATTACHMENT_LIMIT).rstrip(b'\n')
                qualified = prefix + b'//' + name if prefix else name
                names.append(qualified)
                children = profile / 'profiles'
                if children.exists():
                    pending.append((children, depth + 1, qualified))
        expected = [line.rsplit(b' (', 1)[0] for line in loaded.splitlines()]
        if sorted(names) != sorted(expected):
            reject('policy-inspection-unavailable')

    def publish(self, root):
        target = root / PROFILE_NAME
        candidate = None
        identity = None
        try:
            with tempfile.NamedTemporaryFile(prefix='.dant-bwrap-', dir=root, delete=False) as stream:
                candidate = pathlib.Path(stream.name)
                identity = os.fstat(stream.fileno())
                stream.write(PROFILE)
                stream.flush()
                os.fsync(stream.fileno())
            # link() fails if any file/link already occupies the target. Unlike
            # replace(), it can never overwrite an administrator's policy.
            os.link(candidate, target, follow_symlinks=False)
        except FileExistsError:
            reject('existing-bwrap-policy')
        finally:
            if candidate is not None and identity is not None:
                current = candidate.lstat()
                if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                    candidate.unlink()
        if read_trusted(target) != PROFILE:
            reject('system-path-changed')
        return target

    def install(self, username='dant'):
        if getattr(os, 'geteuid', lambda: -1)() != 0:
            reject('root-required')
        ordinary_account(username)
        for key in ('runuser', 'bwrap', 'true'):
            trusted_path(self.paths[key])
        if self.probe(username):
            return 'already-ready'
        if (read_trusted(self.paths['enabled'], 16).strip() != b'Y' or
                read_trusted(self.paths['restricted'], 16).strip() != b'1'):
            reject('namespace-unavailable')
        trusted_path(self.paths['parser'])
        root = self.check_conflicts()
        parser = [self.paths['parser'], '--config-file=/dev/null', '--skip-cache', '--jobs=0']
        if not self.run([*parser, '--skip-kernel-load'], PROFILE):
            reject('policy-not-supported')
        target = self.publish(root)
        # --add deliberately refuses an existing loaded profile; never replace,
        # reload all policy, or relax the system-wide namespace restrictions.
        if not self.run([*parser, '--add', str(target)]):
            reject('policy-activation-unconfirmed')
        if not self.probe(username):
            reject('namespace-still-unavailable')
        return 'installed'


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', required=True)
    parser.add_argument('--user', default='dant')
    options = parser.parse_args(arguments)
    try:
        result = NamespaceSetup().install(options.user)
    except (NamespaceError, OSError, KeyError, ImportError) as error:
        code = str(error) if isinstance(error, NamespaceError) else 'system-configuration-unavailable'
        print('conversation-namespace: ' + code, file=sys.stderr)
        return 1
    print('conversation-namespace: ' + result)
    return 0


if __name__ == '__main__':
    sys.exit(main())
