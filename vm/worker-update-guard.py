#!/usr/bin/env python3
"""Check the exact worker state before a service update."""

import json, math, sys, urllib.request, urllib.parse
from network_config import api_origin

base = api_origin()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()))
manual = sys.argv[1] == 'pause'
idle_witness = sys.argv[1] == 'idle'
stage = 'rollback' if sys.argv[1] == 'idle' else 'final' if sys.argv[1] == 'final' else 'initial'
class UpdateGuardError(Exception):
    def __init__(self, reason):
        self.reason = reason
def reject(reason):
    raise UpdateGuardError(reason)
def defer(reason):
    print('DANT_WORK_ACTIVE', file=sys.stderr)
    print('DANT_UPDATE_DEFERRED:' + reason + ':' + stage, file=sys.stderr)
    sys.exit(79)
try:
    try:
        session = json.load(urllib.request.urlopen(base + '/api/session', timeout=3))
    except Exception:
        reject('session-unavailable')
    token = session.get('token') if isinstance(session, dict) else None
    if not isinstance(token, str) or not token:
        reject('session-invalid')
    def request(route, data=None, reason='request-unconfirmed'):
        headers = {'X-Dant-Token': token}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(base + route, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            return json.load(urllib.request.urlopen(req, timeout=60 if data is not None else 3))
        except Exception:
            reject(reason)
    def confirmed(route, data, reason):
        reply = request(route, data, reason)
        if not isinstance(reply, dict) or reply.get('ok') is not True:
            reject(reason)
    def snapshot(allow_offline=False):
        state = request('/api/state', reason='state-unavailable')
        if not isinstance(state, dict) or not all(key in state for key in ('active', 'queue', 'call', 'takeover')) or not isinstance(state['queue'], list) or not isinstance(state['takeover'], bool) or state['active'] is not None and not isinstance(state['active'], dict) or state['call'] is not None and not isinstance(state['call'], dict):
            reject('state-invalid')
        if not isinstance(state.get('messages', []), list) or not isinstance(state.get('workTasks', []), list):
            reject('state-invalid')
        call = state['call']
        if call is not None and (not isinstance(call.get('id'), str) or not call['id'] or len(call['id']) > 256):
            reject('call-owner-invalid' if manual else 'state-invalid')
        computer = state.get('computer')
        if not isinstance(computer, dict) or computer.get('status') not in ('dant', 'human', 'taking-over'):
            reject('state-invalid')
        if computer['status'] != 'dant' or computer.get('sessionId') or computer.get('pending') or computer.get('acquiring') or state.get('acquiring'):
            if not manual:
                defer('control-busy')
            reject('control-busy')
        worker = state.get('worker')
        if not isinstance(worker, dict) or worker.get('status') != 'online' and not (allow_offline and worker.get('status') == 'offline'):
            if not manual:
                defer('executor-offline')
            reject('executor-offline')
        return state
    def unresolved(state, final=False):
        for entry in state.get('messages', []) + state.get('workTasks', []):
            if not isinstance(entry, dict):
                return True
            if entry.get('status') not in ('completed', 'cancelled') and (entry.get('unknownOutcome') is True or entry.get('submission') in ('unknown', 'submitting') or entry.get('status') == 'unknown'):
                return True
            continuation = entry.get('continuation') or {}
            dispatch = continuation.get('dispatch') if isinstance(continuation, dict) else None
            if not isinstance(continuation, dict) or continuation.get('invalid') or dispatch and (not isinstance(dispatch, dict) or final or dispatch.get('phase') in ('unknown', 'submitting')):
                return True
        return False
    def pending_saved_work(state):
        for entry in state.get('workTasks', []):
            if entry.get('status') in ('running', 'queued', 'accepted', 'continuing', 'pausing', 'unknown'):
                return True
            if entry.get('status') == 'waiting_user':
                ended = entry.get('executionEndedAt')
                if type(ended) not in (int, float) or not math.isfinite(ended) or ended <= 0:
                    return True
        return False
    def quiescent(state):
        if not isinstance(state.get('messages'), list) or not isinstance(state.get('workTasks'), list):
            return False
        if state['active'] or state['call'] or state['queue'] or state['takeover'] or unresolved(state, final=True) or pending_saved_work(state):
            return False
        for entry in state.get('messages', []):
            # Accepted speech from an ended call is history, with no task owner.
            if entry.get('role') == 'user' and entry.get('workKind') == 'conversation' and entry.get('voiceCallId') and not entry.get('turnId') and not entry.get('workId') and entry.get('status') == 'accepted':
                continue
            if entry.get('status') in ('running', 'queued', 'accepted', 'continuing', 'pausing', 'unknown'):
                return False
            if entry.get('status') == 'waiting_user':
                ended = entry.get('executionEndedAt')
                if type(ended) not in (int, float) or not math.isfinite(ended) or ended <= 0:
                    return False
        return True
    state = snapshot(allow_offline=manual)
    stopped_executor = manual and state['worker']['status'] == 'offline'
    if stopped_executor and not quiescent(state):
        reject('work-still-active')
    if manual:
        if state['takeover'] or unresolved(state):
            reject('work-unconfirmed')
        call_id = state['call'].get('id') if state['call'] else None
        stage = 'pause'
        confirmed('/api/tasks/pause', {}, 'pause-unconfirmed')
        stage = 'post-pause'
        state = snapshot(allow_offline=stopped_executor)
        if stopped_executor and not quiescent(state):
            reject('work-still-active')
        if state['call']:
            if not call_id or state['call'].get('id') != call_id:
                reject('call-owner-changed')
            stage = 'call-stop'
            result = request('/api/call/stop', {'callId': call_id}, 'call-stop-unconfirmed')
            if not isinstance(result, dict) or result.get('stopped') is not True:
                reject('call-stop-unconfirmed')
        # Older workers mark the just-ended active task continuing only after
        # their first pause. This confirmed second operation pauses that record
        # too, preventing its supervisor from starting another turn mid-update.
        stage = 'saved-pause'
        confirmed('/api/tasks/pause', {}, 'saved-pause-unconfirmed')
        state = snapshot(allow_offline=stopped_executor)
        if stopped_executor and not quiescent(state):
            reject('work-still-active')
        if state['active'] or state['call'] or state['queue'] or state['takeover'] or unresolved(state, final=True):
            reject('work-still-active')
        # Legacy bulk pause skips historical continuing records whose plans are
        # complete or missing an end timestamp. Use their owner-checked pause
        # endpoint instead of deleting history or treating them as live forever.
        for entry in state.get('workTasks', []):
            if entry.get('status') not in ('continuing', 'waiting_user'):
                continue
            task_id, turn_id = entry.get('id'), entry.get('turnId')
            if not isinstance(task_id, str) or not task_id or len(task_id) > 128 or not isinstance(turn_id, str) or not turn_id or len(turn_id) > 256:
                reject('work-unconfirmed')
            result = request('/api/tasks/' + urllib.parse.quote(task_id, safe='') + '/pause', {'kind': 'work', 'turnId': turn_id}, 'saved-pause-unconfirmed')
            if not isinstance(result, dict) or result.get('ok') is not True or result.get('paused') is not True:
                reject('saved-pause-unconfirmed')
    if manual or idle_witness:
        stage = 'final' if manual else 'rollback'
        # Legacy snapshots omit pending handoffs and finalization. Preserve the
        # existing explicit manual/rollback witness; automatic checks use GET only.
        # Only explicit installation may recover an already stopped executor, after
        # both confirmed pauses and fresh quiescent snapshots. This endpoint checks
        # hidden work before connecting; paused records are never resumed. The
        # resulting executor must be online before any live files can be replaced.
        confirmed('/api/connect', {'idleRecovery': True}, 'idle-unconfirmed')
        state = snapshot()
    if state['active'] or state['call'] or state['queue'] or state['takeover'] or unresolved(state, final=True) or pending_saved_work(state):
        if manual:
            reject('work-still-active')
        defer('work-still-active')
except Exception as error:
    reason = error.reason if isinstance(error, UpdateGuardError) else 'request-unconfirmed'
    print('DANT_UPDATE_FAILED:' + reason + ':' + stage, file=sys.stderr)
    print('VM update could not confirm that work stopped. Saved task records were preserved; no unconfirmed action was resent.', file=sys.stderr)
    sys.exit(1)
