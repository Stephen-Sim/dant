"""Exercise the exact embedded bootstrap probes without SSH or any configured endpoint."""

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
SOURCE = ROOT / 'core/internal/computer/assets/worker_inspection.py'
SPEC = importlib.util.spec_from_file_location('worker_inspection', SOURCE)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class WorkerInspectionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = pathlib.Path(directory.name)
        (self.home / 'dant').mkdir()
        self.configuration = {'origin': 'http://127.0.0.1:5781', 'session': '/api/session',
                              'version': '/api/version', 'state': '/api/state'}
        self.token = 'a' * 64
        self.session = {'product': 'dant', 'mode': 'worker', 'runtime': 'go',
                        'protocol': 1, 'version': '0.4.7-beta.19', 'source': 'b' * 40, 'token': self.token}

    def opener(self, responses):
        pending, calls = list(responses), []

        def open_response(request, timeout):
            self.assertTrue(pending, 'No unplanned HTTP request may leave this fixture.')
            suffix, value = pending.pop(0)
            self.assertEqual(request.full_url, self.configuration['origin'] + suffix)
            self.assertIn(timeout, (probe.DEPLOYMENT_TIMEOUT_SECONDS, probe.STATE_TIMEOUT_SECONDS))
            if suffix != '/api/session':
                self.assertEqual(request.get_header('X-dant-token'), self.token)
            calls.append(request)
            if isinstance(value, Exception):
                raise value
            return io.BytesIO(value if isinstance(value, bytes) else json.dumps(value).encode())

        return types.SimpleNamespace(open=open_response), pending, calls

    def test_probe_configuration_accepts_validated_nondefault_port_and_rejects_network_escape(self):
        self.assertEqual(probe.read_configuration(json.dumps(self.configuration)), self.configuration)
        invalid = [None, '', '[]', '{}', 'x' * (probe.MAX_CONFIGURATION_BYTES + 1)]
        for origin in ('https://127.0.0.1:5781', 'http://remote.invalid:5781', 'http://0.0.0.0:5781',
                       'http://127.0.0.1', 'http://127.0.0.1:65536', 'http://user@127.0.0.1:5781',
                       'http://127.0.0.1:5781/path', 'http://127.0.0.1:5781?query', 'http://127.0.0.1:5781#fragment', 1):
            invalid.append(json.dumps({**self.configuration, 'origin': origin}))
        for route in ('https://remote.invalid/', '/api/../state', '/api/state?token=x', None):
            invalid.append(json.dumps({**self.configuration, 'state': route}))
        invalid.append(json.dumps({**self.configuration, 'extra': True}))
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                probe.read_configuration(raw)

    def test_deployment_reads_only_bounded_metadata_and_exact_authenticated_build_fields(self):
        fingerprint = 'c' * 64
        (self.home / 'dant/deployed-source.json').write_text(json.dumps({'sha256': fingerprint}))
        opener, pending, calls = self.opener([('/api/session', self.session), ('/api/version', {'version': self.session['version']})])
        with patch.object(pathlib.Path, 'home', return_value=self.home), \
                patch.object(probe.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
            result = probe.inspect_deployment(self.configuration, opener)
        self.assertEqual(pending, [])
        self.assertEqual(result['sha256'], fingerprint)
        self.assertEqual(result['version'], self.session['version'])
        self.assertEqual(result['session'], {key: value for key, value in self.session.items() if key != 'token'})
        self.assertNotIn(self.token, json.dumps(result))
        self.assertEqual(run.call_count, len(probe.SERVICE_UNITS))
        self.assertEqual(len(calls), 2)

    def test_absent_invalid_or_oversized_deployment_marker_and_inactive_services_stay_unconfirmed(self):
        marker = self.home / 'dant/deployed-source.json'
        for data in (None, b'invalid', b'[]', b'{"sha256":42}', b'{"sha256":"invalid"}', b'x' * (probe.MAX_DEPLOYMENT_BYTES + 1)):
            if data is None:
                marker.unlink(missing_ok=True)
            else:
                marker.write_bytes(data)
            opener, pending, _ = self.opener([])
            with patch.object(pathlib.Path, 'home', return_value=self.home), \
                    patch.object(probe.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)):
                result = probe.inspect_deployment(self.configuration, opener)
            self.assertEqual(result, {'sha256': None, 'active': False, 'version': None, 'session': None})
            self.assertEqual(pending, [])

    def test_unavailable_malformed_oversized_or_wrong_owner_never_confirms_a_build(self):
        for value in (OSError('PRIVATE RESPONSE'), b'invalid', [], {**self.session, 'mode': 'controller'},
                      {**self.session, 'token': 'bad'}, b'x' * (probe.MAX_DEPLOYMENT_BYTES + 1)):
            opener, pending, _ = self.opener([('/api/session', value)])
            with patch.object(pathlib.Path, 'home', return_value=self.home), \
                    patch.object(probe.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)):
                result = probe.inspect_deployment(self.configuration, opener)
            self.assertIsNone(result['version'])
            self.assertIsNone(result['session'])
            self.assertEqual(pending, [])
        for version in ('', 'x' * 65, None):
            legacy = {'product': 'dant', 'mode': 'worker', 'token': self.token}
            opener, _, _ = self.opener([('/api/session', legacy), ('/api/version', {'version': version})])
            with patch.object(pathlib.Path, 'home', return_value=self.home), \
                    patch.object(probe.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)):
                result = probe.inspect_deployment(self.configuration, opener)
            self.assertIsNone(result['version'])
            self.assertIsNone(result['session'])

    def test_quiescence_uses_the_supplied_origin_and_fails_without_matching_session(self):
        state = {'active': None, 'call': None, 'queue': [], 'takeover': False}
        opener, pending, _ = self.opener([('/api/session', self.session), ('/api/state', state)])
        self.assertEqual(probe.inspect_quiescence(self.configuration, opener), state)
        self.assertEqual(pending, [])
        for value in (None, {}, {**self.session, 'token': 5}, {**self.session, 'token': 'x' * 32}):
            with self.assertRaises(ValueError):
                probe.session_token(value)
        self.assertIsNone(probe.NoRedirect().redirect_request(None, None, None, None, None, None))

    def test_cli_reads_configuration_before_any_process_or_http_and_emits_only_public_metadata(self):
        for args in ([], ['unknown', '{}'], ['deployment']):
            with self.assertRaises(ValueError):
                probe.main(args)
        opener, pending, _ = self.opener([('/api/session', self.session), ('/api/state', {'active': None})])
        with patch.object(probe.urllib.request, 'build_opener', return_value=opener), \
                patch.object(sys, 'argv', [str(SOURCE), 'quiescence', json.dumps(self.configuration)]), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            runpy.run_path(str(SOURCE), run_name='__main__')
        self.assertEqual(json.loads(stdout.getvalue()), {'active': None})
        self.assertEqual(pending, [])


if __name__ == '__main__':
    unittest.main()
