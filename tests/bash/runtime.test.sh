#!/bin/bash
set -euo pipefail
root=${DANT_BASH_REPOSITORY:?Fixture repository is required}
fixture=${DANT_BASH_FIXTURE_ROOT:?Fixture root is required}
case "$fixture" in /tmp/dant-bash-coverage-*) ;; *) echo 'Invalid isolated Bash fixture root' >&2; exit 1 ;; esac
export HOME="$fixture/home"
mkdir -p "$HOME/.local/bin" "$HOME/work"
export DANT_BASH_RECORD="$fixture/actions"
: > "$DANT_BASH_RECORD"

# Only these fake system boundaries are visible to the production script.
# No fake delegates to a hypervisor, package manager, device, elevation or model.
apt-get() { printf 'apt\n' >> "$DANT_BASH_RECORD"; [ "${DANT_BASH_CASE:-}" != packages-fail ]; }
npm() { printf 'npm\n' >> "$DANT_BASH_RECORD"; }
install() { printf 'install\n' >> "$DANT_BASH_RECORD"; }
chmod() { printf 'chmod\n' >> "$DANT_BASH_RECORD"; }
loginctl() { printf 'linger\n' >> "$DANT_BASH_RECORD"; }
chown() { printf 'chown\n' >> "$DANT_BASH_RECORD"; }
touch() { [ "$*" = /home/dant/work/.dant-ready ] || return 1; printf 'ready-marker\n' >> "$DANT_BASH_RECORD"; }
sleep() { printf 'sleep\n' >> "$DANT_BASH_RECORD"; }
tee() { cat; }
systemctl() { printf 'service\n' >> "$DANT_BASH_RECORD"; [ "${DANT_BASH_CASE:-}" != readiness-fail ] || [ "$1" != is-active ]; }
runuser() { printf 'display-check\n' >> "$DANT_BASH_RECORD"; }
python3() {
  printf 'python-check\n' >> "$DANT_BASH_RECORD"
  if [ "${1:-}" = /opt/dant/network_config.py ]; then
    [ "$#" -eq 2 ] && [ "$2" = bootstrap-screen-check ] || return 1
    printf 'bootstrap-bridge-check\n' >> "$DANT_BASH_RECORD"
    [ "${DANT_BASH_CASE:-}" != bridge-fail ]
  else
    [ "${DANT_BASH_CASE:-}" != transcription-fail ]
  fi
}
export -f apt-get npm install chmod loginctl chown touch sleep tee systemctl runuser python3
run_source() {
    bash --noprofile --norc -c 'function /usr/local/bin/codex() { printf "codex-check\n" >> "$DANT_BASH_RECORD"; }; source "$1" "${@:2}"' dant-isolated-fixture "$@"
}

run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-success.txt"
grep -q '^ready-marker$' "$DANT_BASH_RECORD"
grep -q '^bootstrap-bridge-check$' "$DANT_BASH_RECORD"
: > "$DANT_BASH_RECORD"
if DANT_BASH_CASE=bridge-fail run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-bridge-failed.txt"; then echo 'Bootstrap acknowledged a failed bridge check' >&2; exit 1; fi
grep -q '^bootstrap-bridge-check$' "$DANT_BASH_RECORD"
! grep -q '^ready-marker$' "$DANT_BASH_RECORD"
! grep -q '^codex-check$' "$DANT_BASH_RECORD"
: > "$DANT_BASH_RECORD"
if DANT_BASH_CASE=readiness-fail run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-not-ready.txt"; then echo 'Bootstrap acknowledged an unready guest' >&2; exit 1; fi
! grep -q '^ready-marker$' "$DANT_BASH_RECORD"
if DANT_BASH_CASE=packages-fail run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-packages-failed.txt"; then echo 'Bootstrap acknowledged a failed install' >&2; exit 1; fi

cat > "$HOME/.local/bin/codex" <<'SH'
#!/bin/sh
printf '%s\n' "$DISPLAY" "$CODEX_HOME" "$PWD" "$@" > "$DANT_BASH_RECORD"
SH
command chmod 700 "$HOME/.local/bin/codex"
run_source "$root/vm/start-codex.sh"
grep -q '^app-server$' "$DANT_BASH_RECORD"
grep -q '^stdio://$' "$DANT_BASH_RECORD"
grep -Fqx "$HOME/work" "$DANT_BASH_RECORD"

espeak-ng() { printf 'No audio device is opened\n'; }
export -f espeak-ng
run_source "$root/vm/install-speech.sh" > "$fixture/speech-existing.txt"
grep -q 'already available' "$fixture/speech-existing.txt"
run_source "$root/vm/install-transcription.sh" > "$fixture/transcription.txt"
if DANT_BASH_CASE=transcription-fail run_source "$root/vm/install-transcription.sh" > "$fixture/transcription-failed.txt"; then echo 'Recognition setup acknowledged failure' >&2; exit 1; fi

mkdir -p "$fixture/foreign-source"
if run_source "$root/vm/install-worker.sh" "$fixture/foreign-source" > "$fixture/worker-invalid.txt" 2>&1; then echo 'Worker accepted an unowned source directory' >&2; exit 1; fi
grep -q 'Invalid worker source directory' "$fixture/worker-invalid.txt"
printf 'Bash runtime fixtures passed with isolated HOME and fake system boundaries.\n'
