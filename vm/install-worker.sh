#!/bin/bash
set -euo pipefail
umask 077
source_dir=$(realpath "$1")
operator_dir=$(realpath "$(dirname -- "${BASH_SOURCE[0]}")/..")
case "$source_dir" in "$HOME"/dant/releases/source.*) ;; *) echo 'Invalid worker source directory' >&2; exit 1;; esac
case "$operator_dir" in "$HOME"/dant/releases/source.*) ;; *) echo 'Invalid worker operator directory' >&2; exit 1;; esac
update_running_work=false
guard_only=false
reconcile_attempt=''
reconcile_sha=''
reconcile_requested=false
shift
while [ "$#" -gt 0 ]; do
  option=$1
  shift
  case "$option" in
    --update-running-work) if "$update_running_work"; then exit 1; fi; update_running_work=true ;;
    --guard-only) if "$guard_only"; then exit 1; fi; guard_only=true ;;
    --reconcile-stopped)
      if "$reconcile_requested" || [ "$#" -lt 2 ]; then exit 1; fi
      reconcile_requested=true
      reconcile_attempt=$1
      reconcile_sha=$2
      shift 2
      ;;
    *) echo 'Invalid worker update option' >&2; exit 1 ;;
  esac
done
if "$reconcile_requested" && { "$guard_only" || "$update_running_work"; }; then
  echo 'Invalid worker reconciliation option' >&2
  exit 1
fi
test "$(id -u)" -ne 0 || { echo 'Run the worker deployment as its ordinary VM user.' >&2; exit 1; }
# The host transfers only a fixed verified Go bundle and public network values.
# Verify again before executing its binary or changing live services.
public_environment=$(python3 "$operator_dir/vm/worker-install.py" verify "$source_dir" "$HOME")
IFS=$'\t' read -r guest_host guest_port worker_port target_version target_source <<< "$public_environment"
cd "$source_dir"

worker_service_state() {
  local service_state
  service_state=$(systemctl --user show dant-worker.service --property=ActiveState --value) || { echo 'The VM service state could not be confirmed; its files were preserved.' >&2; return 1; }
  case "$service_state" in active|inactive|failed) printf '%s\n' "$service_state" ;; *) echo 'The VM service is changing state. Its files were preserved; reconnect after it settles.' >&2; return 1 ;; esac
}
check_idle_worker() {
worker_checked_state=$(worker_service_state) || return 1
if [ "$worker_checked_state" = active ]; then
  python3 - "${1:-check}" <<'PY'
import json, math, sys, urllib.request, urllib.parse
base = 'http://127.0.0.1:4317'
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
        if state['call'] and (not isinstance(call_id, str) or not call_id or len(call_id) > 256):
            reject('call-owner-invalid')
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
PY
fi
}
if "$guard_only"; then
  if "$update_running_work"; then check_idle_worker pause; else check_idle_worker final; fi
  exit 0
fi
if ! "$reconcile_requested" && [ -f "$HOME/dant/deployed-source.json" ] && \
  cmp -s deploy-manifest.json "$HOME/dant/deployed-source.json" && \
  systemctl --user is-active --quiet dant-worker.service && \
  systemctl --user is-active --quiet dant-guest-local.service && \
  python3 "$source_dir/vm/worker-install.py" current "$source_dir" "$HOME"; then
  echo 'DANT_UPDATE_CURRENT'
  echo 'The current Go VM worker is already deployed; running work was preserved.'
  exit 0
fi
if [ -e "$HOME/dant/app" ] && [ ! -L "$HOME/dant/app" ]; then
  echo 'An existing non-symlink app directory was preserved; deployment requires manual review.' >&2
  exit 1
fi
if "$reconcile_requested"; then
  # This explicit operator path proves a stopped, pre-preparation attempt under
  # the installation lock. Automatic activation never acquires that permission.
  exec python3 "$operator_dir/vm/worker-install.py" reconcile-stopped "$source_dir" "$HOME" \
    --attempt-id "$reconcile_attempt" --journal-sha256 "$reconcile_sha"
fi
if ! "$update_running_work"; then check_idle_worker; fi
# Optional speech dependencies prepare while the previous worker is intact.
# Neither step downloads or executes a Node runtime.
bash vm/install-speech.sh
if ! bash vm/install-transcription.sh; then
  echo 'Local audio recognition is unavailable; existing chat and calls remain available.' >&2
fi
# The helper holds one installation lock, repeats the current-work guard, proves
# the old cgroup and Codex children stopped, backs up raw data, validates and
# migrates offline, then activates only Go. Unknown outcomes are never retried.
arguments=(activate "$source_dir" "$HOME")
if "$update_running_work"; then arguments+=(--update-running-work); fi
exec python3 "$source_dir/vm/worker-install.py" "${arguments[@]}"
