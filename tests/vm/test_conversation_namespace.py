"""Root namespace setup uses only synthetic filesystem and subprocess boundaries."""

import contextlib
import importlib.util
import io
import os
import pathlib
import runpy
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'vm/conversation-namespace.py'
SPEC = importlib.util.spec_from_file_location('conversation_namespace', SCRIPT)
namespace = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(namespace)


class NamespaceFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.paths = {}
        for key, name in namespace.PATHS.items():
            path = self.root / name.lstrip('/')
            path.parent.mkdir(parents=True, exist_ok=True)
            if key in ('policies', 'kernel'):
                path.mkdir()
            else:
                path.write_bytes({'enabled': b'Y\n', 'restricted': b'1\n', 'loaded': b'other (enforce)\n'}.get(key, b'fixed binary'))
            self.paths[key] = str(path)
        profiles = pathlib.Path(self.paths['kernel']) / 'profiles/other.1'
        profiles.mkdir(parents=True)
        (profiles / 'attach').write_bytes(b'/usr/bin/other\n')
        (profiles / 'name').write_bytes(b'other\n')
        self.calls = []
        self.probes = [1, 0]
        self.parser_results = [0, 0]
        self.setup = namespace.NamespaceSetup(self.paths, self.run_fake)
        self.addCleanup(patch.stopall)
        patch.object(namespace.os, 'geteuid', return_value=0, create=True).start()
        patch.object(namespace, 'ordinary_account', return_value=types.SimpleNamespace(pw_uid=1000)).start()
        # Windows fixture owners/modes are not Unix ownership proof. Exercise
        # that separate boundary below with explicit stat records, not a real
        # root policy directory. No production path can reach this fixture.
        patch.object(namespace, 'trusted_path', side_effect=self.fixture_path).start()
        patch.object(namespace, 'validate_info', side_effect=lambda info, directory=False: self.assertTrue(
            stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))).start()

    def fixture_path(self, value, directory=False):
        path = pathlib.Path(value)
        self.assertTrue(path.is_relative_to(self.root))
        self.assertFalse(path.is_symlink())
        self.assertTrue(path.is_dir() if directory else path.is_file())
        return path

    def run_fake(self, arguments, **options):
        self.calls.append((list(arguments), dict(options)))
        self.assertFalse(options['shell'])
        self.assertEqual(options['timeout'], 10)
        self.assertTrue(options['close_fds'])
        self.assertEqual(options['cwd'], '/')
        self.assertEqual(options['env'], {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        self.assertEqual(options['stdout'], subprocess.DEVNULL)
        self.assertEqual(options['stderr'], subprocess.DEVNULL)
        self.assertNotIn('--replace', arguments)
        self.assertNotIn('--remove', arguments)
        code = self.probes.pop(0) if arguments[0] == self.paths['runuser'] else self.parser_results.pop(0)
        return types.SimpleNamespace(returncode=code)

    def assert_rejected(self, code):
        return self.assertRaisesRegex(namespace.NamespaceError, '^' + code + '$')

    def test_working_system_is_noop_even_with_existing_vendor_policy(self):
        vendor = pathlib.Path(self.paths['policies']) / 'bwrap'
        vendor.write_bytes(b'/usr/bin/bwrap flags=(unconfined) { userns, }')
        self.probes = [0]
        with patch.dict(os.environ, {'SECRET_SYNTHETIC': 'do-not-inherit'}):
            self.assertEqual(self.setup.install('ordinary.test'), 'already-ready')
        self.assertEqual(len(self.calls), 1)
        arguments, options = self.calls[0]
        self.assertEqual(arguments[:4], [self.paths['runuser'], '--user', 'ordinary.test', '--'])
        self.assertIn('--unshare-all', arguments)
        self.assertIn('--remount-ro', arguments)
        self.assertEqual(arguments[-2:], ['--', self.paths['true']])
        self.assertEqual(options['stdin'], subprocess.DEVNULL)
        self.assertEqual(vendor.read_bytes(), b'/usr/bin/bwrap flags=(unconfined) { userns, }')
        self.assertEqual(list(vendor.parent.iterdir()), [vendor])

    def test_fresh_install_validates_then_adds_only_fixed_attached_profile(self):
        self.assertEqual(self.setup.install(), 'installed')
        target = pathlib.Path(self.paths['policies']) / namespace.PROFILE_NAME
        self.assertEqual(target.read_bytes(), namespace.PROFILE)
        self.assertEqual(list(target.parent.iterdir()), [target])
        self.assertEqual(len(self.calls), 4)
        validate, activate = self.calls[1:3]
        self.assertIn('--skip-kernel-load', validate[0])
        self.assertIn('--config-file=/dev/null', validate[0])
        self.assertIn('--skip-cache', validate[0])
        self.assertIn('--jobs=0', validate[0])
        self.assertEqual(validate[1]['input'], namespace.PROFILE)
        self.assertEqual(activate[0][-2:], ['--add', str(target)])
        self.assertNotIn('input', activate[1])
        self.assertNotIn('include', namespace.PROFILE.decode())
        self.assertIn(b'abi <abi/4.0>', namespace.PROFILE)
        self.assertIn(b'/usr/bin/bwrap flags=(default_allow)', namespace.PROFILE)
        self.assertEqual(pathlib.Path(self.paths['restricted']).read_bytes(), b'1\n')

    def test_nonroot_never_probes_or_reads_system_configuration(self):
        with patch.object(namespace.os, 'geteuid', return_value=1000), self.assert_rejected('root-required'):
            self.setup.install()
        self.assertEqual(self.calls, [])

    def test_other_namespace_failures_do_not_create_or_load_a_policy(self):
        for key, value in [('enabled', b'N'), ('restricted', b'0'), ('restricted', b'unknown')]:
            with self.subTest(key=key, value=value):
                pathlib.Path(self.paths[key]).write_bytes(value)
                self.probes = [1]
                with self.assert_rejected('namespace-unavailable'):
                    self.setup.install()
                pathlib.Path(self.paths[key]).write_bytes(b'Y' if key == 'enabled' else b'1')
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(list(pathlib.Path(self.paths['policies']).iterdir()), [])

    def test_existing_loaded_named_or_vendor_reference_is_preserved(self):
        policies = pathlib.Path(self.paths['policies'])
        for location in ['loaded', 'bwrap', 'vendor-app', namespace.PROFILE_NAME]:
            with self.subTest(location=location):
                target = pathlib.Path(self.paths['loaded']) if location == 'loaded' else policies / location
                before = b'profile vendor /usr/bin/bwrap flags=(unconfined) { userns, }'
                target.write_bytes(before)
                self.probes = [1]
                with self.assert_rejected('existing-bwrap-policy'):
                    self.setup.install()
                self.assertEqual(target.read_bytes(), before)
                if location == 'loaded':
                    target.write_bytes(b'other (enforce)')
                else:
                    target.unlink()
        self.assertEqual(len(self.calls), 4)

    def test_scan_includes_local_overrides_and_refuses_untrusted_links(self):
        policies = pathlib.Path(self.paths['policies'])
        local = policies / 'local'
        local.mkdir()
        policy = local / 'vendor'
        policy.write_bytes(b'/bin/bwrap userns,')
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.check_conflicts()
        policy.write_bytes(b'unrelated policy')
        fake_link = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        original = pathlib.Path.lstat
        with patch.object(pathlib.Path, 'lstat', lambda path: fake_link if path == policy else original(path)), self.assert_rejected('untrusted-system-path'):
            self.setup.check_conflicts()

    def test_scan_is_bounded_and_skips_disabled_profile_link_directories(self):
        policies = pathlib.Path(self.paths['policies'])
        disabled = policies / 'disable'
        disabled.mkdir()
        (disabled / 'vendor').write_bytes(b'/usr/bin/bwrap')
        unrelated = policies / 'vendor'
        unrelated.write_bytes(b'other')
        self.assertEqual(self.setup.check_conflicts(), policies)
        for name, value in [('ENTRY_LIMIT', 0), ('DEPTH_LIMIT', -1), ('TREE_LIMIT', 1), ('FILE_LIMIT', 1)]:
            with self.subTest(limit=name), patch.object(self.setup, 'check_loaded_attachments'), patch.object(namespace, name, value), self.assert_rejected('policy-limit'):
                if name == 'FILE_LIMIT':
                    namespace.read_trusted(unrelated, 1)
                else:
                    self.setup.check_conflicts()

    def test_parser_validation_failure_has_no_published_or_loaded_policy(self):
        self.parser_results = [1]
        with self.assert_rejected('policy-not-supported'):
            self.setup.install()
        self.assertEqual(list(pathlib.Path(self.paths['policies']).iterdir()), [])
        self.assertEqual(len(self.calls), 2)

    def test_unconfirmed_activation_and_postprobe_preserve_only_new_policy_for_review(self):
        for activation, probes, reason in [([0, 1], [1], 'policy-activation-unconfirmed'),
                                          ([0, 0], [1, 1], 'namespace-still-unavailable')]:
            with self.subTest(reason=reason):
                self.parser_results, self.probes = activation, probes
                with self.assert_rejected(reason):
                    self.setup.install()
                target = pathlib.Path(self.paths['policies']) / namespace.PROFILE_NAME
                self.assertEqual(target.read_bytes(), namespace.PROFILE)
                target.unlink()

    def test_racing_admin_file_is_never_overwritten_or_removed(self):
        policies = pathlib.Path(self.paths['policies'])
        target = policies / namespace.PROFILE_NAME
        target.write_bytes(b'admin-replacement')
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.publish(policies)
        self.assertEqual(target.read_bytes(), b'admin-replacement')
        self.assertEqual(list(policies.iterdir()), [target])

    def test_write_failure_cleans_only_the_new_ignored_candidate(self):
        policies = pathlib.Path(self.paths['policies'])
        with patch.object(namespace.os, 'fsync', side_effect=OSError('synthetic-private-output')), self.assertRaises(OSError):
            self.setup.publish(policies)
        self.assertEqual(list(policies.iterdir()), [])

    def test_failed_candidate_creation_never_removes_an_existing_file(self):
        with patch.object(namespace.tempfile, 'NamedTemporaryFile', side_effect=OSError('synthetic')), self.assertRaises(OSError):
            self.setup.publish(pathlib.Path(self.paths['policies']))

    def test_unconfirmed_candidate_identity_is_preserved_for_review(self):
        policies = pathlib.Path(self.paths['policies'])
        with patch.object(namespace.os, 'fstat', side_effect=OSError('synthetic')), self.assertRaises(OSError):
            self.setup.publish(policies)
        self.assertEqual(len(list(policies.iterdir())), 1)

    def test_cleanup_preserves_a_replaced_candidate_and_checks_published_bytes(self):
        policies = pathlib.Path(self.paths['policies'])
        link = os.link

        def replace_candidate(candidate, target, **options):
            link(candidate, target, **options)
            candidate.unlink()
            candidate.write_bytes(b'administrator-replacement')

        with patch.object(namespace.os, 'link', side_effect=replace_candidate):
            target = self.setup.publish(policies)
        replacements = [path for path in policies.iterdir() if path != target]
        self.assertEqual(len(replacements), 1)
        self.assertEqual(replacements[0].read_bytes(), b'administrator-replacement')
        self.assertEqual(target.read_bytes(), namespace.PROFILE)
        target.unlink()
        with patch.object(namespace, 'read_trusted', return_value=b'changed'), self.assert_rejected('system-path-changed'):
            self.setup.publish(policies)

    def test_command_failure_is_fixed_and_never_copies_process_output(self):
        for error in (FileNotFoundError('private-path'), subprocess.TimeoutExpired('private-command', 1, output=b'private-output')):
            with self.subTest(error=type(error).__name__):
                self.setup.runner = lambda *_args, **_options: (_ for _ in ()).throw(error)
                with self.assert_rejected('system-command-unavailable'):
                    self.setup.probe('dant')

    def test_loaded_broad_or_unknown_attachments_block_installation_without_policy_changes(self):
        attachment = pathlib.Path(self.paths['kernel']) / 'profiles/other.1/attach'
        for raw in (b'/usr/bin/b*', b'/usr/{bin,sbin}/*', b'@{bin}/b*', b'<unknown>'):
            with self.subTest(attachment=raw):
                attachment.write_bytes(raw)
                self.probes = [1]
                with self.assert_rejected('existing-bwrap-policy'):
                    self.setup.install()
                self.assertEqual(list(pathlib.Path(self.paths['policies']).iterdir()), [])
        self.assertEqual(len(self.calls), 4)

    def test_inactive_broad_or_variable_policy_is_not_weakened_on_next_boot(self):
        policy = pathlib.Path(self.paths['policies']) / 'administrator'
        for raw in (b'profile box /usr/bin/b* { }', b'/usr/bin/* { }',
                    b'profile box @{some_directory}/b* { }'):
            with self.subTest(policy=raw):
                policy.write_bytes(raw)
                with self.assert_rejected('existing-bwrap-policy'):
                    self.setup.check_conflicts()
                self.assertEqual(policy.read_bytes(), raw)

    def test_kernel_inventory_preserves_nested_profile_identity_and_requires_completeness(self):
        parent = pathlib.Path(self.paths['kernel']) / 'profiles/other.1'
        child = parent / 'profiles/child.2'
        child.mkdir(parents=True)
        (child / 'attach').write_bytes(b'/usr/lib/other/child')
        (child / 'name').write_bytes(b'child\n')
        loaded = b'other (enforce)\nother//child (complain)\n'
        self.setup.check_loaded_attachments(loaded)
        with self.assert_rejected('policy-inspection-unavailable'):
            self.setup.check_loaded_attachments(b'other (enforce)\n')
        for key, value in [('ENTRY_LIMIT', 0), ('DEPTH_LIMIT', -1)]:
            with self.subTest(limit=key), patch.object(namespace, key, value), self.assert_rejected('policy-limit'):
                self.setup.check_loaded_attachments(loaded)

    def test_only_the_exact_root_owned_kernel_magic_link_is_accepted(self):
        root = pathlib.Path(self.paths['kernel'])
        original = pathlib.Path.lstat
        info = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0)
        with patch.object(pathlib.Path, 'lstat', lambda path: info if path == root else original(path)):
            with patch.object(namespace.os, 'readlink', return_value='apparmorfs:[12345]'):
                self.setup.check_loaded_attachments(b'other (enforce)\n')
            with patch.object(namespace.os, 'readlink', return_value='/tmp/foreign-policy'), self.assert_rejected('policy-inspection-unavailable'):
                self.setup.check_loaded_attachments(b'other (enforce)\n')
            info.st_uid = 1000
            with self.assert_rejected('policy-inspection-unavailable'):
                self.setup.check_loaded_attachments(b'other (enforce)\n')

    def test_changed_loaded_inventory_does_not_authorize_a_policy(self):
        read = namespace.read_trusted
        count = 0

        def changed(path, limit=namespace.FILE_LIMIT):
            nonlocal count
            if str(path) == self.paths['loaded']:
                count += 1
                if count == 2:
                    return b'new-profile (enforce)'
            return read(path, limit)

        with patch.object(namespace, 'read_trusted', side_effect=changed), self.assert_rejected('system-path-changed'):
            self.setup.check_conflicts()


class NamespaceBoundaryTests(unittest.TestCase):
    def test_attachment_matching_is_conservative_without_evaluating_aare_or_variables(self):
        matches = [b'/usr/bin/bwrap', b'/bin/bwrap', b'/usr/bin/*', b'/usr/bin/b[0-9]*',
            b'/usr/{bin,sbin}/b*', b'/usr/{{bin,sbin},lib}/b*', b'@{bin}/b*',
            b'<unknown>', b'/usr/bin/\\142wrap', b'^/usr/bin/other', b'/usr/bin/b*\nextra',
            b'/usr/bin/b*\r\n', b'', b'\xff', b'/usr/{bin', b'/usr/bin/]', b'/usr/bin/}']
        for raw in matches:
            with self.subTest(raw=raw):
                self.assertTrue(namespace.may_attach_bwrap(raw))
        for raw in [b'/usr/bin/other', b'/usr/lib/*', b'@{lib}/other', b'other', b'/usr/bin/[xy]other']:
            with self.subTest(raw=raw):
                self.assertFalse(namespace.may_attach_bwrap(raw))

    def test_configured_headers_distinguish_rules_and_refuse_unsupported_syntax(self):
        namespace.check_configured_attachments(b'''# profile ignored comment
@{HOME}=/home/*
include <tunables/global>
profile other /usr/bin/other flags=(enforce) {
  /** mr,
  @{HOME}/** rw,
}
profile named_only { }
"/usr/bin/other" { }
''')
        invalid = [b'profile { }', b'profile multiline\n /usr/bin/other { }', b'profile escape /usr/bin/oth\\er { }',
            b'profile "unclosed { }', b'profile a /usr/bin/a { } profile b /** { }',
            b'} /** { }', b'namespace hidden { }', b'#include "/outside/policy"',
            b'include </outside/policy>', b'\xff', b'profile ' + b'x' * 4097 + b' { }']
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
                namespace.check_configured_attachments(raw)
        for raw in [b'profile box /usr/bin/b* { }', b'profile box @{location}/b* { }', b'/** { }']:
            with self.subTest(raw=raw), self.assertRaisesRegex(namespace.NamespaceError, '^existing-bwrap-policy$'):
                namespace.check_configured_attachments(raw)

    def test_system_ownership_types_and_permissions_are_explicit(self):
        for mode, owner, directory in [(stat.S_IFREG | 0o755, 0, False), (stat.S_IFDIR | 0o755, 0, True)]:
            namespace.validate_info(types.SimpleNamespace(st_mode=mode, st_uid=owner), directory)
        for mode, owner, directory in [(stat.S_IFREG | 0o777, 0, False), (stat.S_IFREG | 0o755, 1000, False),
                                       (stat.S_IFLNK | 0o777, 0, False), (stat.S_IFIFO | 0o600, 0, False),
                                       (stat.S_IFREG | 0o644, 0, True), (stat.S_IFDIR | 0o755, 0, False)]:
            with self.subTest(mode=mode, owner=owner), self.assertRaisesRegex(namespace.NamespaceError, '^untrusted-system-path$'):
                namespace.validate_info(types.SimpleNamespace(st_mode=mode, st_uid=owner), directory)

    def test_relative_system_path_and_untrusted_symlink_fail_closed(self):
        with self.assertRaisesRegex(namespace.NamespaceError, '^untrusted-system-path$'):
            namespace.trusted_path('relative')
        path = pathlib.Path('/synthetic-link')
        original = pathlib.Path.lstat
        with patch.object(pathlib.Path, 'lstat', lambda current: types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=1000) if current == path else original(current)), self.assertRaisesRegex(namespace.NamespaceError, '^untrusted-system-path$'):
            namespace.trusted_path(path)

    def test_root_owned_usrmerge_links_and_resolved_ancestors_are_validated(self):
        records = {}
        aliases = {}

        class SystemPath(pathlib.PurePosixPath):
            def lstat(self):
                return records.get(str(self), types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0))

            def resolve(self, strict):
                self.assert_strict = strict
                return SystemPath(aliases.get(str(self), str(self)))

        binary = '/bin/synthetic-tool'
        resolved = '/usr/bin/synthetic-tool'
        records[binary] = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0)
        records[resolved] = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_uid=0)
        aliases[binary] = resolved
        with patch.object(namespace.pathlib, 'Path', SystemPath):
            self.assertEqual(namespace.trusted_path(binary), SystemPath(resolved))
            records[binary] = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=1000)
            with self.assertRaisesRegex(namespace.NamespaceError, '^untrusted-system-path$'):
                namespace.trusted_path(binary)
            records[binary] = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0)
            records['/usr/bin'] = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o777, st_uid=0)
            with self.assertRaisesRegex(namespace.NamespaceError, '^untrusted-system-path$'):
                namespace.trusted_path(binary)

    def test_read_rejects_swapped_open_handle_and_changed_file_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / 'policy'
            path.write_bytes(b'bounded')
            original = path.stat()
            changed = types.SimpleNamespace(st_dev=original.st_dev, st_ino=original.st_ino + 1,
                st_size=original.st_size, st_mtime_ns=original.st_mtime_ns)
            with patch.object(namespace, 'trusted_path', return_value=path):
                with patch.object(namespace.os, 'fstat', return_value=changed), self.assertRaisesRegex(namespace.NamespaceError, '^system-path-changed$'):
                    namespace.read_trusted(path)
                with patch.object(pathlib.Path, 'stat', side_effect=[original, changed]), self.assertRaisesRegex(namespace.NamespaceError, '^system-path-changed$'):
                    namespace.read_trusted(path)

    def test_ordinary_account_resolves_validated_identity_without_assuming_uid_or_home(self):
        account = types.SimpleNamespace(pw_uid=12345, pw_gid=54321, pw_dir='/srv/ordinary-home')
        fake_pwd = types.SimpleNamespace(getpwnam=lambda name: account)
        with patch.dict(sys.modules, {'pwd': fake_pwd}):
            self.assertIs(namespace.ordinary_account('existing.user'), account)
            for value in ('root\n', '--option', '../root', '', None):
                with self.subTest(value=value), self.assertRaisesRegex(namespace.NamespaceError, '^ordinary-user-required$'):
                    namespace.ordinary_account(value)
            for field, value in [('pw_uid', 0), ('pw_gid', -1), ('pw_dir', 'relative')]:
                original = getattr(account, field)
                setattr(account, field, value)
                with self.subTest(field=field), self.assertRaisesRegex(namespace.NamespaceError, '^ordinary-user-required$'):
                    namespace.ordinary_account('dant')
                setattr(account, field, original)

    def test_entrypoint_outputs_only_fixed_results_and_requires_explicit_install(self):
        for outcome, expected in [('installed', 0), (namespace.NamespaceError('existing-bwrap-policy'), 1),
                                  (OSError('private filesystem detail'), 1), (KeyError('private-account'), 1)]:
            stdout, stderr = io.StringIO(), io.StringIO()
            with self.subTest(outcome=type(outcome).__name__), patch.object(namespace.NamespaceSetup, 'install', side_effect=outcome if isinstance(outcome, Exception) else None, return_value=outcome), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(namespace.main(['--install', '--user', 'dant']), expected)
                self.assertNotIn('private', stdout.getvalue() + stderr.getvalue())
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            namespace.main([])
        with patch.object(sys, 'argv', [str(SCRIPT), '--install']), patch.object(os, 'geteuid', return_value=1000, create=True), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stopped:
            runpy.run_path(str(SCRIPT), run_name='__main__')
        self.assertEqual(stopped.exception.code, 1)


if __name__ == '__main__':
    unittest.main()
