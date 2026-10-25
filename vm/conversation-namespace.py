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
import stat
import subprocess
import sys
import tempfile
import time

TIMEOUT_SECONDS = 10
FILE_LIMIT = 1024 * 1024
TREE_LIMIT = 16 * FILE_LIMIT
ENTRY_LIMIT = 4096
DEPTH_LIMIT = 8
ATTACHMENT_LIMIT = 4096
PATTERN_LIMIT = 256
ATTACHMENT_POLL_LIMIT = 200
ATTACHMENT_POLL_INTERVAL = 0.01
INSPECTION_ATTEMPTS = 3
INSPECTION_RETRY_SECONDS = 0.25
PIPE_READ_WAIT = frozenset({b'pipe_read', b'anon_pipe_read'})
NAMESPACES = ('cgroup', 'ipc', 'mnt', 'net', 'pid', 'pid_for_children',
              'time', 'time_for_children', 'user', 'uts')
PROFILE_NAME = 'dant-conversation-bwrap'
PROFILE_IDENTITY = b'/usr/bin/bwrap'
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
    'revision': '/sys/kernel/security/apparmor/revision',
    'namespace_level': '/sys/kernel/security/apparmor/.ns_level',
    'context': '/proc/self/attr/apparmor/current',
}
SKIP_DIRECTORIES = frozenset({'cache', 'disable', 'force-complain'})
# Match libapparmor's loader exclusions, not an independent recursive loader.
SKIP_SUFFIXES = ('.dpkg-new', '.dpkg-old', '.dpkg-dist', '.dpkg-bak', '.dpkg-remove',
                 '.pacsave', '.pacnew', '.rpmnew', '.rpmsave', '.orig', '.rej', '~')
DIRECTIVES = re.compile(r'"(?:\\.|[^"\\])*"|\\.|(?P<kind>#include\b|(?<![A-Za-z0-9_./@-])(?:include|abi)(?=\s|$))|#[^\n]*')
INCLUDE = re.compile(r'(?:#include\s*|include\s+|abi\s+)(?P<optional>if\s+exists\s+)?(?P<path><[^<>]+>|"[^"\n]+")')
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


def file_identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def read_kernel_once(value, limit):
    # AppArmor's revision file is an event stream: another read on the same
    # descriptor waits for the next policy change. Never buffered-read to EOF.
    path = trusted_path(value)
    before = path.stat()
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(descriptor)
        raw = os.read(descriptor, limit + 1)
        if (file_identity(before) != file_identity(opened) or
                file_identity(opened) != file_identity(path.stat())):
            reject('system-path-changed')
        if len(raw) > limit:
            reject('policy-limit')
        return raw
    finally:
        os.close(descriptor)


