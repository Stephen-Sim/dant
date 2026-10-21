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
  python3 "$operator_dir/vm/worker-update-guard.py" "${1:-check}"
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
