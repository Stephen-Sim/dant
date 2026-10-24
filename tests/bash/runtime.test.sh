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
apt-get() {
    printf 'apt\n' >> "$DANT_BASH_RECORD"
    if [[ " $* " == *' install -y '* ]]; then
        case " $* " in
            *' bubblewrap '*) printf 'conversation-sandbox-package\n' >> "$DANT_BASH_RECORD" ;;
            *) echo 'Conversation namespace package missing' >&2; return 1 ;;
        esac
        case " $* " in
            *' apparmor '*) printf 'conversation-policy-package\n' >> "$DANT_BASH_RECORD" ;;
            *) echo 'Conversation policy parser package missing' >&2; return 1 ;;
        esac
    fi
    [ "${DANT_BASH_CASE:-}" != packages-fail ]
}
npm() { printf 'npm\n' >> "$DANT_BASH_RECORD"; }
install() { printf 'install\n' >> "$DANT_BASH_RECORD"; }
chmod() {
    printf 'chmod\n' >> "$DANT_BASH_RECORD"
    case "$*" in
        "700 $HOME/.local/bin/espeak-ng")
            printf 'private-speech-mode:700\n' >> "$DANT_BASH_RECORD"
            command chmod "$@"
            ;;
        '+x /opt/dant/start-codex.sh /opt/dant/desktop.py') ;;
        *) echo 'Unexpected synthetic chmod boundary' >&2; return 1 ;;
    esac
}
loginctl() { printf 'linger\n' >> "$DANT_BASH_RECORD"; }
chown() { printf 'chown\n' >> "$DANT_BASH_RECORD"; }
touch() { [ "$*" = /home/dant/work/.dant-ready ] || return 1; printf 'ready-marker\n' >> "$DANT_BASH_RECORD"; }
sleep() { printf 'sleep\n' >> "$DANT_BASH_RECORD"; }
tee() { cat; }
systemctl() { printf 'service\n' >> "$DANT_BASH_RECORD"; [ "${DANT_BASH_CASE:-}" != readiness-fail ] || [ "$1" != is-active ]; }
runuser() { printf 'display-check\n' >> "$DANT_BASH_RECORD"; }
python3() {
  printf 'python-check\n' >> "$DANT_BASH_RECORD"
  if [ "${1:-}" = /opt/dant/conversation-namespace.py ]; then
    [ "$#" -eq 4 ] && [ "$2" = --install ] && [ "$3" = --user ] && [ "$4" = dant ] || return 1
    printf 'conversation-namespace-prepare\n' >> "$DANT_BASH_RECORD"
    [ "${DANT_BASH_CASE:-}" != namespace-fail ]
  elif [ "${1:-}" = /opt/dant/network_config.py ]; then
    [ "$#" -eq 2 ] && [ "$2" = bootstrap-screen-check ] || return 1
    printf 'bootstrap-bridge-check\n' >> "$DANT_BASH_RECORD"
    [ "${DANT_BASH_CASE:-}" != bridge-fail ]
  elif [ "${1:-}" = "$root/vm/install-transcription.py" ]; then
    [ "$#" -eq 2 ] && [ "$2" = "$root/vm/transcription-requirements.txt" ] || return 1
    [ "${DANT_BASH_CASE:-}" != transcription-fail ]
  elif [ "${1:-}" = "$root/vm/install-speech.py" ]; then
    [ "$#" -eq 2 ] && [ "$2" = "$HOME/dant/runtime/speech" ] || return 1
    printf 'speech-install\n' >> "$DANT_BASH_RECORD"
    [ "${DANT_BASH_CASE:-}" != speech-install-fail ] || return 1
    create_speech_runtime
  elif [ "${1:-}" = "${DANT_BASH_WORKER_OPERATOR:-}/vm/worker-install.py" ] || \
       [ "${1:-}" = "${DANT_BASH_WORKER_SOURCE:-}/vm/worker-install.py" ] || \
       [ "${1:-}" = "${DANT_BASH_WORKER_OPERATOR:-}/vm/worker-update-guard.py" ]; then
    worker_python "$@"
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

has_line() {
    local contents
    contents=$(< "$2")
    case $'\n'"$contents"$'\n' in *$'\n'"$1"$'\n'*) return 0 ;; *) return 1 ;; esac
}
has_text() {
    local contents
    contents=$(< "$2")
    case "$contents" in *"$1"*) return 0 ;; *) return 1 ;; esac
}

run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-success.txt"
grep -q '^ready-marker$' "$DANT_BASH_RECORD"
grep -q '^bootstrap-bridge-check$' "$DANT_BASH_RECORD"
grep -q '^conversation-sandbox-package$' "$DANT_BASH_RECORD"
grep -q '^conversation-policy-package$' "$DANT_BASH_RECORD"
grep -q '^conversation-namespace-prepare$' "$DANT_BASH_RECORD"
: > "$DANT_BASH_RECORD"
DANT_BASH_CASE=namespace-fail expect_failure 'Bootstrap acknowledged an unavailable conversation namespace' run_source "$root/vm/bootstrap.sh" > "$fixture/bootstrap-namespace-failed.txt"
grep -q '^conversation-namespace-prepare$' "$DANT_BASH_RECORD"
! grep -q '^npm$' "$DANT_BASH_RECORD"
! grep -q '^ready-marker$' "$DANT_BASH_RECORD"
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

source "$root/tests/bash/speech.test.sh"
run_source "$root/vm/install-transcription.sh" > "$fixture/transcription.txt"
DANT_BASH_CASE=transcription-fail expect_failure 'Recognition setup acknowledged failure' run_source "$root/vm/install-transcription.sh" > "$fixture/transcription-failed.txt"

source "$root/tests/bash/worker.test.sh"
printf 'Bash runtime fixtures passed with isolated HOME and fake system boundaries.\n'
