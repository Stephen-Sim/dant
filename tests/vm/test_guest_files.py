"""Exercise HTTP handler contracts directly, without creating a listener or desktop."""
import base64
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))
spec = importlib.util.spec_from_file_location('guest_files_test', ROOT / 'vm/guest.py')
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


def request(path, body=None):
    value = object.__new__(guest.Handler)
    value.path = path
    raw = json.dumps(body).encode() if body is not None else b''
    value.headers = {'Content-Length': str(len(raw))}
    value.rfile = io.BytesIO(raw)
    value.wfile = io.BytesIO()
    value.send_response = Mock()
    value.send_header = Mock()
    value.end_headers = Mock()
    return value


class GuestFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name).resolve()
        self.addCleanup(patch.stopall)
        patch.object(guest, 'ROOT', self.directory).start()

    def response(self, value, status=200):
        value.send_response.assert_called_once_with(status)
        raw = value.wfile.getvalue()
        value.send_header.assert_any_call('Content-Length', str(len(raw)))
        return json.loads(raw)

    def test_binary_upload_name_is_confined_and_read_roundtrip_preserves_bytes(self):
        content = b'\x00\xff\x80arbitrary binary'
        value = request(guest.PATHS['file'], {'name': '..\\nested/voice.bin', 'data': base64.b64encode(content).decode()})
        value.do_POST()
        target = pathlib.Path(self.response(value)['path'])
        self.assertEqual(target.parent, self.directory / 'uploads')
        self.assertTrue(target.name.endswith('-voice.bin'))
        self.assertEqual(target.read_bytes(), content)
        value = request(guest.PATHS['readFile'], {'path': str(target)})
        value.do_POST()
        body = self.response(value)
        self.assertEqual(base64.b64decode(body['data']), content)
        self.assertEqual(body['name'], target.name)
        self.assertEqual(body['type'], 'application/octet-stream')
        self.assertEqual(body['size'], len(content))

    def test_escaped_or_oversized_read_and_bad_upload_never_release_contents(self):
        outside = self.directory.parent / 'outside-synthetic.bin'
        value = request(guest.PATHS['readFile'], {'path': str(outside)})
        value.do_POST()
        self.assertIn('Only work directory', self.response(value, 400)['error'])
        large = self.directory / 'large.bin'
        with large.open('wb') as stream:
            stream.truncate(25 * 1024 * 1024 + 1)
        value = request(guest.PATHS['readFile'], {'path': str(large)})
        value.do_POST()
        self.assertIn('25 MB', self.response(value, 400)['error'])
        value = request(guest.PATHS['file'], {'name': 'invalid.bin', 'data': 'not-base64!!'})
        value.do_POST()
        self.response(value, 400)
        self.assertEqual(list((self.directory / 'uploads').iterdir()), [])

    def test_input_requires_session_control_has_no_input_and_unknown_routes_do_nothing(self):
        with patch.object(guest, 'act', return_value={'ok': True}) as act, \
                patch.object(guest, 'command', return_value={'status': 'human'}) as command:
            missing = request(guest.PATHS['input'], {'type': 'click'})
            missing.do_POST()
            self.response(missing, 400)
            act.assert_not_called()
            command.assert_not_called()
            control = request(guest.PATHS['control'], {'action': 'status'})
            control.do_POST()
            self.assertEqual(self.response(control), {'status': 'human'})
            command.assert_called_once_with({'action': 'status'})
            act.assert_not_called()
            unknown = request('/unrecognized', {})
            unknown.do_POST()
            self.assertEqual(self.response(unknown, 404), {'error': 'Not found'})
            unknown.log_message('private synthetic message')

    def test_payload_limit_and_health_do_not_touch_desktop(self):
        value = request(guest.PATHS['input'], {})
        value.headers['Content-Length'] = str(36 * 1024 * 1024 + 1)
        value.rfile = Mock()
        with patch.object(guest, 'act') as act:
            value.do_POST()
        self.assertEqual(self.response(value, 400), {'error': 'Too large'})
        value.rfile.read.assert_not_called()
        act.assert_not_called()
        value = request(guest.PATHS['health'])
        value.do_GET()
        self.assertEqual(self.response(value), {'ok': True})
        value = request('/unrecognized')
        value.do_GET()
        self.assertEqual(self.response(value, 404), {'error': 'Not found'})


if __name__ == '__main__':
    unittest.main()
