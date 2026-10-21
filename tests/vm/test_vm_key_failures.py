"""Synthetic key-process failures preserve existing machine-key bytes."""
import contextlib
import importlib.util
import io
import pathlib
import runpy
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('key_failures', ROOT / 'scripts/vm-key.py')
key = importlib.util.module_from_spec(spec)
spec.loader.exec_module(key)
PUBLIC = 'ssh-ed25519 AAAAsynthetic dant-local-vm'


class MachineKeyFailures(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = pathlib.Path(self.directory.name) / 'vm-key'
        self.public = pathlib.Path(str(self.path) + '.pub')

    def existing(self):
        self.path.write_bytes(b'synthetic private fixture')
        self.public.write_text(PUBLIC, encoding='utf-8')

    def reply(self, code=0, text=PUBLIC):
        return types.SimpleNamespace(returncode=code, stdout=text)

    def test_orphan_generation_failure_nonregular_and_invalid_public_are_not_overwritten(self):
        self.public.write_text(PUBLIC)
        with patch.object(key, 'keygen') as process, self.assertRaisesRegex(key.KeyError, 'Orphan'):
            key.ensure_key(self.path)
        process.assert_not_called()
        self.public.unlink()
        with patch.object(key, 'keygen', return_value=self.reply(1)), self.assertRaisesRegex(key.KeyError, 'generation failed'):
            key.ensure_key(self.path)
        self.assertFalse(self.path.exists())
        self.path.mkdir()
        with patch.object(key, 'keygen') as process, self.assertRaisesRegex(key.KeyError, 'regular file'):
            key.ensure_key(self.path)
        process.assert_not_called()
        self.path.rmdir()
        self.existing()
        self.public.write_text('ssh-rsa private sentinel')
        with patch.object(key, 'keygen') as process, self.assertRaisesRegex(key.KeyError, 'ed25519'):
            key.ensure_key(self.path)
        process.assert_not_called()

    def test_missing_public_file_is_recovered_only_from_validated_private_result(self):
        self.path.write_bytes(b'synthetic private fixture')
        with patch.object(key, 'keygen', return_value=self.reply()) as process:
            self.assertIn('recovered', key.ensure_key(self.path))
        self.assertEqual(self.public.read_text(), PUBLIC + '\n')
        self.assertEqual(self.path.read_bytes(), b'synthetic private fixture')
        process.assert_called_once_with('-y', '-P', '', '-f', str(self.path.resolve()))

    def test_legacy_repair_rejects_foreign_comment_failed_write_or_failed_verification(self):
        for replies, reason in (([self.reply(1), self.reply(text='ssh-ed25519 AAAAsynthetic foreign')], 'comment'),
                ([self.reply(1), self.reply(), self.reply(1)], 'repair failed'),
                ([self.reply(1), self.reply(), self.reply(), self.reply(1)], 'verification'),
                ([self.reply(1), self.reply(), self.reply(), self.reply(text='ssh-ed25519 AAAAsynthetic foreign')], 'comment')):
            with self.subTest(reason=reason):
                self.existing()
                before = self.path.read_bytes(), self.public.read_bytes()
                with patch.object(key, 'keygen', side_effect=replies), self.assertRaisesRegex(key.KeyError, reason):
                    key.ensure_key(self.path)
                self.assertEqual((self.path.read_bytes(), self.public.read_bytes()), before)

    def test_changed_public_during_repair_is_detected_and_never_rewritten(self):
        self.existing()
        replies = iter([self.reply(1), self.reply(), self.reply(), self.reply()])
        def process(*arguments):
            if arguments[0] == '-p':
                self.public.write_text(PUBLIC + ' changed')
            return next(replies)
        with patch.object(key, 'keygen', side_effect=process), self.assertRaisesRegex(key.KeyError, 'changed during repair'):
            key.ensure_key(self.path)
        self.assertEqual(self.public.read_text(), PUBLIC + ' changed')
        self.assertEqual(self.path.read_bytes(), b'synthetic private fixture')

    def test_cli_success_and_process_failure_are_reported_without_command_output(self):
        for error in (None, key.KeyError('fixed synthetic rejection'), subprocess.TimeoutExpired('ssh-keygen', 30)):
            output = io.StringIO()
            with patch('sys.argv', ['vm-key.py', str(self.path)]), \
                    patch.object(key, 'ensure_key', side_effect=error, return_value='validated'), contextlib.redirect_stdout(output):
                if error is None:
                    key.main()
                else:
                    with self.assertRaises(SystemExit) as failure:
                        key.main()
                    self.assertIn('SSH machine-key preparation failed:', str(failure.exception))
            self.assertEqual(output.getvalue(), 'SSH machine key: validated\n' if error is None else '')

    def test_script_entrypoint_reports_failed_generation_without_publishing_a_key(self):
        with patch.object(sys, 'argv', ['vm-key.py', str(self.path)]), \
                patch('subprocess.run', return_value=self.reply(1)), self.assertRaises(SystemExit) as failure:
            runpy.run_path(str(ROOT / 'scripts/vm-key.py'), run_name='__main__')
        self.assertIn('SSH key generation failed', str(failure.exception))
        self.assertFalse(self.path.exists())
        self.assertFalse(self.public.exists())


if __name__ == '__main__':
    unittest.main()
