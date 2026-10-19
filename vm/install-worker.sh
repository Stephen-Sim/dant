#!/bin/bash
set -euo pipefail
umask 077
source_dir=$(realpath "$1")
case "$source_dir" in "$HOME"/dant/releases/source.*) ;; *) echo 'Invalid worker source directory' >&2; exit 1;; esac
update_running_work=false
case "${2:-}" in '') ;; --update-running-work) update_running_work=true ;; *) echo 'Invalid worker update option' >&2; exit 1;; esac
test "$(id -u)" -ne 0 || { echo 'Run the worker deployment as its ordinary VM user.' >&2; exit 1; }
require_typescript_runtime() {
  # Probe only a fixed expression before loading new application source. An
  # incompatible existing runtime is never overwritten or used to stop work.
  if ! timeout 15s "$1" --input-type=module-typescript -e 'const [major, minor] = process.versions.node.split(".").map(Number); const supported: boolean = ((major === 22 && minor >= 18) || major >= 24) && ["strip", "transform"].includes(process.features.typescript); if (!supported) process.exit(1);' >/dev/null 2>&1; then
    echo 'DANT_UPDATE_FAILED:runtime-incompatible:prepare' >&2
    echo 'The VM Node runtime cannot run this update. Existing services and runtime were preserved; update the runtime through a verified maintenance procedure before reconnecting.' >&2
    return 1
  fi
}
if [ -e "$HOME/dant/runtime/node" ] || [ -L "$HOME/dant/runtime/node" ]; then
  require_typescript_runtime "$HOME/dant/runtime/node/bin/node"
fi
# Only validated, non-secret deployment options are transferred from Windows.
# Never source a host .env file or interpolate arbitrary environment variables.
public_environment=$(python3 - "$source_dir" <<'PY'
import json, pathlib, re, sys
try:
    root = pathlib.Path(sys.argv[1])
    protocol = json.loads((root/'src/config/protocol.json').read_text(encoding='utf-8'))
    manifest = json.loads((root/'deploy-manifest.json').read_text(encoding='utf-8'))
    defaults = {'DANT_GUEST_HOST': protocol['loopbackHost'], 'DANT_GUEST_PORT': str(protocol['guestPort'])}
    value = manifest.get('publicEnvironment', defaults)
    if not isinstance(value,dict) or set(value) != set(defaults):
        raise ValueError()
    host, port = value['DANT_GUEST_HOST'], value['DANT_GUEST_PORT']
    if not isinstance(host,str) or host not in protocol['loopbackHosts']:
        raise ValueError()
    if not isinstance(port,str) or re.fullmatch(r'[1-9][0-9]{0,4}',port) is None or not 1 <= int(port) <= 65535:
        raise ValueError()
    api_port = protocol['apiPort']
    if type(api_port) is not int or not 1 <= api_port <= 65535:
        raise ValueError()
    print(host+'\t'+port+'\t'+str(api_port))
except Exception:
    print('Invalid public VM network configuration; existing services were preserved.', file=sys.stderr)
    sys.exit(1)
PY
)
IFS=$'\t' read -r guest_host guest_port worker_port <<< "$public_environment"
mkdir -p "$HOME/dant/runtime" "$HOME/dant/data" "$HOME/dant/workspaces" "$HOME/dant/vm" "$HOME/.config/systemd/user"

if [ ! -x "$HOME/dant/runtime/node/bin/node" ]; then
  python3 - "$HOME/dant/runtime" <<'PY'
import hashlib, pathlib, tarfile, tempfile, urllib.request, sys
root = pathlib.Path(sys.argv[1])
base = 'https://nodejs.org/dist/latest-v22.x/'
checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60).read().decode()
entries = [(digest, name.lstrip('*')) for digest, name in (line.split() for line in checksums.splitlines()) if name.endswith('-linux-x64.tar.xz')]
assert len(entries) == 1, 'Cannot identify official Linux x64 Node 22 archive'
digest, name = entries[0]
with tempfile.TemporaryDirectory(dir=root) as temporary:
    archive = pathlib.Path(temporary) / name
    with urllib.request.urlopen(base + name, timeout=120) as response, archive.open('wb') as target:
        while chunk := response.read(1024 * 1024): target.write(chunk)
    assert hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() == digest, 'Node checksum mismatch'
    with tarfile.open(archive) as source: source.extractall(path=temporary, filter='data')
    extracted = pathlib.Path(temporary) / name.removesuffix('.tar.xz')
    extracted.rename(root / 'node')
