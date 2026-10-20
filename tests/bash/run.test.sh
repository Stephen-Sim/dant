#!/bin/bash
set -euo pipefail
case "${1:-}" in ''|--debug-trace) ;; *) exit 1 ;; esac
test "$#" -le 1
temporary_base=$(realpath /tmp)
fixture=$(mktemp -d "$temporary_base/dant-bash-coverage-XXXXXXXX")
case "$fixture" in "$temporary_base"/dant-bash-coverage-????????) ;; *) exit 1 ;; esac
cleanup() {
    local target
    target=$(realpath "$fixture")
    case "$target" in "$temporary_base"/dant-bash-coverage-????????) ;; *) return 1 ;; esac
    test "$target" = "$fixture" || return 1
    rm -rf -- "$target"
}
trap cleanup EXIT
export DANT_BASH_FIXTURE_ROOT="$fixture"
export DANT_BASH_REPOSITORY="$PWD"
if [ "${1:-}" = --debug-trace ]; then
    # Reproduce the pinned kcov DEBUG helper's inheritance contract, without
    # claiming that this portable behavior check is kcov instrumentation.
    trace="$fixture/debug-trace"
    exec 9>"$trace"
    set -o functrace
    trap 'printf "kcov@%s@%s@\n" "${BASH_SOURCE[0]}" "$LINENO" >&9' DEBUG
    unset BASH_ENV
    source tests/bash/runtime.test.sh
    trap - DEBUG
    set +o functrace
    exec 9>&-
    for script in "$DANT_BASH_REPOSITORY"/vm/*.sh; do
        hits=$(grep -Fc "kcov@$script@" "$trace" || true)
        test "$hits" -gt 0 || { echo 'A production Bash source emitted no DEBUG events' >&2; exit 1; }
        printf 'TRACE_SOURCE\t%s\t%s\n' "${script##*/}" "$hits"
    done
else
    bash tests/bash/runtime.test.sh
fi
