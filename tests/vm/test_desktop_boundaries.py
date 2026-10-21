"""Bounded input and CLI commands with no display, process execution or real lease."""
import contextlib
import importlib.util
import io
import json
import pathlib
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))
import control

spec = importlib.util.spec_from_file_location('desktop_bounds', ROOT / 'vm/desktop.py')
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class DesktopBoundaryTests(unittest.TestCase):
    def test_inputs_clamp_coordinates_buttons_scroll_and_unicode_without_shell(self):
        with patch.object(desktop, 'desktop_access', return_value=contextlib.nullcontext()), \
                patch.object(desktop.subprocess, 'run', return_value=types.SimpleNamespace(stdout=b'')) as process:
            self.assertEqual(desktop.act({'type': 'click', 'x': -20, 'y': 9000, 'button': 2}), {'ok': True})
            self.assertEqual(process.call_args_list[0].args[0], ('xdotool', 'mousemove', '0', '4096'))
            self.assertEqual(process.call_args_list[1].args[0], ('xdotool', 'click', '3'))
            desktop.act({'type': 'key', 'key': 'ctrl+l'})
            desktop.act({'type': 'text', 'text': '你好 world'})
            clipboard = [call for call in process.call_args_list if call.args[0][0] == 'xclip']
            self.assertEqual(clipboard[0].kwargs['input'], '你好 world'.encode())
            self.assertEqual(clipboard[0].kwargs['timeout'], 3)
            desktop.act({'type': 'scroll', 'delta': -500})
            self.assertEqual(process.call_args.args[0], ('xdotool', 'click', '--repeat', '12', '4'))
            desktop.act({'type': 'scroll', 'delta': 0})
            self.assertEqual(process.call_args.args[0], ('xdotool', 'click', '--repeat', '1', '5'))
            self.assertTrue(all(call.kwargs.get('timeout') in (3, 10) for call in process.call_args_list))

    def test_invalid_keys_text_and_action_never_reach_input_process(self):
        for payload in ({'type': 'key', 'key': None}, {'type': 'key', 'key': '-danger'},
                {'type': 'key', 'key': 'x' * 81}, {'type': 'text', 'text': 'x' * 100001}, {'type': 'unknown'}):
            with self.subTest(kind=payload['type']), patch.object(desktop, 'desktop_access', return_value=contextlib.nullcontext()), \
                    patch.object(desktop.subprocess, 'run') as process, self.assertRaises(ValueError):
                desktop.act(payload)
            process.assert_not_called()
        self.assertEqual(desktop.button(999), '1')

    def test_cli_routes_all_inputs_and_screenshot_only_to_injected_commands(self):
        for arguments in (['click', '10', '20'], ['drag', '1', '2', '3', '4'],
                ['key', 'Return'], ['text', '你好', 'world'], ['scroll', '-3']):
            with self.subTest(action=arguments[0]), patch.object(control, 'desktop_access', return_value=contextlib.nullcontext()), \
                    patch('subprocess.run', return_value=types.SimpleNamespace(stdout=b'')) as process, \
                    patch('time.sleep'), patch.object(sys, 'argv', ['desktop.py', *arguments]), contextlib.redirect_stdout(io.StringIO()) as output:
                runpy.run_path(str(ROOT / 'vm/desktop.py'), run_name='__main__')
            self.assertEqual(json.loads(output.getvalue()), {'ok': True})
            self.assertTrue(process.called)
            self.assertTrue(all(call.args[0][0] in ('xdotool', 'xclip') for call in process.call_args_list))
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'screen.png'
            def capture(arguments, **options):
                if arguments[0] == 'scrot':
                    pathlib.Path(arguments[-1]).write_bytes(b'synthetic PNG')
                return types.SimpleNamespace(stdout=b'')
            with patch.object(control, 'desktop_access', return_value=contextlib.nullcontext()), \
                    patch('subprocess.run', side_effect=capture), patch.object(sys, 'argv', ['desktop.py', 'screenshot', str(target)]), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                runpy.run_path(str(ROOT / 'vm/desktop.py'), run_name='__main__')
            self.assertEqual(target.read_bytes(), b'synthetic PNG')
            self.assertEqual(output.getvalue().strip(), str(target))

    def test_default_screenshot_uses_current_home_without_moving_old_artifacts(self):
        with tempfile.TemporaryDirectory() as folder:
            home = pathlib.Path(folder) / 'different-user'
            (home / 'work').mkdir(parents=True)
            preserved = home / 'work/existing.png'
            preserved.write_bytes(b'original artifact')

            def capture(arguments, **options):
                if arguments[0] == 'scrot':
                    pathlib.Path(arguments[-1]).write_bytes(b'synthetic PNG')
                return types.SimpleNamespace(stdout=b'')

            with patch.object(pathlib.Path, 'home', return_value=home), \
                    patch.object(control, 'desktop_access', return_value=contextlib.nullcontext()), \
                    patch('subprocess.run', side_effect=capture), \
                    patch.object(sys, 'argv', ['desktop.py', 'screenshot']), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                runpy.run_path(str(ROOT / 'vm/desktop.py'), run_name='__main__')

            self.assertEqual((home / 'work/screen.png').read_bytes(), b'synthetic PNG')
            self.assertEqual(output.getvalue().strip(), str(home / 'work/screen.png'))
            self.assertEqual(preserved.read_bytes(), b'original artifact')


if __name__ == '__main__':
    unittest.main()