def process_value(path, limit=ATTACHMENT_LIMIT):
    # Only fixed metadata of this process or its owned child is accepted here.
    with path.open('rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        reject('policy-inspection-unavailable')
    return raw


def process_identity(raw):
    # A Linux comm can contain spaces and ')'; none of it enters diagnostics.
    closing = raw.rfind(b') ')
    fields = raw[closing + 2:].split()
    if closing < 0 or len(fields) < 20 or not fields[1].isdigit() or not fields[19].isdigit():
        reject('policy-inspection-unavailable')
    return int(fields[1]), int(fields[19])


def namespace_identity(root):
    # These fixed proc namespace magic links are kernel-owned, not user paths.
    return tuple((name, (info.st_dev, info.st_ino)) for name in NAMESPACES
                 for info in [(root / 'ns' / name).stat()])


class AttachmentObserver:
    """Observe actual exec attachment without creating a namespace or policy.

    Bubblewrap 0.8-0.10 reads --args to EOF before namespace setup. Keeping an
    empty pipe's writer open blocks that owned child in argument parsing. Exact
    parent/child namespace identity and a positive pipe-read wait also reject an
    incompatible startup. The child is always killed/joined before either pipe
    end closes. No other process, process group, or policy is changed.
    """

    def __init__(self, paths, account, spawner=None, sleeper=None):
        self.paths = paths
        self.account = account
        self.spawner = subprocess.Popen if spawner is None else spawner
        self.sleeper = time.sleep if sleeper is None else sleeper

    def boundary(self):
        level = read_kernel_once(self.paths['namespace_level'], 16)
        context = process_value(pathlib.Path(self.paths['context']))
        revision = read_kernel_once(self.paths['revision'], 64)
        if (level != b'0\n' or context != b'unconfined\n' or
                re.fullmatch(rb'[0-9]{1,20}\n', revision) is None):
            reject('policy-inspection-unavailable')
        return revision, namespace_identity(pathlib.Path('/proc/self'))

    def child_identity(self, child, image, pipe, read_fd, namespaces):
        if child.poll() is not None:
            reject('policy-inspection-unavailable')
        root = pathlib.Path('/proc') / str(child.pid)
        identity = process_identity(process_value(root / 'stat'))
        expected = ((b'Uid:', self.account.pw_uid), (b'Gid:', self.account.pw_gid))
        status = process_value(root / 'status', 64 * ATTACHMENT_LIMIT).splitlines()
        for prefix, value in expected:
            fields = next((line.split()[1:] for line in status if line.startswith(prefix)), [])
            if len(fields) != 4 or any(not field.isdigit() or int(field) != value for field in fields):
                reject('policy-inspection-unavailable')
        with (root / 'exe').open('rb') as stream:
            actual_image = file_identity(os.fstat(stream.fileno()))
        actual_pipe = (root / 'fd' / str(read_fd)).stat()
        label = process_value(root / 'attr/apparmor/current')
        if (identity[0] != os.getpid() or identity[1] <= 0 or actual_image != image or
                label != b'unconfined\n' or namespace_identity(root) != namespaces or
                not stat.S_ISFIFO(actual_pipe.st_mode) or
                (actual_pipe.st_dev, actual_pipe.st_ino) != pipe):
            reject('existing-bwrap-policy')
        if (process_identity(process_value(root / 'stat')) != identity or
                child.poll() is not None):
            reject('system-path-changed')
        if process_value(root / 'wchan', 128).strip() not in PIPE_READ_WAIT:
            return None
        return identity, actual_image, label

    def observe(self):
        before, namespaces = self.boundary()
        image_path = trusted_path(self.paths['bwrap'])
        image = image_path.stat()
        if image.st_mode & 0o6000:
            reject('untrusted-system-path')
        try:
            capabilities = os.getxattr(image_path, 'security.capability')
        except OSError as error:
            import errno
            if error.errno != errno.ENODATA:
                raise
        else:
            if capabilities:
                reject('untrusted-system-path')
        with image_path.open('rb') as image_stream:
            opened = os.fstat(image_stream.fileno())
            if file_identity(image) != file_identity(opened):
                reject('system-path-changed')
            read_fd, write_fd = os.pipe()
            child = None
            try:
                pipe = os.fstat(read_fd)
                if not stat.S_ISFIFO(pipe.st_mode):
                    reject('policy-inspection-unavailable')
                child = self.spawner([
                    self.paths['bwrap'], '--args', str(read_fd),
                ], user=self.account.pw_uid, group=self.account.pw_gid, extra_groups=[],
                    pass_fds=(read_fd,), close_fds=True, shell=False, cwd='/',
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
                first = None
                for _ in range(ATTACHMENT_POLL_LIMIT):
                    observed = self.child_identity(child, file_identity(opened),
                        (pipe.st_dev, pipe.st_ino), read_fd, namespaces)
                    if observed is not None:
                        if first == observed:
                            break
                        first = observed
                    self.sleeper(ATTACHMENT_POLL_INTERVAL)
                else:
                    reject('policy-inspection-unavailable')
                if (self.boundary() != (before, namespaces) or
                        file_identity(image_path.stat()) != file_identity(opened)):
                    reject('system-path-changed')
                return before
            finally:
                # In particular, never deliver EOF to a live --args reader.
                if child is not None:
                    child.kill()
                    child.wait(timeout=TIMEOUT_SECONDS)
                os.close(read_fd)
                os.close(write_fd)


def attachment_patterns(value):
    """Expand literal AARE alternatives with explicit size/depth limits.

    Variables and character classes remain widened, never narrowed to Python's
    different glob syntax. None means inspection cannot exclude an attachment.
    """
    def expand(index, depth, grouped=False):
        parts, alternatives, comma = [''], [], False
        while index < len(value):
            char = value[index]
            if grouped and char in ',}':
                alternatives.extend(parts)
                if len(alternatives) > PATTERN_LIMIT:
                    return None
                if char == '}':
                    return (alternatives, index + 1) if comma else None
                parts, comma, index = [''], True, index + 1
                continue
            if char == '{':
                if depth >= DEPTH_LIMIT:
                    return None
                nested = expand(index + 1, depth + 1, True)
                if nested is None:
                    return None
                suffixes, index = nested
            elif char == '[':
                closing = value.find(']', index + 1)
                if closing < 0:
                    return None
                suffixes, index = ['*'], closing + 1
            elif char == '@' and index + 1 < len(value) and value[index + 1] == '{':
                closing = value.find('}', index + 2)
                if closing < 0 or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', value[index + 2:closing]):
                    return None
                suffixes, index = ['*'], closing + 1
            elif char == '@' and (variable := re.match(r'@[A-Za-z][A-Za-z0-9_]*', value[index:])):
                suffixes, index = ['*'], index + len(variable[0])
            elif char in '}]':
                return None
            else:
                suffixes, index = [char], index + 1
            if len(parts) * len(suffixes) > PATTERN_LIMIT:
                return None
            parts = [prefix + suffix for prefix in parts for suffix in suffixes]
            if any(len(part) > ATTACHMENT_LIMIT for part in parts):
                return None
        return None if grouped else (parts, index)

    expanded = expand(0, 0)
    return None if expanded is None else expanded[0]


def may_attach_bwrap(raw):
    """A bounded conservative AARE match, preserving literal alternative scope."""
    if len(raw) > ATTACHMENT_LIMIT:
        return True
    try:
        value = raw.decode('utf-8').rstrip('\n')
    except UnicodeError:
        return True
    if not value or '<' in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        return True
    if '\\' in value or '^' in value:
        return True
    patterns = attachment_patterns(value)
    return patterns is None or any(fnmatch.fnmatchcase(path, pattern)
        for path in ('/usr/bin/bwrap', '/bin/bwrap') for pattern in patterns)


def ordinary_account(username):
    if not isinstance(username, str) or not USERNAME.fullmatch(username):
        reject('ordinary-user-required')
    import pwd
    account = pwd.getpwnam(username)
    if account.pw_uid <= 0 or account.pw_gid < 0 or not pathlib.PurePosixPath(account.pw_dir).is_absolute():
        reject('ordinary-user-required')
    return account


def check_includes(raw):
    """Extract literal include inputs, including inline and ABI directives.

    The graph owner validates absolute targets and all ancestors before a parser
    sees them. Quotes/comments are lexed so rule paths and comments are not
    mistaken for directives. Complex unresolved paths fail closed.
    """
    try:
        text = raw.decode('utf-8')
    except UnicodeError:
        reject('policy-inspection-unavailable')
    inputs = []
    for token in DIRECTIVES.finditer(text):
        if token['kind'] is None:
            continue
        match = INCLUDE.match(text, token.start())
        if match is None or (token['kind'] == 'abi' and not text[match.end():].lstrip().startswith(',')):
            reject('policy-inspection-unavailable')
        wrapped = match['path']
        value = wrapped[1:-1]
        absolute = wrapped.startswith('"')
        if (not re.fullmatch(r'[A-Za-z0-9_./+-]+', value) or
                absolute != value.startswith('/') or
                any(part in ('', '.', '..') for part in value.strip('/').split('/')) or
                (not absolute and value.split('/')[0] in SKIP_DIRECTORIES)):
            reject('policy-inspection-unavailable')
        inputs.append((value, absolute, match['optional'] is not None))
    return inputs


def policy_tokens(raw):
    """Lex only quoted words and block scope; the system parser validates policy.

    AARE and variable braces remain inside words. Unsupported/ambiguous lexical
    forms stop inspection rather than being interpreted as harmless rule text.
    """
    try:
        text = raw.decode('utf-8')
    except UnicodeError:
        reject('policy-inspection-unavailable')
    word, quote, alternatives, index = '', False, 0, 0
    while index < len(text):
        char = text[index]
        if char == '\\':
            if index + 1 == len(text):
                reject('policy-inspection-unavailable')
            word += text[index:index + 2]
            index += 2
            continue
        if char == '"':
            quote = not quote
        elif quote:
            if char in '\r\n':
                reject('policy-inspection-unavailable')
            word += char
        elif char == '#':
            index = text.find('\n', index)
            if index < 0:
                break
            continue
        elif char.isspace():
            if alternatives:
                reject('policy-inspection-unavailable')
            if word:
                yield word
                word = ''
            if char == '\n':
                yield '\n'
        elif char == '{':
            if word:
                alternatives += 1
                word += char
            else:
                yield char
        elif char == '}':
            if alternatives:
                alternatives -= 1
                word += char
            else:
                if word:
                    yield word
                    word = ''
                yield char
        else:
            if ord(char) < 32 or ord(char) == 127:
                reject('policy-inspection-unavailable')
            word += char
        index += 1
    if quote or alternatives:
        reject('policy-inspection-unavailable')
    if word:
        yield word


def check_configured_attachments(raw, expected_names=None):
    """Inspect global headers of canonical preprocessed policy, never rule text.

    --names supplies the system parser's syntax check; --preprocess expands
    includes in their actual parent scope. Auxiliary fragments and child profiles
    cannot independently attach an unconfined /usr/bin/bwrap execution.
    """
    header, depth, variable_depth, names = [], 0, 0, []

    def assignment():
        return re.match(r'[@$](?:\{[A-Za-z][A-Za-z0-9_]*\}|[A-Za-z][A-Za-z0-9_]*)\s*(?:\+=|\?=|:=|=)', ' '.join(header))
    for token in policy_tokens(raw):
        if token == '\n':
            if variable_depth:
                continue
            if not depth and header[:1] == ['alias']:
                reject('policy-inspection-unavailable')
            if not depth and header and ((header[0] == 'abi' and header[-1].endswith(',')) or assignment()):
                header = []
            continue
        if variable_depth:
            if token == '{':
                variable_depth += 1
            elif token == '}':
                variable_depth -= 1
            header.append(token)
            continue
        if token == '{':
            if not depth and assignment():
                variable_depth = 1
                header.append(token)
                continue
            if not depth:
                tokens = header[1:] if header[:1] == ['profile'] else header
                if (not tokens or len(' '.join(tokens)) > ATTACHMENT_LIMIT or
                        any('\\' in value for value in tokens)):
                    reject('policy-inspection-unavailable')
                name = tokens[0]
                if name.encode('utf-8') == PROFILE_IDENTITY:
                    reject('existing-bwrap-policy')
                implicit = name.startswith(('/', '@', '*', '?', '['))
                if (header[:1] != ['profile'] and not implicit) or name.startswith(':'):
                    reject('policy-inspection-unavailable')
                attachment = name if implicit else None
                attributes = tokens[1:]
                if attributes and not attributes[0].startswith(('flags', 'xattrs', '(')):
                    attachment = attributes.pop(0)
                    if not attachment.startswith(('/', '@', '*', '?', '[')):
                        reject('policy-inspection-unavailable')
                if not re.fullmatch(r'(?:\([^()]*\)\s*)?(?:(?:flags|xattrs)\s*=?\s*\([^()]*\)\s*)*', ' '.join(attributes)):
                    reject('policy-inspection-unavailable')
                if attachment is not None and may_attach_bwrap(attachment.encode('utf-8')):
                    reject('existing-bwrap-policy')
                names.append(name.encode('utf-8'))
            depth += 1
            if depth > DEPTH_LIMIT:
                reject('policy-limit')
            header = []
        elif token == '}':
            if not depth:
                reject('policy-inspection-unavailable')
            depth -= 1
            header = []
        elif not depth:
            header.append(token)
    if depth or variable_depth or header:
        reject('policy-inspection-unavailable')
    if expected_names is not None:
        roots = [name for name in expected_names.splitlines() if b'//' not in name]
        if sorted(roots) != sorted(names):
            reject('policy-inspection-unavailable')
    return len(names)


def loader_file(name):
    return not (name.startswith('.') or name == 'README' or name.endswith(SKIP_SUFFIXES))


def limit_parser_output():
    # Only the root-owned Linux parser child uses this boundary. A regular-file
    # stdout cap also bounds expansion of repeated includes, before RAM reads.
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (TREE_LIMIT, TREE_LIMIT))


class NamespaceSetup:
    def __init__(self, paths=None, runner=None):
        # Injection is for isolated tests, never exposed as CLI path overrides.
        self.paths = dict(PATHS if paths is None else paths)
        self.runner = subprocess.run if runner is None else runner
        self.conflict_snapshot = None
        self.published_identity = None

    def run(self, arguments, raw=None, output=None):
        options = {
            'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL,
            'timeout': TIMEOUT_SECONDS, 'check': False, 'close_fds': True,
            'shell': False, 'cwd': '/',
            'env': {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'},
        }
        if output is not None:
            options['stdout'] = output
            options['preexec_fn'] = limit_parser_output
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

    def policy_epoch(self):
        revision = read_kernel_once(self.paths['revision'], 64)
        if (re.fullmatch(rb'[0-9]{1,20}\n', revision) is None or
                read_kernel_once(self.paths['namespace_level'], 16) != b'0\n' or
                process_value(pathlib.Path(self.paths['context'])) != b'unconfined\n'):
            reject('policy-inspection-unavailable')
        return revision

    def check_conflicts(self, username='dant'):
        epoch = self.policy_epoch()
        loaded = read_trusted(self.paths['loaded'], 4 * FILE_LIMIT)
        opaque = self.check_loaded_attachments(loaded)
        root = trusted_path(self.paths['policies'], directory=True)
        before = self.policy_inputs(root)
        parser = [self.paths['parser'], '--config-file=/dev/null', '--skip-cache',
                  '--jobs=0', '--base', str(root), '--skip-kernel-load']
        for item in before[0]:
            if item.parent != root or not loader_file(item.name):
                continue
            names = self.inspect_policy([*parser, '--names', str(item)])
            expanded = self.inspect_policy([*parser, '--preprocess', str(item)])
            if PROFILE_IDENTITY in names.splitlines():
                reject('existing-bwrap-policy')
            check_configured_attachments(expanded, names)
        self.conflict_snapshot = root, loaded, before, epoch
        self.validate_conflicts(root)
        if opaque:
            # Official AppArmor 4.x serializes the xmatch DFA without an attach
            # string, so ordinary profiles expose exactly <unknown>. Never infer
            # that such a profile is harmless from its name/configured source:
            # require a positive ordinary exec observation at this policy epoch.
            observed = AttachmentObserver(self.paths, ordinary_account(username)).observe()
            if observed != epoch:
                reject('system-path-changed')
            self.validate_conflicts(root)
        return root

    def validate_conflicts(self, root, published=None):
        if self.conflict_snapshot is None or self.conflict_snapshot[0] != root:
            reject('policy-inspection-unavailable')
        _, loaded, expected, epoch = self.conflict_snapshot
        current = self.policy_inputs(root, published)
        if published is not None:
            files, directories, missing = current
            own = files.pop(published, None)
            if own != (self.published_identity, PROFILE):
                reject('system-path-changed')
            actual_root, entries = directories[root]
            expected_root, expected_entries = expected[1][root]
            if (actual_root[:2] != expected_root[:2] or
                    tuple(item for item in entries if item != published) != expected_entries):
                reject('system-path-changed')
            # Only this installer's exact new entry may account for the root
            # directory metadata change. Every existing file/dir/input remains
            # compared; an optional include becoming present is still a change.
            directories[root] = expected[1][root]
            for target, (ancestor, identity) in list(missing.items()):
                old = expected[2].get(target)
                if ancestor == root and old is not None and identity[:2] == old[1][:2]:
                    missing[target] = old
        if (current != expected or self.policy_epoch() != epoch or
                read_trusted(self.paths['loaded'], 4 * FILE_LIMIT) != loaded):
            reject('system-path-changed')

    def inspect_policy(self, arguments):
        with tempfile.TemporaryFile() as output:
            if not self.run(arguments, output=output):
                reject('policy-inspection-unavailable')
            output.seek(0)
            raw = output.read(TREE_LIMIT + 1)
            if len(raw) > TREE_LIMIT:
                reject('policy-limit')
            return raw

    def policy_inputs(self, root, published=None):
        pending, files, directories, missing = [(root, 0)], {}, {}, {}
        count, total = 0, 0

        def identity(info):
            return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns

        def capture_file(path):
            nonlocal count, total
            if path in files:
                return
            count += 1
            if count > ENTRY_LIMIT:
                reject('policy-limit')
            before = path.stat()
            raw = read_trusted(path)
            if identity(before) != identity(path.stat()):
                reject('system-path-changed')
            total += len(raw)
            if total > TREE_LIMIT:
                reject('policy-limit')
            files[path] = (identity(before), raw)

        def capture_directory(path):
            nonlocal count
            trusted_path(path, directory=True)
            if path not in directories:
                count += 1
            if count > ENTRY_LIMIT:
                reject('policy-limit')
            entries = tuple(sorted(path.iterdir()))
            directories[path] = (identity(path.stat()), entries)
            return entries

        # Root loader candidates are immediate files. Auxiliary directories are
        # captured for ownership/stability but are not independent profiles.
        while pending:
            directory, depth = pending.pop()
            if depth > DEPTH_LIMIT:
                reject('policy-limit')
            for item in capture_directory(directory):
                info = item.lstat()
                if stat.S_ISDIR(info.st_mode):
                    trusted_path(item, directory=True)
                    if directory != root or item.name not in SKIP_DIRECTORIES:
                        pending.append((item, depth + 1))
                elif stat.S_ISLNK(info.st_mode):
                    reject('untrusted-system-path')
                else:
                    capture_file(item)

        roots = [path for path in files if path.parent == root and loader_file(path.name) and path != published]
        queue, visited = [(path, 0) for path in roots], set()
        while queue:
            path, depth = queue.pop()
            if path in visited:
                continue
            visited.add(path)
            if depth > DEPTH_LIMIT:
                reject('policy-limit')
            for value, absolute, optional in check_includes(files[path][1]):
                target = pathlib.Path(value) if absolute else root / value
                try:
                    info = target.stat()
                except FileNotFoundError:
                    if not optional:
                        reject('policy-inspection-unavailable')
                    ancestor = target
                    while True:
                        try:
                            ancestor.lstat()
                            break
                        except FileNotFoundError:
                            ancestor = ancestor.parent
                    # An existing/broken target symlink is not optional absence.
                    if ancestor == target:
                        reject('untrusted-system-path')
                    trusted_path(ancestor, directory=True)
                    missing[target] = (ancestor, identity(ancestor.stat()))
                    if len(missing) + count > ENTRY_LIMIT:
                        reject('policy-limit')
                    continue
                if stat.S_ISDIR(info.st_mode):
                    for child in capture_directory(target):
                        if child.is_dir():
                            trusted_path(child, directory=True)
                        elif loader_file(child.name):
                            capture_file(child)
                            queue.append((child, depth + 1))
                else:
                    capture_file(target)
                    queue.append((target, depth + 1))
        return files, directories, missing

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
        pending, count, names, opaque = [(root / 'profiles', 0, b'')], 0, [], False
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
                attachment = read_regular(profile / 'attach', ATTACHMENT_LIMIT)
                if not prefix:
                    if attachment == b'<unknown>\n':
                        opaque = True
                    elif may_attach_bwrap(attachment):
                        reject('existing-bwrap-policy')
                name = read_regular(profile / 'name', ATTACHMENT_LIMIT).rstrip(b'\n')
                if not prefix and name == PROFILE_IDENTITY:
                    reject('existing-bwrap-policy')
                qualified = prefix + b'//' + name if prefix else name
                names.append(qualified)
                children = profile / 'profiles'
                if children.exists():
                    pending.append((children, depth + 1, qualified))
        expected = [line.rsplit(b' (', 1)[0] for line in loaded.splitlines()]
        if sorted(names) != sorted(expected):
            reject('policy-inspection-unavailable')
        return opaque

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
        published = target.stat()
        if (published.st_dev, published.st_ino) != (identity.st_dev, identity.st_ino):
            reject('system-path-changed')
        self.published_identity = file_identity(published)
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
        parser = [self.paths['parser'], '--config-file=/dev/null', '--skip-cache', '--jobs=0']
        root = self.inspect_before_publication(username, parser)
        # These checks detect observed policy/input changes, not an atomic lock
        # against an independent administrator changing policy during --add.
        target = self.publish(root)
        self.validate_conflicts(root, target)
        # --add deliberately refuses an existing loaded profile; never replace,
        # reload all policy, or relax the system-wide namespace restrictions.
        if not self.run([*parser, '--add', str(target)]):
            reject('policy-activation-unconfirmed')
        if not self.probe(username):
            reject('namespace-still-unavailable')
        return 'installed'

    def target_absent(self):
        try:
            (pathlib.Path(self.paths['policies']) / PROFILE_NAME).lstat()
        except FileNotFoundError:
            return True
        except OSError:
            reject('policy-inspection-unavailable')
        return False

    def inspect_before_publication(self, username, parser):
        # Boot-time policy loaders may change AppArmor's revision during this
        # read-only phase. Each retry starts a complete fresh inspection, only
        # while the exact destination is positively absent. Publication and all
        # later actions stay outside the loop, including ambiguous failures.
        for attempt in range(INSPECTION_ATTEMPTS):
            self.conflict_snapshot = None
            if not self.target_absent():
                reject('existing-bwrap-policy')
            try:
                root = self.check_conflicts(username)
                if not self.run([*parser, '--skip-kernel-load'], PROFILE):
                    reject('policy-not-supported')
                self.validate_conflicts(root)
                if not self.target_absent():
                    reject('existing-bwrap-policy')
                return root
            except NamespaceError as error:
                if (str(error) != 'system-path-changed' or
                        attempt + 1 >= INSPECTION_ATTEMPTS or not self.target_absent()):
                    raise
                time.sleep(INSPECTION_RETRY_SECONDS)


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', required=True)
    parser.add_argument('--user', default='dant')
    options = parser.parse_args(arguments)
    try:
        result = NamespaceSetup().install(options.user)
    except (NamespaceError, OSError, KeyError, ImportError, ValueError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, NamespaceError) else 'system-configuration-unavailable'
        print('conversation-namespace: ' + code, file=sys.stderr)
        return 1
    print('conversation-namespace: ' + result)
    return 0


if __name__ == '__main__':
    sys.exit(main())
