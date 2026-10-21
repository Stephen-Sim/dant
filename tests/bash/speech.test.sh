#!/bin/bash
set -euo pipefail

create_speech_runtime() {
    mkdir -p "$HOME/dant/runtime/speech/usr/bin"
    printf '{"fixture":true}\n' > "$HOME/dant/runtime/speech/deployment.json"
    cat > "$HOME/dant/runtime/speech/usr/bin/espeak-ng" <<'SH'
#!/bin/sh
set -eu
printf 'speech-version\n' >> "$DANT_BASH_RECORD"
printf '%s\n' "$LD_LIBRARY_PATH" "$@" > "$HOME/speech-arguments"
[ "${DANT_BASH_CASE:-}" != speech-version-fail ]
SH
    command chmod 700 "$HOME/dant/runtime/speech/usr/bin/espeak-ng"
}

run_speech() (
    export HOME="$fixture/speech-$1/home"
    export DANT_BASH_CASE=$1
    mkdir -p "$HOME"
    # Discovery is controlled as a system boundary. The runner's installed
    # audio utilities cannot change the selected fixture or open a device.
    command() {
        if [ "${1:-}" != -v ]; then builtin command "$@"; return; fi
        [ "$#" -eq 2 ] || return 1
        case "$2:$DANT_BASH_CASE" in
            espeak-ng:external) printf '/fixture/system/espeak-ng\n' ;;
            espeak:fallback) printf '/fixture/system/espeak\n' ;;
            espeak-ng:private) printf '%s/.local/bin/espeak-ng\n' "$HOME" ;;
            espeak-ng:*|espeak:*) return 1 ;;
            *) echo 'Unexpected synthetic speech discovery' >&2; return 1 ;;
        esac
    }
    if [ "$DANT_BASH_CASE" = deployment-existing ]; then create_speech_runtime; fi
    export LD_LIBRARY_PATH=/fixture/previous-libraries
    run_source "$root/vm/install-speech.sh"
)

for speech_case in external fallback; do
    export DANT_BASH_RECORD="$fixture/speech-$speech_case.actions"
    : > "$DANT_BASH_RECORD"
    run_speech "$speech_case" > "$fixture/speech-$speech_case.txt"
    has_text 'already available' "$fixture/speech-$speech_case.txt"
    ! has_line 'speech-install' "$DANT_BASH_RECORD"
    ! has_line 'speech-version' "$DANT_BASH_RECORD"
done

for speech_case in install private deployment-existing; do
    export DANT_BASH_RECORD="$fixture/speech-$speech_case.actions"
    : > "$DANT_BASH_RECORD"
    run_speech "$speech_case" > "$fixture/speech-$speech_case.txt"
    has_line 'speech-version' "$DANT_BASH_RECORD"
    has_line "$fixture/speech-$speech_case/home/dant/runtime/speech/usr/lib/x86_64-linux-gnu:/fixture/previous-libraries" \
        "$fixture/speech-$speech_case/home/speech-arguments"
    has_line --version "$fixture/speech-$speech_case/home/speech-arguments"
    if [ "$speech_case" = deployment-existing ]; then
        ! has_line 'speech-install' "$DANT_BASH_RECORD"
    else
        has_line 'speech-install' "$DANT_BASH_RECORD"
    fi
    has_line 'private-speech-mode:700' "$DANT_BASH_RECORD"
    test -x "$fixture/speech-$speech_case/home/.local/bin/espeak-ng"
done

for speech_case in speech-install-fail speech-version-fail; do
    export DANT_BASH_RECORD="$fixture/speech-$speech_case.actions"
    : > "$DANT_BASH_RECORD"
    expect_failure 'Speech setup acknowledged a failed dependency' run_speech "$speech_case" \
        > "$fixture/speech-$speech_case.txt" 2>&1
    ! has_text 'Pinned Ubuntu speech package' "$fixture/speech-$speech_case.txt"
    if [ "$speech_case" = speech-install-fail ]; then
        ! has_line 'speech-version' "$DANT_BASH_RECORD"
        test ! -e "$fixture/speech-$speech_case/home/.local/bin/espeak-ng"
    fi
done

export HOME="$fixture/home"
export DANT_BASH_RECORD="$fixture/actions"
