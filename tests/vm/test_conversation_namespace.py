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
        self.root = pathlib.Path(temporary.name).resolve()
        # Drive-free Linux fixture paths resolve on the temporary drive even
        # when Windows TEMP and the checkout live on different drives.
        self.enterContext(contextlib.chdir(self.root))
        self.paths = {}
        for key, name in namespace.PATHS.items():
            path = self.root / name.lstrip('/')
            path.parent.mkdir(parents=True, exist_ok=True)
            if key in ('policies', 'kernel'):
                path.mkdir()
            else:
                path.write_bytes({'enabled': b'Y\n', 'restricted': b'1\n', 'loaded': b'other (enforce)\n',
                                  'revision': b'1\n', 'namespace_level': b'0\n',
                                  'context': b'unconfined\n'}.get(key, b'fixed binary'))
            self.paths[key] = str(path)
        profiles = pathlib.Path(self.paths['kernel']) / 'profiles/other.1'
        profiles.mkdir(parents=True)
        (profiles / 'attach').write_bytes(b'/usr/bin/other\n')
        (profiles / 'name').write_bytes(b'other\n')
        self.calls = []
        self.probes = [1, 0]
        self.parser_results = [0, 0]
        self.preprocessed = {}
        self.syntax_failure = False
        self.setup = namespace.NamespaceSetup(self.paths, self.run_fake)
        self.addCleanup(patch.stopall)
        patch.object(namespace.os, 'geteuid', return_value=0, create=True).start()
        patch.object(namespace, 'ordinary_account', return_value=types.SimpleNamespace(pw_uid=1000, pw_gid=1000)).start()
        # Windows fixture owners/modes are not Unix ownership proof. Exercise
        # that separate boundary below with explicit stat records, not a real
        # root policy directory. No production path can reach this fixture.
        patch.object(namespace, 'trusted_path', side_effect=self.fixture_path).start()
        patch.object(namespace, 'read_kernel_once', side_effect=lambda value, limit: namespace.read_trusted(value, limit)).start()
        patch.object(namespace, 'validate_info', side_effect=lambda info, directory=False: self.assertTrue(
            stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))).start()

    def fixture_path(self, value, directory=False):
        path = pathlib.Path(value).resolve()
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
        if '--names' in arguments or '--preprocess' in arguments:
            self.assertNotEqual(options['stdout'], subprocess.DEVNULL)
            self.assertIs(options['preexec_fn'], namespace.limit_parser_output)
            self.assertIn('--skip-kernel-load', arguments)
            self.assertIn('--base', arguments)
            self.assertNotIn('--add', arguments)
            item = pathlib.Path(arguments[-1])
            raw = self.preprocessed.get(item.name, item.read_bytes())
            if '--names' in arguments:
                options['stdout'].write(getattr(self, 'canonical_names', b'other\n'))
            else:
                options['stdout'].write(raw)
            return types.SimpleNamespace(returncode=1 if self.syntax_failure else 0)
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

    def test_existing_global_loaded_or_configured_attachment_is_preserved(self):
        policies = pathlib.Path(self.paths['policies'])
        attach = pathlib.Path(self.paths['kernel']) / 'profiles/other.1/attach'
        attach.write_bytes(b'/usr/bin/bwrap')
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.install()
        attach.write_bytes(b'/usr/bin/other')
        for location in ['bwrap', 'vendor-app', namespace.PROFILE_NAME]:
            with self.subTest(location=location):
                target = policies / location
                before = b'profile vendor /usr/bin/bwrap flags=(unconfined) { userns, }'
                target.write_bytes(before)
                self.probes = [1]
                with self.assert_rejected('existing-bwrap-policy'):
                    self.setup.install()
                self.assertEqual(target.read_bytes(), before)
                target.unlink()

    def test_only_loader_roots_are_interpreted_and_include_expansion_retains_parent_scope(self):
        policies = pathlib.Path(self.paths['policies'])
        local = policies / 'local'
        local.mkdir()
        fragment = local / 'vendor'
        fragment.write_bytes(b'/usr/bin/bwrap ix,\n')
        abstractions = policies / 'abstractions'
        abstractions.mkdir()
        (abstractions / 'vendor').write_bytes(b'if exists /etc/vendor { /usr/bin/bwrap ix, }')
        profile = policies / 'vendor'
        profile.write_bytes(b'profile other /usr/bin/other {\n#include <local>\n}\n')
        self.preprocessed['vendor'] = b'profile other /usr/bin/other { /usr/bin/bwrap ix, }'
        self.assertEqual(self.setup.check_conflicts(), policies)
        inspected = [call[0][-1] for call in self.calls]
        self.assertEqual(inspected, [str(profile), str(profile)])
        self.preprocessed['vendor'] = b'profile other /usr/bin/other { }\n/usr/bin/bwrap { }'
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.check_conflicts()
        self.assertEqual(fragment.read_bytes(), b'/usr/bin/bwrap ix,\n')

    def test_unsafe_include_or_link_is_rejected_before_running_the_parser(self):
        policies = pathlib.Path(self.paths['policies'])
        local = policies / 'local'
        local.mkdir()
        policy = local / 'vendor'
        (policies / 'vendor').write_bytes(b'profile other /usr/bin/other {\n#include <local/vendor>\n}')
        for raw in [b'#include "/outside/policy"', b'include </outside>',
                    b'include <../outside>', b'include <safe/../../outside>', b'include <@{outside}>']:
            policy.write_bytes(raw)
            with self.subTest(raw=raw), self.assert_rejected('policy-inspection-unavailable'):
                self.setup.check_conflicts()
        self.assertEqual(self.calls, [])
        policy.write_bytes(b'unrelated policy')
        fake_link = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        original = pathlib.Path.lstat
        with patch.object(pathlib.Path, 'lstat', lambda path: fake_link if path == policy else original(path)), self.assert_rejected('untrusted-system-path'):
            self.setup.check_conflicts()

    def external_include(self, path):
        value = path.as_posix()
        # Linux-only literal path grammar is exercised through a temporary
        # filesystem on Windows too; no real system include is read by a test.
        return value[2:] if path.drive else value

    def external_profile(self, target, optional=False):
        policies = pathlib.Path(self.paths['policies'])
        profile = policies / 'vendor'
        source = 'profile other /usr/bin/other { include ' + ('if exists ' if optional else '')
        profile.write_text(source + '"' + self.external_include(target) + '"\n}\n', encoding='utf-8')
        self.preprocessed['vendor'] = b'profile other /usr/bin/other { /usr/bin/bwrap ix, }'
        return profile

    def test_trusted_external_directory_and_recursive_inline_include_keep_parent_scope(self):
        external = self.root / 'var/lib/vendor/policy'
        external.mkdir(parents=True)
        included = external / 'fragment'
        shared = self.root / 'var/lib/vendor/shared'
        shared.write_bytes(b'/usr/bin/bwrap ix,')
        included.write_text('include "' + self.external_include(shared) + '"\n', encoding='utf-8')
        (external / 'ignored-child-directory').mkdir()
        (external / 'ignored.dpkg-old').write_bytes(b'include "/must-not-be-read"')
        profile = self.external_profile(external)
        policies = pathlib.Path(self.paths['policies'])
        before = self.setup.policy_inputs(policies)
        self.assertIn(pathlib.Path(self.external_include(shared)), before[0])
        self.assertIn(pathlib.Path(self.external_include(external)), before[1])
        self.assertEqual(self.setup.check_conflicts(), policies)
        self.assertEqual([call[0][-1] for call in self.calls], [str(profile), str(profile)])
        self.assertEqual(shared.read_bytes(), b'/usr/bin/bwrap ix,')
        self.preprocessed['vendor'] = b'profile other /usr/bin/other { }\n/usr/bin/bwrap { }'
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.check_conflicts()

    def test_external_untrusted_boundary_and_changed_source_stop_before_publication(self):
        external = self.root / 'var/lib/vendor/fragment'
        external.parent.mkdir(parents=True)
        external.write_bytes(b'/usr/bin/bwrap ix,')
        self.external_profile(external)
        trusted = self.fixture_path

        def untrusted(value, directory=False):
            if pathlib.Path(value).resolve() == external:
                namespace.reject('untrusted-system-path')
            return trusted(value, directory)

        with patch.object(namespace, 'trusted_path', side_effect=untrusted), self.assert_rejected('untrusted-system-path'):
            self.setup.check_conflicts()
        self.assertEqual(self.calls, [])
        run = self.run_fake

        def changed(arguments, **options):
            result = run(arguments, **options)
            if '--preprocess' in arguments:
                external.write_bytes(b'administrator changed the source')
            return result

        self.setup.runner = changed
        with self.assert_rejected('system-path-changed'):
            self.setup.check_conflicts()
        self.assertFalse(any('--add' in call[0] for call in self.calls))

    def test_optional_absence_is_owned_and_required_missing_or_late_creation_is_rejected(self):
        external = self.root / 'var/lib/vendor/optional/fragment'
        external.parent.parent.mkdir(parents=True)
        profile = self.external_profile(external, optional=True)
        policies = pathlib.Path(self.paths['policies'])
        before = self.setup.policy_inputs(policies)
        self.assertIn(pathlib.Path(self.external_include(external)), before[2])
        self.assertEqual(self.setup.check_conflicts(), policies)
        self.external_profile(external, optional=False)
        self.calls.clear()
        with self.assert_rejected('policy-inspection-unavailable'):
            self.setup.check_conflicts()
        self.assertEqual(self.calls, [])
        self.external_profile(external, optional=True)
        run = self.run_fake

        def created(arguments, **options):
            result = run(arguments, **options)
            if '--preprocess' in arguments:
                external.parent.mkdir()
                external.write_bytes(b'/usr/bin/bwrap ix,')
            return result

        self.setup.runner = created
        with self.assert_rejected('system-path-changed'):
            self.setup.check_conflicts()
        self.assertTrue(profile.is_file())
        self.assertEqual(external.read_bytes(), b'/usr/bin/bwrap ix,')

    def test_external_graph_cycles_are_bounded_and_broken_optional_links_are_not_absence(self):
        external = self.root / 'var/lib/vendor/fragment'
        external.parent.mkdir(parents=True)
        external.write_text('include "' + self.external_include(external) + '"\n', encoding='utf-8')
        self.external_profile(external)
        self.assertEqual(self.setup.check_conflicts(), pathlib.Path(self.paths['policies']))
        external.unlink()
        self.external_profile(external, optional=True)
        lstat = pathlib.Path.lstat
        logical = pathlib.Path(self.external_include(external))

        def broken(path):
            if path == logical:
                return types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
            return lstat(path)

        with patch.object(pathlib.Path, 'lstat', side_effect=broken, autospec=True), self.assert_rejected('untrusted-system-path'):
            self.setup.check_conflicts()

    def test_exact_loaded_profile_identity_collision_is_preserved_even_with_another_attachment(self):
        profile = pathlib.Path(self.paths['kernel']) / 'profiles/other.1'
        (profile / 'name').write_bytes(namespace.PROFILE_IDENTITY)
        (profile / 'attach').write_bytes(b'/usr/bin/other')
        pathlib.Path(self.paths['loaded']).write_bytes(namespace.PROFILE_IDENTITY + b' (enforce)\n')
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.check_conflicts()
        self.assertEqual(self.calls, [])
        self.assertEqual((profile / 'name').read_bytes(), namespace.PROFILE_IDENTITY)

    def test_canonical_global_name_collision_and_missing_header_cannot_be_hidden(self):
        policies = pathlib.Path(self.paths['policies'])
        source = policies / 'vendor'
        source.write_bytes(b'profile /usr/bin/bwrap /usr/bin/other { }')
        self.canonical_names = namespace.PROFILE_IDENTITY + b'\n'
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.check_conflicts()
        self.assertEqual(source.read_bytes(), b'profile /usr/bin/bwrap /usr/bin/other { }')
        self.canonical_names = b'other\nmissing-global\n'
        source.write_bytes(b'profile other /usr/bin/other { }')
        with self.assert_rejected('policy-inspection-unavailable'):
            self.setup.check_conflicts()
        self.assertFalse(any('--add' in call[0] for call in self.calls))

    def test_external_graph_depth_missing_and_entry_limits_precede_parser_or_policy_writes(self):
        external = self.root / 'var/lib/vendor/fragment'
        external.parent.mkdir(parents=True)
        next_file = external.with_name('next')
        next_file.write_bytes(b'/usr/bin/bwrap ix,')
        external.write_text('include "' + self.external_include(next_file) + '"\n', encoding='utf-8')
        self.external_profile(external)
        with patch.object(namespace, 'DEPTH_LIMIT', 1), self.assert_rejected('policy-limit'):
            self.setup.check_conflicts()
        with patch.object(namespace, 'ENTRY_LIMIT', 1), self.assert_rejected('policy-limit'):
            self.setup.check_conflicts()
        absent = external.with_name('missing')
        self.external_profile(absent, optional=True)
        with patch.object(namespace, 'ENTRY_LIMIT', 2), self.assert_rejected('policy-limit'):
            self.setup.check_conflicts()
        self.assertEqual(self.calls, [])

    def test_scan_is_bounded_and_skips_disabled_profile_link_directories(self):
        policies = pathlib.Path(self.paths['policies'])
        disabled = policies / 'disable'
        disabled.mkdir()
        (disabled / 'vendor').write_bytes(b'/usr/bin/bwrap')
        unrelated = policies / 'vendor'
        unrelated.write_bytes(b'profile other /usr/bin/other { }')
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

    def test_opaque_kernel_attachment_needs_positive_ordinary_exec_before_installation(self):
        attachment = pathlib.Path(self.paths['kernel']) / 'profiles/other.1/attach'
        attachment.write_bytes(b'<unknown>\n')
        observer = patch.object(namespace.AttachmentObserver, 'observe', return_value=b'1\n')
        with observer as observed:
            self.assertEqual(self.setup.install('ordinary.test'), 'installed')
        observed.assert_called_once_with()
        self.assertEqual(attachment.read_bytes(), b'<unknown>\n')
        target = pathlib.Path(self.paths['policies']) / namespace.PROFILE_NAME
        self.assertEqual(target.read_bytes(), namespace.PROFILE)
        self.assertEqual(sum('--add' in call[0] for call in self.calls), 1)

    def test_unconfirmed_opaque_observation_never_publishes_or_loads(self):
        attachment = pathlib.Path(self.paths['kernel']) / 'profiles/other.1/attach'
        attachment.write_bytes(b'<unknown>\n')
        for outcome in (b'2\n', namespace.NamespaceError('existing-bwrap-policy')):
            self.probes = [1]
            with self.subTest(outcome=type(outcome).__name__), patch.object(namespace.AttachmentObserver, 'observe') as observed:
                if isinstance(outcome, Exception):
                    observed.side_effect = outcome
                else:
                    observed.return_value = outcome
                with self.assertRaises(namespace.NamespaceError):
                    self.setup.install()
                self.assertEqual(list(pathlib.Path(self.paths['policies']).iterdir()), [])
        self.assertFalse(any('--add' in call[0] for call in self.calls))

    def test_opaque_profile_cannot_bypass_explicit_global_identity_or_configured_conflicts(self):
        attachment = pathlib.Path(self.paths['kernel']) / 'profiles/other.1/attach'
        attachment.write_bytes(b'<unknown>\n')
        policy = pathlib.Path(self.paths['policies']) / 'administrator'
        for raw in (b'profile other /usr/bin/bwrap { }', b'profile other /usr/bin/b* { }',
                    b'profile /usr/bin/bwrap /usr/bin/other { }'):
            policy.write_bytes(raw)
            with self.subTest(raw=raw), patch.object(namespace.AttachmentObserver, 'observe') as observed:
                with self.assert_rejected('existing-bwrap-policy'):
                    self.setup.check_conflicts()
                observed.assert_not_called()
                self.assertEqual(policy.read_bytes(), raw)

    def test_policy_context_and_revision_are_validated_without_policy_writes(self):
        for key, raw in [('revision', b'unknown'), ('namespace_level', b'1\n'),
                         ('context', b'named (unconfined)\n')]:
            path = pathlib.Path(self.paths[key])
            original = path.read_bytes()
            path.write_bytes(raw)
            with self.subTest(key=key), self.assert_rejected('policy-inspection-unavailable'):
                self.setup.check_conflicts()
            path.write_bytes(original)
        self.assertEqual(self.calls, [])

    def test_changed_inputs_during_positive_observation_are_not_adopted(self):
        attachment = pathlib.Path(self.paths['kernel']) / 'profiles/other.1/attach'
        attachment.write_bytes(b'<unknown>\n')
        policies = pathlib.Path(self.paths['policies'])

        def changed():
            (policies / 'new-administrator-policy').write_bytes(b'profile other /** { }')
            return b'1\n'

        with (
            patch.object(namespace.time, 'sleep') as sleep,
            patch.object(namespace.AttachmentObserver, 'observe', side_effect=changed) as observed,
            self.assert_rejected('existing-bwrap-policy'),
        ):
            self.setup.install()
        sleep.assert_called_once_with(namespace.INSPECTION_RETRY_SECONDS)
        observed.assert_called_once_with()
        self.assertFalse((policies / namespace.PROFILE_NAME).exists())
        self.assertFalse(any('--add' in call[0] for call in self.calls))

    def test_policy_epoch_change_before_publication_gets_a_fresh_read_only_inspection(self):
        original = self.setup.runner
        compilations = 0

        def changed(arguments, **options):
            nonlocal compilations
            result = original(arguments, **options)
            if options.get('input') == namespace.PROFILE:
                compilations += 1
                if compilations == 1:
                    pathlib.Path(self.paths['revision']).write_bytes(b'2\n')
            return result

        self.setup.runner = changed
        self.parser_results = [0, 0, 0]
        with (
            patch.object(namespace.time, 'sleep') as sleep,
            patch.object(self.setup, 'publish', wraps=self.setup.publish) as published,
        ):
            self.assertEqual(self.setup.install(), 'installed')
        self.assertEqual(compilations, 2)
        sleep.assert_called_once_with(0.25)
        published.assert_called_once_with(pathlib.Path(self.paths['policies']))
        self.assertEqual(self.setup.conflict_snapshot[3], b'2\n')
        target = pathlib.Path(self.paths['policies']) / namespace.PROFILE_NAME
        self.assertEqual(target.read_bytes(), namespace.PROFILE)
        self.assertEqual(sum('--add' in call[0] for call in self.calls), 1)

    def test_read_only_inspection_exhausts_three_attempts_without_publication(self):
        original = self.setup.runner
        compilations = 0

        def changed(arguments, **options):
            nonlocal compilations
            result = original(arguments, **options)
            if options.get('input') == namespace.PROFILE:
                compilations += 1
                pathlib.Path(self.paths['revision']).write_bytes((str(compilations + 1) + '\n').encode())
            return result

        self.setup.runner = changed
        self.parser_results = [0, 0, 0]
        with (
            patch.object(namespace.time, 'sleep') as sleep,
            patch.object(self.setup, 'publish') as published,
            self.assert_rejected('system-path-changed'),
        ):
            self.setup.install()
        self.assertEqual(namespace.INSPECTION_ATTEMPTS, 3)
        self.assertEqual(namespace.INSPECTION_RETRY_SECONDS, 0.25)
        self.assertEqual(compilations, 3)
        self.assertEqual(sleep.call_args_list, [unittest.mock.call(0.25), unittest.mock.call(0.25)])
        published.assert_not_called()
        self.assertEqual(list(pathlib.Path(self.paths['policies']).iterdir()), [])
        self.assertFalse(any('--add' in call[0] for call in self.calls))

    def test_retry_repeats_the_opaque_attachment_observation_for_its_new_epoch(self):
        attachment = pathlib.Path(self.paths['kernel']) / 'profiles/other.1/attach'
        attachment.write_bytes(b'<unknown>\n')
        original = self.setup.runner
        compilations = 0

        def changed(arguments, **options):
            nonlocal compilations
            result = original(arguments, **options)
            if options.get('input') == namespace.PROFILE:
                compilations += 1
                if compilations == 1:
                    pathlib.Path(self.paths['revision']).write_bytes(b'2\n')
            return result

        self.setup.runner = changed
        self.parser_results = [0, 0, 0]
        with (
            patch.object(namespace.time, 'sleep'),
            patch.object(namespace.AttachmentObserver, 'observe', side_effect=[b'1\n', b'2\n']) as observed,
        ):
            self.assertEqual(self.setup.install('ordinary.test'), 'installed')
        self.assertEqual(observed.call_count, 2)
        self.assertEqual(self.setup.conflict_snapshot[3], b'2\n')
        self.assertEqual(sum('--add' in call[0] for call in self.calls), 1)

    def test_a_new_regular_or_dangling_target_prevents_read_only_retry(self):
        target = pathlib.Path(self.paths['policies']) / namespace.PROFILE_NAME
        original_lstat = pathlib.Path.lstat
        original_run = self.run_fake
        for kind in ('regular', 'dangling-link'):
            with self.subTest(kind=kind):
                self.calls.clear()
                self.probes, self.parser_results = [1], [0]
                pathlib.Path(self.paths['revision']).write_bytes(b'1\n')
                appeared = False

                def lstat(path):
                    if path == target and appeared and kind == 'dangling-link':
                        return types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
                    return original_lstat(path)

                def changed(arguments, **options):
                    nonlocal appeared
                    result = original_run(arguments, **options)
                    if options.get('input') == namespace.PROFILE:
                        pathlib.Path(self.paths['revision']).write_bytes(b'2\n')
                        if kind == 'regular':
                            target.write_bytes(b'administrator-owned-fixture')
                        appeared = True
                    return result

                self.setup.runner = changed
                with (
                    patch.object(namespace.time, 'sleep') as sleep,
                    patch.object(pathlib.Path, 'lstat', lstat),
                    patch.object(self.setup, 'publish') as published,
                    self.assert_rejected('system-path-changed'),
                ):
                    self.setup.install()
                sleep.assert_not_called()
                published.assert_not_called()
                self.assertFalse(any('--add' in call[0] for call in self.calls))
                if target.exists():
                    self.assertEqual(target.read_bytes(), b'administrator-owned-fixture')
                    target.unlink()

    def test_unreadable_destination_is_not_a_positive_absence_for_retry(self):
        target = pathlib.Path(self.paths['policies']) / namespace.PROFILE_NAME
        original_lstat, original_run = pathlib.Path.lstat, self.run_fake
        unreadable = False

        def lstat(path):
            if path == target and unreadable:
                raise PermissionError('synthetic-only')
            return original_lstat(path)

        def changed(arguments, **options):
            nonlocal unreadable
            result = original_run(arguments, **options)
            if options.get('input') == namespace.PROFILE:
                pathlib.Path(self.paths['revision']).write_bytes(b'2\n')
                unreadable = True
            return result

        self.setup.runner = changed
        with (
            patch.object(namespace.time, 'sleep') as sleep,
            patch.object(pathlib.Path, 'lstat', lstat),
            patch.object(self.setup, 'publish') as published,
            self.assert_rejected('policy-inspection-unavailable'),
        ):
            self.setup.install()
        sleep.assert_not_called()
        published.assert_not_called()

    def test_destination_created_after_final_inspection_is_preserved_without_publication(self):
        target = pathlib.Path(self.paths['policies']) / namespace.PROFILE_NAME
        validate = self.setup.validate_conflicts
        validations = 0

        def created(root, published=None):
            nonlocal validations
            validate(root, published)
            validations += 1
            if validations == 2:
                target.write_bytes(b'administrator-late-profile')

        with (
            patch.object(self.setup, 'validate_conflicts', side_effect=created),
            patch.object(self.setup, 'publish') as published,
            patch.object(namespace.time, 'sleep') as sleep,
            self.assert_rejected('existing-bwrap-policy'),
        ):
            self.setup.install()
        self.assertEqual(target.read_bytes(), b'administrator-late-profile')
        published.assert_not_called()
        sleep.assert_not_called()

    def test_unknown_or_other_inspection_failures_never_retry(self):
        for error in (
            namespace.NamespaceError('existing-bwrap-policy'),
            namespace.NamespaceError('policy-inspection-unavailable'),
            OSError('synthetic-private-output'),
            RuntimeError('synthetic-private-output'),
        ):
            self.probes = [1]
            with (
                self.subTest(error=type(error).__name__),
                patch.object(self.setup, 'check_conflicts', side_effect=error) as inspected,
                patch.object(namespace.time, 'sleep') as sleep,
                patch.object(self.setup, 'publish') as published,
                self.assertRaises(type(error)),
            ):
                self.setup.install()
            inspected.assert_called_once_with('dant')
            sleep.assert_not_called()
            published.assert_not_called()

    def test_publication_entry_or_activation_failure_never_reenters_inspection(self):
        policies = pathlib.Path(self.paths['policies'])
        original_publish, original_validate = self.setup.publish, self.setup.validate_conflicts
        original_runner = self.run_fake
        for phase in ('publish', 'postpublication', 'activation', 'final-probe'):
            with self.subTest(phase=phase):
                self.calls.clear()
                self.probes, self.parser_results = [1, 0], [0, 0]

                def published(root):
                    if phase == 'publish':
                        namespace.reject('system-path-changed')
                    return original_publish(root)

                def validate(root, published=None):
                    if published is not None and phase == 'postpublication':
                        namespace.reject('system-path-changed')
                    return original_validate(root, published)

                def run(arguments, **options):
                    if '--add' in arguments and phase == 'activation':
                        namespace.reject('system-path-changed')
                    if arguments[0] == self.paths['runuser'] and phase == 'final-probe' and not self.probes:
                        namespace.reject('system-path-changed')
                    return original_runner(arguments, **options)

                if phase == 'final-probe':
                    self.probes = [1]
                self.setup.runner = run
                with (
                    patch.object(self.setup, 'check_conflicts', wraps=self.setup.check_conflicts) as inspected,
                    patch.object(self.setup, 'publish', side_effect=published) as publish,
                    patch.object(self.setup, 'validate_conflicts', side_effect=validate),
                    patch.object(namespace.time, 'sleep') as sleep,
                    self.assert_rejected('system-path-changed'),
                ):
                    self.setup.install()
                inspected.assert_called_once_with('dant')
                publish.assert_called_once_with(policies)
                sleep.assert_not_called()
                target = policies / namespace.PROFILE_NAME
                if target.exists():
                    self.assertEqual(target.read_bytes(), namespace.PROFILE)
                    target.unlink()

    def test_postpublication_fences_allow_only_the_exact_owned_file(self):
        original = self.setup.publish
        policies = pathlib.Path(self.paths['policies'])
        for kind in ('revision', 'new-file', 'replacement'):
            with self.subTest(kind=kind):
                self.probes = [1]
                self.parser_results = [0]
                pathlib.Path(self.paths['revision']).write_bytes(b'1\n')
                def changed(root):
                    target = original(root)
                    if kind == 'revision':
                        pathlib.Path(self.paths['revision']).write_bytes(b'2\n')
                    elif kind == 'new-file':
                        (policies / 'independent-change').write_bytes(b'other')
                    else:
                        replacement = policies / '.replacement'
                        replacement.write_bytes(namespace.PROFILE)
                        os.replace(replacement, target)
                    return target
                with patch.object(self.setup, 'publish', side_effect=changed), self.assert_rejected('system-path-changed'):
                    self.setup.install()
                self.assertFalse(any('--add' in call[0] for call in self.calls))
                self.assertEqual((policies / namespace.PROFILE_NAME).read_bytes(), namespace.PROFILE)
                for path in policies.iterdir():
                    path.unlink()

    def test_owned_publication_preserves_optional_missing_input_fences(self):
        policies = pathlib.Path(self.paths['policies'])
        (policies / 'local').mkdir()
        policy = policies / 'administrator'
        policy.write_bytes(b'profile other /usr/bin/other { include if exists <optional>\ninclude if exists <local/optional> }')
        self.preprocessed['administrator'] = b'profile other /usr/bin/other { }'
        self.assertEqual(self.setup.install(), 'installed')
        self.assertFalse((policies / 'optional').exists())
        self.assertFalse((policies / 'local/optional').exists())
        self.assertEqual(sum('--add' in call[0] for call in self.calls), 1)

    def test_conflict_validation_requires_its_matching_captured_root(self):
        policies = pathlib.Path(self.paths['policies'])
        with self.assert_rejected('policy-inspection-unavailable'):
            self.setup.validate_conflicts(policies)
        self.setup.check_conflicts()
        with self.assert_rejected('policy-inspection-unavailable'):
            self.setup.validate_conflicts(policies.parent)

    def test_publication_does_not_adopt_an_identical_replacement_after_its_content_check(self):
        policies = pathlib.Path(self.paths['policies'])
        original = namespace.read_trusted
        def replaced(value, limit=namespace.FILE_LIMIT):
            raw = original(value, limit)
            if pathlib.Path(value).name == namespace.PROFILE_NAME:
                other = policies / '.identical-replacement'
                other.write_bytes(namespace.PROFILE)
                os.replace(other, value)
            return raw
        with patch.object(namespace, 'read_trusted', side_effect=replaced), self.assert_rejected('system-path-changed'):
            self.setup.publish(policies)
        self.assertEqual((policies / namespace.PROFILE_NAME).read_bytes(), namespace.PROFILE)

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

    def test_loaded_local_bwrap_profile_and_body_reference_are_not_global_attachments(self):
        parent = pathlib.Path(self.paths['kernel']) / 'profiles/other.1'
        (parent / 'name').write_bytes(b'other_bwrap_tool')
        child = parent / 'profiles/bwrap.2'
        child.mkdir(parents=True)
        (child / 'name').write_bytes(b'bwrap')
        for raw in [b'/usr/bin/bwrap', b'<unknown>']:
            (child / 'attach').write_bytes(raw)
            pathlib.Path(self.paths['loaded']).write_bytes(b'other_bwrap_tool (enforce)\nother_bwrap_tool//bwrap (enforce)\n')
            with self.subTest(attachment=raw):
                self.assertEqual(self.setup.check_conflicts(), pathlib.Path(self.paths['policies']))
        (parent / 'attach').write_bytes(b'<unknown>')
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.check_conflicts()

    def test_loader_exclusions_do_not_hide_active_profile_files(self):
        policies = pathlib.Path(self.paths['policies'])
        for name in ['README', '.ignored', *['vendor' + suffix for suffix in namespace.SKIP_SUFFIXES]]:
            (policies / name).write_bytes(b'/usr/bin/bwrap { }')
        vendor = policies / 'bwrap-helper'
        vendor.write_bytes(b'profile other /usr/bin/other { /usr/bin/bwrap ix, }')
        self.assertEqual(self.setup.check_conflicts(), policies)
        self.assertEqual([call[0][-1] for call in self.calls], [str(vendor), str(vendor)])
        vendor.write_bytes(b'/usr/bin/bwrap { }')
        with self.assert_rejected('existing-bwrap-policy'):
            self.setup.check_conflicts()

    def test_parser_failure_incomplete_or_changed_inputs_never_publish(self):
        policies = pathlib.Path(self.paths['policies'])
        vendor = policies / 'vendor'
        vendor.write_bytes(b'profile other /usr/bin/other { }')
        self.syntax_failure = True
        with self.assert_rejected('policy-inspection-unavailable'):
            self.setup.check_conflicts()
        self.syntax_failure = False
        self.preprocessed['vendor'] = b'# no interpreted global profile'
        with self.assert_rejected('policy-inspection-unavailable'):
            self.setup.check_conflicts()
        self.preprocessed.clear()
        original = self.run_fake

        def changed(arguments, **options):
            result = original(arguments, **options)
            if '--preprocess' in arguments:
                vendor.write_bytes(b'profile replacement /usr/bin/other { }')
            return result

        self.setup.runner = changed
        with self.assert_rejected('system-path-changed'):
            self.setup.check_conflicts()
        self.assertNotIn(namespace.PROFILE_NAME, [path.name for path in policies.iterdir()])

    def test_policy_replacement_during_capture_preserves_both_files_and_never_parses(self):
        policies = pathlib.Path(self.paths['policies'])
        vendor = policies / 'vendor'
        displaced = policies / '.administrator-retained'
        vendor.write_bytes(b'profile other /usr/bin/other { }')
        read = namespace.read_trusted

        def replace(path, limit=namespace.FILE_LIMIT):
            raw = read(path, limit)
            if path == vendor:
                vendor.rename(displaced)
                vendor.write_bytes(raw)
            return raw

        with patch.object(namespace, 'read_trusted', side_effect=replace), self.assert_rejected('system-path-changed'):
            self.setup.check_conflicts()
        self.assertEqual(self.calls, [])
        self.assertEqual(vendor.read_bytes(), displaced.read_bytes())

    def test_inspection_output_overflow_is_fixed_without_echoing_output(self):
        def overflow(_arguments, **options):
            options['stdout'].write(b'private-output' * 10)
            return types.SimpleNamespace(returncode=0)

        self.setup.runner = overflow
        with patch.object(namespace, 'TREE_LIMIT', 8), self.assert_rejected('policy-limit'):
            self.setup.inspect_policy(['fixed-parser'])

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
    def test_noncanonical_temporary_roots_preserve_public_install_boundaries(self):
        with tempfile.TemporaryDirectory(prefix='dant namespace alias ') as temporary:
            parent = pathlib.Path(temporary).resolve()
            variants = ['dot-segment']
            if os.name == 'nt':
                import ctypes
                variants.append('short-path')
            for variant in variants:
                with self.subTest(variant=variant):
                    directory = parent / (variant + ' synthetic namespace')
                    directory.mkdir()
                    alias = directory / '..' / directory.name
                    if variant == 'short-path':
                        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                        kernel.GetShortPathNameW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
                        kernel.GetShortPathNameW.restype = ctypes.c_uint32
                        buffer = ctypes.create_unicode_buffer(32768)
                        length = kernel.GetShortPathNameW(str(directory), buffer, len(buffer))
                        if 0 < length < len(buffer):
                            short = pathlib.Path(buffer.value)
                            if short != directory:
                                alias = short
                    self.assertNotEqual(alias, directory)
                    self.assertEqual(alias.resolve(), directory)
                    fixture = NamespaceFixture()
                    redirected = types.SimpleNamespace(name=str(alias), cleanup=lambda: None)
                    try:
                        with patch.object(tempfile, 'TemporaryDirectory', return_value=redirected):
                            fixture.setUp()
                        self.assertEqual(fixture.setup.install('ordinary.test'), 'installed')
                        target = pathlib.Path(fixture.paths['policies']) / namespace.PROFILE_NAME
                        self.assertEqual(target.read_bytes(), namespace.PROFILE)
                        self.assertTrue(target.is_relative_to(directory))
                        self.assertEqual(sum('--add' in arguments for arguments, _ in fixture.calls), 1)
                    finally:
                        fixture.doCleanups()

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

    def test_literal_nested_attachment_alternatives_preserve_vendor_scope_and_real_conflicts(self):
        safe = [b'/{{usr/bin,etc/alternatives}/notepadqq,usr/lib/notepadqq/notepadqq.sh}',
                b'/usr/{lib/steam/bin_steam.sh,games/steam}', b'/{,usr/}bin/other',
                b'/usr/{bin,sbin}/other', b'/usr/{lib/{one,two},share}/other']
        for raw in safe:
            with self.subTest(raw=raw):
                self.assertFalse(namespace.may_attach_bwrap(raw))
        conflicts = [b'/{{usr/bin,etc/alternatives}/bwrap,usr/lib/other}',
                     b'/usr/{lib/other,bin/bwrap}', b'/{,usr/}bin/bwrap',
                     b'/usr/{lib/*,bin/b*}', b'@bin/bwrap']
        for raw in conflicts:
            with self.subTest(raw=raw):
                self.assertTrue(namespace.may_attach_bwrap(raw))
        self.assertEqual(namespace.attachment_patterns('/{a,b}{c,d}'), ['/ac', '/ad', '/bc', '/bd'])
        for raw in [b'/usr/{bin', b'/usr/{bin}', b'/usr/[bin', b'/usr/@{invalid-name}/other',
                    b'/usr/@{unterminated', b'/usr/@{anything}/bwrap', b'/usr/}bwrap',
                    b'/usr/bin/bwrap' + b'x' * namespace.ATTACHMENT_LIMIT]:
            with self.subTest(raw=raw):
                self.assertTrue(namespace.may_attach_bwrap(raw))
        with patch.object(namespace, 'PATTERN_LIMIT', 2):
            self.assertTrue(namespace.may_attach_bwrap(b'/{a,b,c}/other'))
            self.assertTrue(namespace.may_attach_bwrap(b'/{a,b}{c,d}/other'))
        with patch.object(namespace, 'DEPTH_LIMIT', 1):
            self.assertTrue(namespace.may_attach_bwrap(b'/{{a,b},c}/other'))

    def test_configured_global_headers_distinguish_nested_profiles_rules_and_brace_aare(self):
        self.assertEqual(namespace.check_configured_attachments(b'''# harmless bwrap comment
@{HOME}=/home/*
abi <abi/4.0>,
profile other
  /usr/{bin,sbin}/other
  flags=(enforce) {
  /usr/bin/bwrap ix,
  @{HOME}/** rw,
  profile child /usr/bin/bwrap { /usr/bin/bwrap ix, }
  if exists /etc/other { /usr/bin/bwrap r, }
}
profile named_bwrap_only { }
"/usr/bin/other" { }
'''), 3)
        self.assertEqual(namespace.check_configured_attachments(b'profile other { userns,}'), 1)
        with patch.object(namespace, 'DEPTH_LIMIT', 1), self.assertRaisesRegex(namespace.NamespaceError, '^policy-limit$'):
            namespace.check_configured_attachments(b'profile other { profile child { } }')
        invalid = [b'profile { }', b'profile escape /usr/bin/oth\\er { }',
            b'profile "unclosed { }', b'} /** { }', b'namespace hidden { }',
            b'\xff', b'profile ' + b'x' * 4097 + b' { }', b'profile unfinished',
            b'profile other /usr/{bin { }', b'profile other { ',
            b'profile "multi\nline" { }', b'profile other /usr/bin/other { \\',
            b'profile other /usr/bin/other { \x00 }',
            b'/usr/bin/unrelated profile hidden /usr/bin/bwrap { }',
            b'profile other /usr/bin/other extra { }',
            b'alias /usr/bin/other -> /usr/bin/bwrap,\n/usr/bin/other { }']
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
                namespace.check_configured_attachments(raw)
        for raw in [b'profile box /usr/bin/b* { }', b'profile box @{location}/b* { }',
                    b'/** { }', b'profile a /usr/bin/a { } profile b /** { }',
                    b'profile other { }\n"/usr/bin/bwrap" { }']:
            with self.subTest(raw=raw), self.assertRaisesRegex(namespace.NamespaceError, '^existing-bwrap-policy$'):
                namespace.check_configured_attachments(raw)

    def test_leading_brace_variable_rhs_and_multiline_flags_keep_profile_scope(self):
        raw = b'''@{locations} = {alpha,beta/{gamma,delta}}
@{prefix} = {,usr/}bin/
abi <abi/4.0>,
profile other /usr/bin/other flags=(
 attach_disconnected,
 mediate_deleted
) {
 profile child /usr/bin/bwrap { }
}
'''
        self.assertEqual(namespace.check_configured_attachments(raw, b'other\nother//child\n'), 1)
        with self.assertRaisesRegex(namespace.NamespaceError, '^existing-bwrap-policy$'):
            namespace.check_configured_attachments(raw + b'/usr/bin/bwrap { }')
        for names in [b'', b'other\nmissing-global\n', b'unrelated\n']:
            with self.subTest(names=names), self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
                namespace.check_configured_attachments(raw, names)
        with self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
            namespace.check_configured_attachments(b'@{values} = {alpha,beta')
        with self.assertRaisesRegex(namespace.NamespaceError, '^existing-bwrap-policy$'):
            namespace.check_configured_attachments(b'profile /usr/bin/bwrap /usr/bin/other { }')

    def test_legacy_bare_flags_preserve_named_implicit_and_conflicting_attachments(self):
        cases = [(b'/usr/bin/other (attach_disconnected,mediate_deleted) { }', b'/usr/bin/other\n'),
                 (b'profile other /usr/bin/other (attach_disconnected) { }', b'other\n'),
                 (b'profile other (attach_disconnected) { }', b'other\n'),
                 (b'/usr/bin/other (\n attach_disconnected,\n mediate_deleted\n) { }', b'/usr/bin/other\n')]
        for raw, names in cases:
            with self.subTest(raw=raw):
                self.assertEqual(namespace.check_configured_attachments(raw, names), 1)
        for raw in [b'/usr/bin/bwrap (attach_disconnected) { }',
                    b'profile other /usr/bin/bwrap (attach_disconnected) { }']:
            with self.subTest(raw=raw), self.assertRaisesRegex(namespace.NamespaceError, '^existing-bwrap-policy$'):
                namespace.check_configured_attachments(raw)
        with self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
            namespace.check_configured_attachments(b'/usr/bin/other (attach_disconnected) extra { }')

    def test_include_lexer_preserves_quoted_absolute_and_inline_inputs_but_rejects_unresolved_paths(self):
        self.assertEqual(namespace.check_includes(b'profile other { include if exists "/var/lib/vendor/policy" }'), [('/var/lib/vendor/policy', True, True)])
        self.assertEqual(namespace.check_includes(b'# comment include "/not-an-input"\n"/usr/bin/include" r,'), [])
        namespace.check_includes(b'''# ordinary comment
#include <tunables/global>
include if exists <local/vendor>
include <abstractions/vendor.d/> # bounded directory input
abi <abi/4.0>,
''')
        for raw in [b'include "relative"', b'include </etc/other>',
                    b'include <../other>', b'include <a/../b>', b'include <@{var}>', b'\xff', b'include', b'include <cache/foreign>',
                    b'include <disable/foreign>', b'include <a//b>', b'include <a/[.][.]>',
                    b'include <a/{b,c}>', b'include <a/*>', b'abi </outside>,',
                    b'abi "outside",', b'abi <abi/4.0>']:
            with self.subTest(raw=raw), self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
                namespace.check_includes(raw)

    def test_parser_output_is_capped_in_the_linux_child_before_host_read(self):
        limits = []
        fake_resource = types.SimpleNamespace(RLIMIT_FSIZE=42, setrlimit=lambda key, value: limits.append((key, value)))
        with patch.dict(sys.modules, {'resource': fake_resource}):
            namespace.limit_parser_output()
        self.assertEqual(limits, [(42, (namespace.TREE_LIMIT, namespace.TREE_LIMIT))])

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


class AttachmentObserverTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name).resolve()
        self.image = self.root / 'bwrap'
        self.image.write_bytes(b'synthetic executable, never executed')
        self.account = types.SimpleNamespace(pw_uid=12345, pw_gid=54321)
        self.events = []
        self.child = types.SimpleNamespace(pid=98765, poll=lambda: None,
            kill=lambda: self.events.append('kill-owned'),
            wait=lambda **options: self.events.append(('join-owned', options)))
        def spawn(arguments, **options):
            self.events.append(('spawn', arguments, options))
            return self.child
        self.observer = namespace.AttachmentObserver({'bwrap': str(self.image)}, self.account,
            spawner=spawn, sleeper=lambda seconds: self.events.append(('sleep', seconds)))
        self.enterContext(patch.object(namespace, 'trusted_path', return_value=self.image))
        self.enterContext(patch.object(namespace.os, 'getxattr',
            side_effect=OSError(__import__('errno').ENODATA, 'synthetic absent'), create=True))
        self.namespaces = tuple((name, (1, number)) for number, name in enumerate(namespace.NAMESPACES))

    def observe_fixture(self, identities=None, boundaries=None):
        expected = (b'12\n', self.namespaces)
        self.enterContext(patch.object(self.observer, 'boundary', side_effect=boundaries or [expected, expected]))
        identity = (os.getpid(), 1234, b'bare-unconfined')
        self.enterContext(patch.object(self.observer, 'child_identity', side_effect=identities or [None, identity, identity]))
        original_close = namespace.os.close
        def close(descriptor):
            self.events.append(('close-owned', descriptor))
            original_close(descriptor)
        self.enterContext(patch.object(namespace.os, 'close', side_effect=close))

    def test_observation_owns_only_one_ordinary_child_and_joins_before_pipe_close(self):
        self.observe_fixture()
        self.assertEqual(self.observer.observe(), b'12\n')
        spawned = next(event for event in self.events if isinstance(event, tuple) and event[0] == 'spawn')
        arguments, options = spawned[1:]
        self.assertEqual(arguments[:2], [str(self.image), '--args'])
        self.assertEqual(options['pass_fds'], (int(arguments[-1]),))
        self.assertEqual((options['user'], options['group'], options['extra_groups']), (12345, 54321, []))
        self.assertEqual(options['env'], {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        self.assertEqual((options['cwd'], options['shell'], options['close_fds']), ('/', False, True))
        self.assertTrue(all(options[key] == subprocess.DEVNULL for key in ('stdin', 'stdout', 'stderr')))
        self.assertNotIn('preexec_fn', options)
        self.assertEqual(self.events[-4:-2], ['kill-owned', ('join-owned', {'timeout': 10})])
        self.assertTrue(all(event[0] == 'close-owned' for event in self.events[-2:]))

    def test_changed_epoch_or_namespace_never_produces_positive_observation(self):
        first = (b'12\n', self.namespaces)
        for after in ((b'13\n', self.namespaces), (b'12\n', (('user', (4, 5)),))):
            with self.subTest(after=after), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(self.observer, 'boundary', side_effect=[first, after]))
                stack.enter_context(patch.object(self.observer, 'child_identity', return_value=('stable',)))
                with self.assertRaisesRegex(namespace.NamespaceError, '^system-path-changed$'):
                    self.observer.observe()
                self.assertEqual(self.events[-2:], ['kill-owned', ('join-owned', {'timeout': 10})])

    def test_no_pipe_wait_times_out_and_still_joins_the_owned_child(self):
        self.observe_fixture(identities=[None, None])
        with patch.object(namespace, 'ATTACHMENT_POLL_LIMIT', 2), self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
            self.observer.observe()
        self.assertEqual(sum(event[0] == 'sleep' for event in self.events if isinstance(event, tuple)), 2)
        self.assertEqual(self.events[-4:-2], ['kill-owned', ('join-owned', {'timeout': 10})])

    def test_process_or_physical_stop_failure_releases_pipe_only_after_owned_join(self):
        for error in (OSError('private path'), KeyboardInterrupt(), SystemExit()):
            with self.subTest(error=type(error).__name__), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(self.observer, 'boundary', return_value=(b'1\n', self.namespaces)))
                stack.enter_context(patch.object(self.observer, 'child_identity', side_effect=error))
                with self.assertRaises(type(error)):
                    self.observer.observe()
                self.assertEqual(self.events[-2:], ['kill-owned', ('join-owned', {'timeout': 10})])

    def test_setuid_and_file_capability_executables_are_not_launched(self):
        value = self.image.stat()
        changed = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o4755)
        with patch.object(self.observer, 'boundary', return_value=(b'1\n', self.namespaces)):
            with patch.object(pathlib.Path, 'stat', return_value=changed), self.assertRaisesRegex(namespace.NamespaceError, '^untrusted-system-path$'):
                self.observer.observe()
            with patch.object(namespace.os, 'getxattr', return_value=b'capability'), self.assertRaisesRegex(namespace.NamespaceError, '^untrusted-system-path$'):
                self.observer.observe()
        self.assertEqual(self.image.stat(), value)
        self.assertEqual(self.events, [])

    def test_unknown_capability_inspection_failure_never_launches_a_child(self):
        with patch.object(self.observer, 'boundary', return_value=(b'1\n', self.namespaces)), patch.object(namespace.os, 'getxattr', side_effect=PermissionError('private')):
            with self.assertRaises(PermissionError):
                self.observer.observe()
        self.assertEqual(self.events, [])

    def test_changed_opened_image_or_nonpipe_descriptor_is_rejected_before_spawn(self):
        self.observe_fixture()
        original = namespace.os.fstat
        image = self.image.stat()
        replacement = types.SimpleNamespace(st_dev=image.st_dev, st_ino=image.st_ino + 1,
            st_size=image.st_size, st_mtime_ns=image.st_mtime_ns)
        with patch.object(namespace.os, 'fstat', return_value=replacement), self.assertRaisesRegex(namespace.NamespaceError, '^system-path-changed$'):
            self.observer.observe()
        self.assertEqual(self.events, [])
        calls = 0
        def not_pipe(descriptor):
            nonlocal calls
            calls += 1
            return original(descriptor) if calls == 1 else types.SimpleNamespace(st_mode=stat.S_IFREG)
        with patch.object(namespace.os, 'fstat', side_effect=not_pipe), self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
            self.observer.observe()
        self.assertEqual([event[0] for event in self.events], ['close-owned', 'close-owned'])

    def test_spawn_failure_closes_only_its_owned_pipe(self):
        self.observe_fixture()
        self.observer.spawner = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError('not executed'))
        with self.assertRaises(OSError):
            self.observer.observe()
        self.assertEqual([event[0] for event in self.events], ['close-owned', 'close-owned'])

    def test_unknown_join_never_returns_a_positive_result_or_delivers_pipe_eof(self):
        self.observe_fixture()
        descriptors = []
        original = namespace.os.pipe
        def pipe():
            value = original()
            descriptors.extend(value)
            return value
        try:
            with patch.object(namespace.os, 'pipe', side_effect=pipe), patch.object(self.child, 'wait', side_effect=subprocess.TimeoutExpired('owned', 10)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    self.observer.observe()
            self.assertFalse(any(event[0] == 'close-owned' for event in self.events if isinstance(event, tuple)))
        finally:
            # Synthetic child only; explicitly reclaim this fixture's real FDs.
            for descriptor in descriptors:
                os.close(descriptor)

    def test_root_context_and_kernel_epoch_boundary_are_positive_not_name_inferences(self):
        self.observer.paths.update(namespace_level='synthetic-level', revision='synthetic-revision', context='synthetic-context')
        for level, label, revision, accepted in ((b'0\n', b'unconfined\n', b'12\n', True),
                (b'1\n', b'unconfined\n', b'12\n', False),
                (b'0\n', b'named (unconfined)\n', b'12\n', False),
                (b'0\n', b'unconfined\n', b'unknown\n', False)):
            with self.subTest(level=level, label=label, revision=revision), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(namespace, 'read_kernel_once', side_effect=[level, revision]))
                stack.enter_context(patch.object(namespace, 'process_value', return_value=label))
                stack.enter_context(patch.object(namespace, 'namespace_identity', return_value=self.namespaces))
                if accepted:
                    self.assertEqual(self.observer.boundary(), (b'12\n', self.namespaces))
                else:
                    with self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
                        self.observer.boundary()

    def child_fixture(self):
        root = self.root / 'proc' / str(self.child.pid)
        root.mkdir(parents=True)
        (root / 'attr/apparmor').mkdir(parents=True)
        (root / 'exe').write_bytes(b'not executed')
        (root / 'status').write_bytes(b'Uid:\t12345\t12345\t12345\t12345\nGid:\t54321\t54321\t54321\t54321\n')
        raw = b'98765 (space ) in name) S ' + str(os.getpid()).encode() + b' ' + b'0 ' * 17 + b'1234 0\n'
        (root / 'stat').write_bytes(raw)
        (root / 'attr/apparmor/current').write_bytes(b'unconfined\n')
        (root / 'wchan').write_bytes(b'pipe_read\n')
        path_class = pathlib.Path
        original_stat = path_class.stat
        pipe = types.SimpleNamespace(st_mode=stat.S_IFIFO, st_dev=33, st_ino=44)
        def path(value):
            return self.root / 'proc' if value == '/proc' else path_class(value)
        def stat_value(value, *args, **kwargs):
            return pipe if value == root / 'fd/7' else original_stat(value, *args, **kwargs)
        image = namespace.file_identity((root / 'exe').stat())
        self.enterContext(patch.object(namespace.pathlib, 'Path', side_effect=path))
        self.enterContext(patch.object(path_class, 'stat', stat_value))
        self.enterContext(patch.object(namespace, 'namespace_identity', return_value=self.namespaces))
        return root, image, (33, 44)

    def test_child_observation_checks_actual_process_context_and_wait_state(self):
        root, image, pipe = self.child_fixture()
        observed = self.observer.child_identity(self.child, image, pipe, 7, self.namespaces)
        self.assertEqual(observed, ((os.getpid(), 1234), image, b'unconfined\n'))
        (root / 'wchan').write_bytes(b'0\n')
        self.assertIsNone(self.observer.child_identity(self.child, image, pipe, 7, self.namespaces))

    def test_named_profile_wrong_uid_executable_pipe_namespace_or_parent_is_rejected(self):
        root, image, pipe = self.child_fixture()
        labels = (b'other (unconfined)\n', b'other (enforce)\n', b'unconfined//&other\n')
        for label in labels:
            (root / 'attr/apparmor/current').write_bytes(label)
            with self.subTest(label=label), self.assertRaisesRegex(namespace.NamespaceError, '^existing-bwrap-policy$'):
                self.observer.child_identity(self.child, image, pipe, 7, self.namespaces)
        (root / 'attr/apparmor/current').write_bytes(b'unconfined\n')
        for changed_image, changed_pipe, changed_namespaces in ((('changed',), pipe, self.namespaces),
                (image, (33, 45), self.namespaces), (image, pipe, ())):
            with self.assertRaisesRegex(namespace.NamespaceError, '^existing-bwrap-policy$'):
                self.observer.child_identity(self.child, changed_image, changed_pipe, 7, changed_namespaces)
        original_status = (root / 'status').read_bytes()
        for status in (b'', original_status.replace(b'12345', b'12346'), original_status.replace(b'54321', b'invalid')):
            (root / 'status').write_bytes(status)
            with self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
                self.observer.child_identity(self.child, image, pipe, 7, self.namespaces)
        (root / 'status').write_bytes(original_status)
        (root / 'stat').write_bytes(b'98765 (child) S 1 ' + b'0 ' * 17 + b'1234 0')
        with self.assertRaisesRegex(namespace.NamespaceError, '^existing-bwrap-policy$'):
            self.observer.child_identity(self.child, image, pipe, 7, self.namespaces)

    def test_exited_or_replaced_child_is_not_adopted(self):
        root, image, pipe = self.child_fixture()
        for outcomes in ([0], [None, 0]):
            with patch.object(self.child, 'poll', side_effect=outcomes), self.assertRaises(namespace.NamespaceError):
                self.observer.child_identity(self.child, image, pipe, 7, self.namespaces)
        valid = (root / 'stat').read_bytes()
        changed = valid.replace(b'1234 0', b'1235 0')
        original = namespace.process_value
        count = 0
        def replaced(path, limit=namespace.ATTACHMENT_LIMIT):
            nonlocal count
            if path == root / 'stat':
                count += 1
                return valid if count == 1 else changed
            return original(path, limit)
        with patch.object(namespace, 'process_value', side_effect=replaced), self.assertRaisesRegex(namespace.NamespaceError, '^system-path-changed$'):
            self.observer.child_identity(self.child, image, pipe, 7, self.namespaces)

    def test_bounded_metadata_and_malformed_process_identity_fail_closed(self):
        path = self.root / 'bounded'
        path.write_bytes(b'12345')
        with self.assertRaisesRegex(namespace.NamespaceError, '^policy-inspection-unavailable$'):
            namespace.process_value(path, 4)
        for raw in (b'invalid', b'(child) S invalid ' + b'0 ' * 18, b'without delimiter ' * 20):
            with self.subTest(raw=raw), self.assertRaises(namespace.NamespaceError):
                namespace.process_identity(raw)

    def test_each_namespace_identity_is_captured_from_the_fixed_kernel_links(self):
        seen = []
        class NamespacePath:
            def __truediv__(self, name):
                seen.append(name)
                return self
            def stat(self):
                return types.SimpleNamespace(st_dev=1, st_ino=len(seen))
        result = namespace.namespace_identity(NamespacePath())
        self.assertEqual([name for name, _identity in result], list(namespace.NAMESPACES))
        self.assertEqual(seen, [part for name in namespace.NAMESPACES for part in ('ns', name)])


