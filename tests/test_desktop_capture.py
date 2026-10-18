"""Optional display setup must not block the actual screenshot operation."""
import importlib.util
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vm'))
spec = importlib.util.spec_from_file_location('desktop_capture_test', ROOT / 'vm/desktop.py')
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class DesktopCaptureTests(unittest.TestCase):
    def test_optional_display_commands_cannot_prevent_capture_or_take_its_budget(self):
        for problem in ('timeout', 'missing', 'unsupported'):
            with self.subTest(problem=problem):
                captures = []
                setup_budgets = []

                def run(args, **kwargs):
                    if args[0] == 'xset':
                        setup_budgets.append(kwargs['timeout'])
                        if problem == 'timeout':
                            raise subprocess.TimeoutExpired(args, kwargs['timeout'])
                        if problem == 'missing':
                            raise FileNotFoundError('optional display tool unavailable')
                        return subprocess.CompletedProcess(args, 1, b'', b'unsupported extension')
                    self.assertEqual(args[0], 'scrot')
                    self.assertTrue(kwargs['check'])
                    self.assertEqual(kwargs['timeout'], 10)
                    captures.append(args)
                    pathlib.Path(args[-1]).write_bytes(b'synthetic PNG')
                    return subprocess.CompletedProcess(args, 0, b'', b'')

                with patch.object(desktop.subprocess, 'run', side_effect=run):
                    self.assertEqual(desktop.screenshot(), b'synthetic PNG')
                self.assertEqual(len(captures), 1)
                self.assertLessEqual(sum(setup_budgets) + 10, 12)

    def test_actual_capture_errors_remain_visible_and_are_not_retried(self):
        captures = []

        def run(args, **kwargs):
            if args[0] == 'xset':
                return subprocess.CompletedProcess(args, 0, b'', b'')
            captures.append(args)
            raise subprocess.TimeoutExpired(args, kwargs['timeout'])

        with patch.object(desktop.subprocess, 'run', side_effect=run):
            with self.assertRaises(subprocess.TimeoutExpired):
                desktop.screenshot()
        self.assertEqual(len(captures), 1)


if __name__ == '__main__':
    unittest.main()
