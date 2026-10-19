"""Guest response cancellation checks; no VM, desktop or browser is used."""
import importlib.util
import io
import json
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))
spec = importlib.util.spec_from_file_location('guest_test', ROOT / 'vm/guest.py')
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


def handler(path='/screen'):
    value = object.__new__(guest.Handler)
    value.path = path
    value.send_response = Mock()
    value.send_header = Mock()
    value.end_headers = Mock()
    value.wfile = io.BytesIO()
    value.close_connection = False
    return value


class GuestResponseTests(unittest.TestCase):
    def test_cancelled_screen_reply_closes_without_retrying_an_error_response(self):
        for failure in (BrokenPipeError, ConnectionResetError):
            for stage in ('headers', 'body'):
                with self.subTest(failure=failure.__name__, stage=stage):
                    request = handler()
                    target = request.end_headers if stage == 'headers' else request.wfile
                    if stage == 'headers':
                        target.side_effect = failure('client disconnected')
                    else:
                        request.wfile = Mock()
                        request.wfile.write.side_effect = failure('client disconnected')
                    with patch.object(guest, 'screenshot', return_value=b'PNG') as screenshot:
                        request.do_GET()
                    screenshot.assert_called_once_with()
                    request.send_response.assert_called_once_with(200)
                    self.assertTrue(request.close_connection)

    def test_real_capture_errors_still_return_server_error_and_closed_error_replies_are_safe(self):
        request = handler()
        with patch.object(guest, 'screenshot', side_effect=ValueError('capture failed')):
            request.do_GET()
        request.send_response.assert_called_once_with(500)
        self.assertEqual(json.loads(request.wfile.getvalue()), {'error': 'capture failed'})
        request = handler()
        request.wfile = Mock()
        request.wfile.write.side_effect = BrokenPipeError('client disconnected')
        with patch.object(guest, 'screenshot', side_effect=ValueError('capture failed')):
            request.do_GET()
        request.send_response.assert_called_once_with(500)
        self.assertTrue(request.close_connection)

    def test_input_acknowledgement_disconnect_does_not_repeat_the_input(self):
        request = handler('/input')
        body = json.dumps({'type': 'key', 'key': 'a', 'sessionId': 'owned-human-session'}).encode()
        request.headers = {'Content-Length': str(len(body))}
        request.rfile = io.BytesIO(body)
        request.wfile = Mock()
        request.wfile.write.side_effect = ConnectionResetError('client disconnected')
        with patch.object(guest, 'act', return_value={'ok': True}) as act, patch.object(guest, 'command', return_value={'status': 'human'}) as command:
            request.do_POST()
        self.assertEqual(act.call_count, 1)
        command.assert_called_once_with({'action': 'status'})
        request.send_response.assert_called_once_with(200)
        self.assertTrue(request.close_connection)


if __name__ == '__main__':
    unittest.main()