PY
fi
require_typescript_runtime "$HOME/dant/runtime/node/bin/node"
export PATH="$HOME/dant/runtime/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:$PATH"
node --version
cd "$source_dir"
prepare_transcription() {
  if ! bash vm/install-transcription.sh; then
    echo 'Local audio recognition is unavailable; existing chat and calls remain available.' >&2
  fi
}
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
    def snapshot():
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
        if not isinstance(state.get('worker'), dict) or state['worker'].get('status') != 'online':
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
    state = snapshot()
    if manual:
        if state['takeover'] or unresolved(state):
            reject('work-unconfirmed')
        call_id = state['call'].get('id') if state['call'] else None
        if state['call'] and (not isinstance(call_id, str) or not call_id or len(call_id) > 256):
            reject('call-owner-invalid')
        stage = 'pause'
        confirmed('/api/tasks/pause', {}, 'pause-unconfirmed')
        stage = 'post-pause'
        state = snapshot()
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
        state = snapshot()
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
if [ -f "$HOME/dant/deployed-source.json" ] && \
  cmp -s deploy-manifest.json "$HOME/dant/deployed-source.json" && \
  systemctl --user is-active --quiet dant-worker.service dant-guest-local.service; then
  prepare_transcription
  node vm/migrate-state.mjs "$source_dir/migration" "$HOME/dant/data"
  echo 'DANT_UPDATE_CURRENT'
  echo 'The current VM worker is already deployed; running work was preserved.'
  exit 0
fi
if [ -e "$HOME/dant/app" ] && [ ! -L "$HOME/dant/app" ]; then
  echo 'An existing non-symlink app directory was preserved; deployment requires manual review.' >&2
  exit 1
fi
if ! "$update_running_work"; then check_idle_worker; fi
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
bash vm/install-speech.sh
prepare_transcription
# Dependency downloads leave the old worker running. Check again immediately
# before changing the live app or restarting services, preserving newly begun work.
if "$update_running_work"; then check_idle_worker pause; else check_idle_worker final; fi

# Only an untouched VM data directory can import a host archive. The original
# Windows files are backed up before upload and are never removed by migration.
node vm/migrate-state.mjs "$source_dir/migration" "$HOME/dant/data"

# Preserve the old executable files/configuration separately from authoritative
# data. A failed new service restores these files, never old chat/task records.
rollback_dir=$(mktemp -d "$source_dir/rollback.XXXXXX")
old_app=''
if [ -L "$HOME/dant/app" ]; then old_app=$(readlink "$HOME/dant/app"); fi
worker_was_active=false
initial_worker_state=$(worker_service_state)
if [ "$initial_worker_state" = active ]; then worker_was_active=true; fi
worker_stopped=false
app_switched=false
deployment_committed=false
vm_files=(guest.py desktop.py control.py voice_message.py transcribe_audio.py desktop_mcp.py)
service_files=(dant-guest-local.service dant-worker.service)
mkdir "$rollback_dir/vm" "$rollback_dir/services"
for name in "${vm_files[@]}"; do if [ -f "$HOME/dant/vm/$name" ]; then cp -p "$HOME/dant/vm/$name" "$rollback_dir/vm/$name"; fi; done
for name in "${service_files[@]}"; do if [ -f "$HOME/.config/systemd/user/$name" ]; then cp -p "$HOME/.config/systemd/user/$name" "$rollback_dir/services/$name"; fi; done
rollback_update() {
  update_status=$?
  trap - EXIT
  if ! "$deployment_committed" && { "$app_switched" || "$worker_stopped"; }; then
    set +e
    if "$app_switched"; then
      if ! check_idle_worker idle; then
        echo 'The VM update failed, but the new service could not confirm a safe rollback. Service files and saved work were left in place; no executor was forcibly stopped.' >&2
        exit "$update_status"
      fi
      if ! systemctl --user stop dant-worker.service; then
        echo 'The VM update failed and service shutdown was not confirmed. Saved work and service files were left in place.' >&2
        exit "$update_status"
      fi
      rollback_restored=true
      if [ -n "$old_app" ]; then
        if ! ln -s "$old_app" "$rollback_dir/app.restore" || ! mv -Tf "$rollback_dir/app.restore" "$HOME/dant/app"; then rollback_restored=false; fi
      elif ! rm -f "$HOME/dant/app"; then rollback_restored=false
      fi
      for name in "${vm_files[@]}"; do
        if [ -f "$rollback_dir/vm/$name" ]; then cp -p "$rollback_dir/vm/$name" "$HOME/dant/vm/$name" || rollback_restored=false; else rm -f "$HOME/dant/vm/$name" || rollback_restored=false; fi
      done
      for name in "${service_files[@]}"; do
        if [ -f "$rollback_dir/services/$name" ]; then cp -p "$rollback_dir/services/$name" "$HOME/.config/systemd/user/$name" || rollback_restored=false; else rm -f "$HOME/.config/systemd/user/$name" || rollback_restored=false; fi
      done
      if ! "$rollback_restored" || ! systemctl --user daemon-reload; then
        echo 'The VM update failed and previous service files could not be fully restored. The worker remains stopped; saved data was preserved.' >&2
        exit "$update_status"
      fi
    fi
    if "$worker_was_active" && { ! systemctl --user restart dant-guest-local.service || ! systemctl --user start dant-worker.service; }; then
      echo 'The VM update failed. Previous service files were restored, but restarting the old service was not confirmed. Saved data was preserved.' >&2
      exit "$update_status"
    fi
    echo 'The VM update failed. The previous service files were restored; saved tasks remain paused.' >&2
  fi
  exit "$update_status"
}
trap rollback_update EXIT
# Recheck after migration/backups and stop the confirmed idle old service before
# replacing its app. No unconfirmed running executor is forcibly terminated.
check_idle_worker final
if [ "$worker_checked_state" = active ] || [ "$worker_checked_state" = failed ] || [ -f "$HOME/.config/systemd/user/dant-worker.service" ]; then
  systemctl --user stop dant-worker.service
  worker_stopped=true
