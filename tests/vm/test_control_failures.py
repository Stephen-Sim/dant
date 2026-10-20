"""Lease rejection and atomic-write failure tests use only private temporary state."""
import importlib.util
import json
import os
import pathlib
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('control_failures', ROOT / 'vm/control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class ControlFailureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = pathlib.Path(self.directory.name) / 'control.json'
        self.env = patch.dict(os.environ, DANT_CONTROL_FILE=str(self.path))
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_unconfirmed_takeover_never_renews_or_grants_human_input(self):
        reservation = control.command({'action': 'acquire'})
        before = self.path.read_bytes()
        for body in ({'action': 'acquire'}, {'action': 'renew', 'sessionId': reservation['sessionId']},
                {'action': 'confirm', 'sessionId': 'foreign'}, {'action': 'unknown'}):
            with self.subTest(action=body['action']), self.assertRaises(ValueError):
                control.command(body)
            self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaises(ValueError):
            with control.desktop_access(reservation['sessionId']):
                self.fail('Unconfirmed lease must not admit input')
        control.command({'action': 'confirm', 'sessionId': reservation['sessionId']})
        with control.desktop_access(reservation['sessionId']):
            pass
        self.assertEqual(json.loads(self.path.read_bytes())['status'], 'human')

    def test_oversized_invalid_and_link_state_refuse_before_mutation(self):
        for raw in (b'x' * 4097, b'invalid json'):
            self.path.write_bytes(raw)
            with self.assertRaises(ValueError):
                control.command({'action': 'status'})
            self.assertEqual(self.path.read_bytes(), raw)
        self.path.unlink()
        original = pathlib.Path.is_symlink
        with patch.object(pathlib.Path, 'is_symlink', lambda value: value == self.path.parent or original(value)), \
                patch.object(control.os, 'open') as opening, self.assertRaisesRegex(ValueError, 'directory'):
            control.command({'action': 'status'})
        opening.assert_not_called()
        with patch.object(pathlib.Path, 'is_symlink', lambda value: value == self.path or original(value)), \
                self.assertRaisesRegex(ValueError, 'state'):
            control.command({'action': 'status'})
        self.assertFalse(self.path.exists())

    def test_failed_atomic_replace_preserves_old_lease_and_cleans_only_owned_temporary(self):
        control.command({'action': 'status'})
        before = self.path.read_bytes()
        with patch.object(control.os, 'replace', side_effect=OSError('isolated write failure')), self.assertRaises(OSError):
            control.command({'action': 'acquire'})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob('.computer-*')), [])

    def test_linux_lock_is_always_released_and_expired_state_becomes_unreserved(self):
        lock = types.SimpleNamespace(LOCK_EX=1, LOCK_UN=2, flock=Mock())
        self.path.write_text(json.dumps({'status': 'human', 'sessionId': 'old', 'expiresAt': 1}))
        with patch.object(control, 'fcntl', lock):
            result = control.command({'action': 'status'})
        self.assertEqual(result, {'status': 'dant', 'sessionId': None, 'expiresAt': 0})
        self.assertEqual([call.args[1] for call in lock.flock.call_args_list], [1, 2])
        with patch.dict(os.environ, {}, clear=True), patch.object(control.pathlib.Path, 'home', return_value=self.path.parent):
            self.assertEqual(control.control_path(), self.path.parent / 'dant/data/computer-control.json')


if __name__ == '__main__':
    unittest.main()
