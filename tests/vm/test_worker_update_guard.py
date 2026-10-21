"""Exercise the original update guard with owned HTTP replies, never a live worker."""

import contextlib
import copy
import io
import json
import pathlib
import runpy
import sys
import unittest
import urllib.request
import os
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vm'))
GUARD = ROOT / 'vm/worker-update-guard.py'


def idle():
    return {'active': None, 'call': None, 'queue': [], 'takeover': False,
            'computer': {'status': 'dant', 'sessionId': None},
            'worker': {'status': 'online'}, 'messages': [], 'workTasks': []}


def reply(route, value, body=None, error=False):
    return route, value, body, error


def session(value=None):
    return reply('/api/session', {'token': 'synthetic-session'} if value is None else value)


def state(value):
    return reply('/api/state', value)


def pause(value=None):
    return reply('/api/tasks/pause', {'ok': True} if value is None else value, {})


def witness():
    return reply('/api/connect', {'ok': True}, {'idleRecovery': True})


class WorkerUpdateGuardTests(unittest.TestCase):
    def test_native_endpoint_ignores_development_port_and_transport_cannot_redirect(self):
        with patch.dict(os.environ, {'DANT_PORT': 'private-sentinel'}, clear=True):
            result = self.run_guard([session(), state(idle())])
        self.assertEqual(result[0], 0)
        namespace = result[3]
        redirect = namespace['NoRedirect']()
        self.assertIsNone(redirect.redirect_request(None, None, 302, '', {}, 'http://invalid'))

    def run_guard(self, replies, mode='check'):
        remaining = list(replies)
        calls = []

        def request(value, timeout):
            url = value if isinstance(value, str) else value.full_url
            route = url.removeprefix('http://127.0.0.1:4317')
            body = None if isinstance(value, str) or value.data is None else json.loads(value.data)
            calls.append((route, body))
            self.assertTrue(remaining, 'No unplanned request may leave the fixture.')
            expected, result, expected_body, failure = remaining.pop(0)
            self.assertEqual((route, body), (expected, expected_body))
            self.assertEqual(timeout, 60 if body is not None else 3)
            if route != '/api/session':
                self.assertEqual(value.get_header('X-dant-token'), 'synthetic-session')
            if failure:
                raise TimeoutError('PRIVATE RESPONSE MUST NOT APPEAR')
            return io.BytesIO(json.dumps(result).encode())

        stdout, stderr = io.StringIO(), io.StringIO()
        status, namespace = 0, None
        with patch.object(sys, 'argv', [str(GUARD), mode]), \
                patch.object(urllib.request, 'urlopen', side_effect=request), \
                patch.object(urllib.request, 'install_opener'), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                namespace = runpy.run_path(str(GUARD), run_name='__main__')
            except SystemExit as error:
                status = error.code
        self.assertEqual(remaining, [], 'Every planned request must be observed.')
        self.assertNotIn('PRIVATE RESPONSE', stderr.getvalue())
        return status, stderr.getvalue(), calls, namespace

    def test_automatic_checks_only_read_and_never_replay_unknown_work(self):
        for mode in ('check', 'final'):
            with self.subTest(mode=mode):
                result = self.run_guard([session(), state(idle())], mode)
                self.assertEqual(result[0], 0)
                self.assertEqual(result[2], [('/api/session', None), ('/api/state', None)])
        for change in ({'active': {'id': 'synthetic'}}, {'queue': ['synthetic']},
                       {'call': {'id': 'synthetic'}}, {'takeover': True},
                       {'messages': [{'status': 'unknown'}]},
                       {'workTasks': [{'status': 'running'}]},
                       {'workTasks': [{'status': 'waiting_user', 'executionEndedAt': 0}]},
                       {'workTasks': [{'status': 'waiting_user', 'executionEndedAt': float('nan')}]},
                       {'workTasks': [{'status': 'paused', 'continuation': {'dispatch': {'phase': 'acknowledged'}}}]}):
            with self.subTest(change=change):
                result = self.run_guard([session(), state({**idle(), **change})])
                self.assertEqual(result[0], 79)
                self.assertIn('DANT_UPDATE_DEFERRED:work-still-active:initial', result[1])
                self.assertTrue(all(body is None for _, body in result[2]))

    def test_control_and_executor_ownership_block_before_any_write(self):
        for change, reason in (({'computer': {'status': 'human'}}, 'control-busy'),
                               ({'computer': {'status': 'dant', 'pending': True}}, 'control-busy'),
                               ({'acquiring': True}, 'control-busy'),
                               ({'worker': {'status': 'offline'}}, 'executor-offline')):
            for mode, expected in (('check', 79), ('pause', 1)):
                with self.subTest(change=change, mode=mode):
                    # A stopped manual executor may be recovered after two confirmed pauses.
                    if mode == 'pause' and reason == 'executor-offline':
                        continue
                    result = self.run_guard([session(), state({**idle(), **change})], mode)
                    self.assertEqual(result[0], expected)
                    self.assertIn(reason, result[1])

    def test_session_and_malformed_state_fail_closed_without_exposing_response(self):
        for first in (reply('/api/session', None, error=True), session([]), session({}),
                      session({'token': ''}), session({'token': 42})):
            with self.subTest(first=first):
                result = self.run_guard([first])
                self.assertEqual(result[0], 1)
                self.assertIn('session-', result[1])
        for invalid in (None, {}, {**idle(), 'queue': None}, {**idle(), 'active': 'bad'},
                        {**idle(), 'call': False}, {**idle(), 'call': {}},
                        {**idle(), 'call': {'id': ''}}, {**idle(), 'call': {'id': 2}},
                        {**idle(), 'call': {'id': 'x' * 257}}, {**idle(), 'messages': {}},
                        {**idle(), 'workTasks': None}, {**idle(), 'computer': {}},
                        {**idle(), 'worker': {}}, {**idle(), 'takeover': 0}):
            with self.subTest(invalid=invalid):
                result = self.run_guard([session(), state(invalid)])
                self.assertEqual(result[0], 79 if isinstance(invalid, dict) and invalid.get('worker') == {} else 1)
                self.assertIn('state-invalid' if not isinstance(invalid, dict) or invalid.get('worker') != {} else 'executor-offline', result[1])
        result = self.run_guard([session(), reply('/api/state', None, error=True)])
        self.assertIn('state-unavailable', result[1])

    def test_manual_pause_confirms_both_pauses_and_exact_call_before_recovery(self):
        initial = {**idle(), 'active': {'id': 'task'}, 'call': {'id': 'call'}}
        paused_call = {**idle(), 'call': {'id': 'call'}}
        result = self.run_guard([
            session(), state(initial), pause(), state(paused_call),
            reply('/api/call/stop', {'stopped': True}, {'callId': 'call'}),
            pause(), state(idle()), witness(), state(idle()),
        ], 'pause')
        self.assertEqual(result[0], 0, result[1])
        self.assertEqual(sum(route == '/api/tasks/pause' for route, _ in result[2]), 2)
        for failure in ({'ok': False}, []):
            result = self.run_guard([session(), state(idle()), pause(failure)], 'pause')
            self.assertEqual(result[0], 1)
            self.assertIn('pause-unconfirmed:pause', result[1])
        for wrong in ({'id': 'other'},):
            replies = [session(), state(initial), pause(), state({**idle(), 'call': wrong})]
            result = self.run_guard(replies, 'pause')
            self.assertEqual(result[0], 1)
            self.assertIn('call-owner-changed', result[1])

    def test_saved_continuations_require_exact_turn_and_acknowledgement(self):
        saved = {**idle(), 'workTasks': [{'id': 'old/task', 'turnId': 'old-turn', 'status': 'continuing'}]}
        result = self.run_guard([
            session(), state(saved), pause(), state(saved), pause(), state(saved),
            reply('/api/tasks/old%2Ftask/pause', {'ok': True, 'paused': True}, {'kind': 'work', 'turnId': 'old-turn'}),
            witness(), state(idle()),
        ], 'pause')
        self.assertEqual(result[0], 0, result[1])
        for field, value in (('id', ''), ('turnId', None), ('id', 'x' * 129), ('turnId', 'x' * 257)):
            current = copy.deepcopy(saved)
            current['workTasks'][0][field] = value
            result = self.run_guard([session(), state(current), pause(), state(current), pause(), state(current)], 'pause')
            self.assertEqual(result[0], 1)
            self.assertIn('work-unconfirmed', result[1])

    def test_rollback_idle_witness_and_offline_manual_recovery_preserve_paused_work(self):
        stopped = {**idle(), 'worker': {'status': 'offline'}, 'workTasks': [{'id': 'old', 'status': 'paused'}]}
        result = self.run_guard([session(), state(stopped), pause(), state(stopped), pause(), state(stopped), witness(), state(idle())], 'pause')
        self.assertEqual(result[0], 0, result[1])
        result = self.run_guard([session(), state(idle()), witness(), state(idle())], 'idle')
        self.assertEqual(result[0], 0)
        namespace = result[3]
        self.assertIsNotNone(namespace)
        self.assertIsNone(namespace['NoRedirect']().redirect_request(None, None, None, None, None, None))
        quiescent = namespace['quiescent']
        speech_history = {**idle(), 'messages': [{'role': 'user', 'workKind': 'conversation', 'voiceCallId': 'ended', 'status': 'accepted'}]}
        self.assertTrue(quiescent(speech_history))
        self.assertFalse(quiescent({**idle(), 'messages': [{'status': 'waiting_user'}]}))
        self.assertTrue(quiescent({**idle(), 'messages': [{'status': 'waiting_user', 'executionEndedAt': 5}]}))
        self.assertFalse(quiescent({**idle(), 'messages': None}))
        self.assertFalse(quiescent({**idle(), 'active': {'id': 'active'}}))
        self.assertFalse(quiescent({**idle(), 'messages': [{'status': 'queued'}]}))
        self.assertTrue(quiescent({**idle(), 'messages': [{'status': 'completed'}]}))
        self.assertTrue(namespace['unresolved']({**idle(), 'messages': [None]}))
        self.assertFalse(namespace['pending_saved_work']({**idle(), 'workTasks': [{'status': 'waiting_user', 'executionEndedAt': 5}]}))

    def test_each_manual_stage_rejects_new_work_without_repeating_a_write(self):
        offline = {**idle(), 'worker': {'status': 'offline'}}
        busy = {**offline, 'queue': ['new-task']}
        fixtures = [
            ([session(), state(busy)], 'work-still-active:initial'),
            ([session(), state({**idle(), 'takeover': True})], 'work-unconfirmed:initial'),
            ([session(), state(offline), pause(), state(busy)], 'work-still-active:post-pause'),
            ([session(), state(offline), pause(), state(offline), pause(), state(busy)], 'work-still-active:saved-pause'),
            ([session(), state(idle()), pause(), state(idle()), pause(), state({**idle(), 'active': {'id': 'new'}})], 'work-still-active:saved-pause'),
            ([session(), state(idle()), pause(), state(idle()), pause(), state(idle()), witness(), state({**idle(), 'queue': ['new']})], 'work-still-active:final'),
            ([session(), state({**idle(), 'worker': {'status': 'failed'}})], 'executor-offline:initial'),
        ]
        for replies, reason in fixtures:
            with self.subTest(reason=reason):
                result = self.run_guard(replies, 'pause')
                self.assertEqual(result[0], 1)
                self.assertIn(reason, result[1])
        call = {**idle(), 'call': {'id': 'call'}}
        result = self.run_guard([session(), state(call), pause(), state(call), reply('/api/call/stop', {'stopped': False}, {'callId': 'call'})], 'pause')
        self.assertIn('call-stop-unconfirmed:call-stop', result[1])
        saved = {**idle(), 'workTasks': [{'id': 'saved', 'turnId': 'turn', 'status': 'continuing'}]}
        result = self.run_guard([session(), state(saved), pause(), state(saved), pause(), state(saved), reply('/api/tasks/saved/pause', {'ok': True, 'paused': False}, {'kind': 'work', 'turnId': 'turn'})], 'pause')
        self.assertIn('saved-pause-unconfirmed:saved-pause', result[1])


if __name__ == '__main__':
    unittest.main()