fi
ln -s "$source_dir" "$rollback_dir/app.next"
mv -Tf "$rollback_dir/app.next" "$HOME/dant/app"
app_switched=true
install -m 700 "$source_dir/vm/guest.py" "$source_dir/vm/desktop.py" "$source_dir/vm/control.py" "$source_dir/vm/voice_message.py" "$source_dir/vm/transcribe_audio.py" "$source_dir/vm/desktop_mcp.py" "$HOME/dant/vm/"
cat > "$HOME/.config/systemd/user/dant-guest-local.service" <<EOF
[Unit]
Description=dant local desktop bridge with shared control lease

[Service]
Type=simple
WorkingDirectory=%h/dant/vm
ExecStart=/usr/bin/python3 %h/dant/vm/guest.py
Environment=DISPLAY=:0
Environment=DANT_GUEST_HOST=$guest_host
Environment=DANT_GUEST_PORT=$guest_port
Environment=DANT_CONTROL_FILE=%h/dant/data/computer-control.json
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
EOF
cat > "$HOME/.config/systemd/user/dant-worker.service" <<EOF
[Unit]
Description=dant authoritative VM worker
After=default.target dant-guest-local.service
Requires=dant-guest-local.service

[Service]
Type=simple
WorkingDirectory=%h/dant/app
ExecStart=%h/dant/runtime/node/bin/node src/server.mjs --vm-worker
Environment=DANT_DATA=%h/dant/data
Environment=DANT_WORKSPACE_ROOT=%h/dant/workspaces
Environment=DISPLAY=:0
Environment=CODEX_HOME=%h/.dant-codex
Environment=DANT_CONTROL_FILE=%h/dant/data/computer-control.json
Environment=DANT_PORT=$worker_port
Environment=DANT_GUEST_HOST=$guest_host
Environment=DANT_GUEST_PORT=$guest_port
Environment=PATH=%h/dant/runtime/node/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
EOF
loginctl enable-linger "$(id -un)" || true
if [ "$(loginctl show-user "$(id -un)" -p Linger --value)" != yes ]; then
  echo 'User lingering is disabled. Enable it during VM setup before claiming unattended work is available.' >&2
  exit 1
fi
systemctl --user daemon-reload
systemctl --user enable dant-guest-local.service dant-worker.service
systemctl --user restart dant-guest-local.service
systemctl --user restart dant-worker.service
for attempt in $(seq 1 60); do
  if python3 -c 'import json,urllib.request; r=json.load(urllib.request.urlopen("http://127.0.0.1:4317/api/session",timeout=2)); assert r.get("token")' 2>/dev/null; then
    install -m 600 "$source_dir/deploy-manifest.json" "$rollback_dir/deploy-manifest.next"
    mv -f "$rollback_dir/deploy-manifest.next" "$HOME/dant/deployed-source.json"
    deployment_committed=true
    echo 'DANT_UPDATE_DEPLOYED'
    echo 'dant authoritative VM service is ready on 127.0.0.1:4317'
    exit 0
  fi
  sleep 1
done
echo 'The VM service did not become ready. Existing data and Codex authentication were preserved.' >&2
exit 1
