#!/bin/bash
set -euo pipefail
umask 077
source_dir=$(realpath "$1")
case "$source_dir" in "$HOME"/dant/releases/source.*) ;; *) echo 'Invalid worker source directory' >&2; exit 1;; esac
test "$(id -u)" -ne 0 || { echo 'Run the worker deployment as its ordinary VM user.' >&2; exit 1; }
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
export PATH="$HOME/dant/runtime/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:$PATH"
node --version
cd "$source_dir"
prepare_transcription() {
  if ! bash vm/install-transcription.sh; then
    echo 'Local audio recognition is unavailable; existing chat and calls remain available.' >&2
  fi
}
check_idle_worker() {
if systemctl --user is-active --quiet dant-worker.service; then
  python3 - <<'PY'
import json, sys, urllib.request
base = 'http://127.0.0.1:4317'
session = json.load(urllib.request.urlopen(base + '/api/session', timeout=3))
state = json.load(urllib.request.urlopen(urllib.request.Request(base + '/api/state', headers={'X-Dant-Token': session['token']}), timeout=3))
if state.get('active') or state.get('call') or state.get('queue') or state.get('takeover'):
    print('DANT_WORK_ACTIVE: service update deferred; current VM work was preserved', file=sys.stderr)
    sys.exit(79)
PY
fi
}
if [ -f "$HOME/dant/deployed-source.json" ] && \
  cmp -s deploy-manifest.json "$HOME/dant/deployed-source.json" && \
  systemctl --user is-active --quiet dant-worker.service dant-guest-local.service; then
  prepare_transcription
  node vm/migrate-state.mjs "$source_dir/migration" "$HOME/dant/data"
  echo 'The current VM worker is already deployed; running work was preserved.'
  exit 0
fi
check_idle_worker
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
bash vm/install-speech.sh
prepare_transcription
# Dependency downloads leave the old worker running. Check again immediately
# before changing the live app or restarting services, preserving newly begun work.
check_idle_worker

# Only an untouched VM data directory can import a host archive. The original
# Windows files are backed up before upload and are never removed by migration.
node vm/migrate-state.mjs "$source_dir/migration" "$HOME/dant/data"

if [ -e "$HOME/dant/app" ] && [ ! -L "$HOME/dant/app" ]; then
  echo 'An existing non-symlink app directory was preserved; deployment requires manual review.' >&2
  exit 1
fi
ln -sfn "$source_dir" "$HOME/dant/app"
install -m 700 "$source_dir/vm/guest.py" "$source_dir/vm/desktop.py" "$source_dir/vm/control.py" "$source_dir/vm/voice_message.py" "$source_dir/vm/transcribe_audio.py" "$source_dir/vm/desktop_mcp.py" "$HOME/dant/vm/"
cat > "$HOME/.config/systemd/user/dant-guest-local.service" <<EOF
[Unit]
Description=dant local desktop bridge with shared control lease

[Service]
Type=simple
WorkingDirectory=%h/dant/vm
ExecStart=/usr/bin/python3 %h/dant/vm/guest.py
Environment=DISPLAY=:0
Environment=DANT_GUEST_PORT=4320
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
    install -m 600 "$source_dir/deploy-manifest.json" "$HOME/dant/deployed-source.json"
    echo 'dant authoritative VM service is ready on 127.0.0.1:4317'
    exit 0
  fi
  sleep 1
done
echo 'The VM service did not become ready. Existing data and Codex authentication were preserved.' >&2
exit 1
