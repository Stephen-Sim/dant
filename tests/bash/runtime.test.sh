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
  elif [ "${1:-}" = "$root/vm/install-transcription.py" ]; then
    [ "$#" -eq 2 ] && [ "$2" = "$root/vm/transcription-requirements.txt" ] || return 1
    [ "${DANT_BASH_CASE:-}" != transcription-fail ]
  else
    echo 'Unexpected synthetic Python boundary' >&2
    return 1
  fi
}
export -f apt-get npm install chmod loginctl chown touch sleep tee systemctl runuser python3
run_source() (
    # kcov's DEBUG helper enables functrace, then unsets BASH_ENV. A new bash
    # would lose that trap; a sourced subshell retains it and isolates exit/exec.
    function /usr/local/bin/codex() { printf 'codex-check\n' >> "$DANT_BASH_RECORD"; }
    BASH_ARGV0=$1
    source "$1" "${@:2}"
)

expect_failure() {
    local message=$1 status
    shift
    # Never invoke run_source from if/!: Bash would suppress errexit throughout
    # the sourced script. Capture its ordinary-command status in the parent.
    set +e
    "$@"
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
        printf '%s\n' "$message" >&2
        return 1
    fi
}

run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-success.txt"
grep -q '^ready-marker$' "$DANT_BASH_RECORD"
grep -q '^bootstrap-bridge-check$' "$DANT_BASH_RECORD"
: > "$DANT_BASH_RECORD"
DANT_BASH_CASE=bridge-fail expect_failure 'Bootstrap acknowledged a failed bridge check' run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-bridge-failed.txt"
grep -q '^bootstrap-bridge-check$' "$DANT_BASH_RECORD"
! grep -q '^ready-marker$' "$DANT_BASH_RECORD"
! grep -q '^codex-check$' "$DANT_BASH_RECORD"
: > "$DANT_BASH_RECORD"
DANT_BASH_CASE=readiness-fail expect_failure 'Bootstrap acknowledged an unready guest' run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-not-ready.txt"
! grep -q '^ready-marker$' "$DANT_BASH_RECORD"
! grep -q '^codex-check$' "$DANT_BASH_RECORD"
: > "$DANT_BASH_RECORD"
DANT_BASH_CASE=packages-fail expect_failure 'Bootstrap acknowledged a failed install' run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-packages-failed.txt"
grep -q '^apt$' "$DANT_BASH_RECORD"
! grep -q '^npm$' "$DANT_BASH_RECORD"
! grep -q '^ready-marker$' "$DANT_BASH_RECORD"
! grep -q '^codex-check$' "$DANT_BASH_RECORD"

cat > "$HOME/.local/bin/codex" <<'SH'
#!/bin/sh
printf '%s\n' "$DISPLAY" "$CODEX_HOME" "$PWD" "$@" > "$DANT_BASH_RECORD"
printf 'fake-codex-only\n' >> "$DANT_BASH_RECORD"
SH
command chmod 700 "$HOME/.local/bin/codex"
run_source "$root/vm/start-codex.sh"
grep -q '^fake-codex-only$' "$DANT_BASH_RECORD"
grep -q '^app-server$' "$DANT_BASH_RECORD"
grep -q '^stdio://$' "$DANT_BASH_RECORD"
grep -Fqx "$HOME/work" "$DANT_BASH_RECORD"

espeak-ng() { printf 'No audio device is opened\n'; }
export -f espeak-ng
run_source "$root/vm/install-speech.sh" > "$fixture/speech-existing.txt"
grep -q 'already available' "$fixture/speech-existing.txt"
run_source "$root/vm/install-transcription.sh" > "$fixture/transcription.txt"
DANT_BASH_CASE=transcription-fail expect_failure 'Recognition setup acknowledged failure' run_source "$root/vm/install-transcription.sh" > "$fixture/transcription-failed.txt"

mkdir -p "$fixture/foreign-source"
expect_failure 'Worker accepted an unowned source directory' run_source "$root/vm/install-worker.sh" "$fixture/foreign-source" > "$fixture/worker-invalid.txt" 2>&1
grep -q 'Invalid worker source directory' "$fixture/worker-invalid.txt"
printf 'Bash runtime fixtures passed with isolated HOME and fake system boundaries.\n'