class KernelEventReadTests(unittest.TestCase):
    def test_revision_read_is_one_nonblocking_syscall_not_a_buffered_eof_loop(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / 'revision'
            path.write_bytes(b'12\n')
            original = path.stat()
            changed = types.SimpleNamespace(st_dev=original.st_dev, st_ino=original.st_ino + 1,
                st_size=original.st_size, st_mtime_ns=original.st_mtime_ns)
            cases = [('success', b'12\n', original, [original, original], None),
                ('opened-changed', b'12\n', changed, [original], 'system-path-changed'),
                ('path-changed', b'12\n', original, [original, changed], 'system-path-changed'),
                ('limit', b'x' * 66, original, [original, original], 'policy-limit'),
                ('unavailable', BlockingIOError(), original, [original], BlockingIOError)]
            for name, raw, opened, stats, error in cases:
                with self.subTest(name=name), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(namespace, 'trusted_path', return_value=path))
                    stack.enter_context(patch.object(pathlib.Path, 'stat', side_effect=stats))
                    for key, value in (('O_NONBLOCK', 0x800), ('O_NOFOLLOW', 0x20000), ('O_CLOEXEC', 0x80000)):
                        stack.enter_context(patch.object(namespace.os, key, value, create=True))
                    opened_fd = stack.enter_context(patch.object(namespace.os, 'open', return_value=77777))
                    stack.enter_context(patch.object(namespace.os, 'fstat', return_value=opened))
                    read = stack.enter_context(patch.object(namespace.os, 'read', side_effect=raw if isinstance(raw, Exception) else [raw, AssertionError('second read would wait')]))
                    closed = stack.enter_context(patch.object(namespace.os, 'close'))
                    if error is None:
                        self.assertEqual(namespace.read_kernel_once(path, 64), b'12\n')
                    elif isinstance(error, str):
                        with self.assertRaisesRegex(namespace.NamespaceError, '^' + error + '$'):
                            namespace.read_kernel_once(path, 64)
                    else:
                        with self.assertRaises(error):
                            namespace.read_kernel_once(path, 64)
                    read.assert_called_once_with(77777, 65)
                    closed.assert_called_once_with(77777)
                    flags = opened_fd.call_args.args[1]
                    self.assertTrue(flags & 0x800 and flags & 0x20000 and flags & 0x80000)


if __name__ == '__main__':
    unittest.main()
