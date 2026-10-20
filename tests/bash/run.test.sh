#!/bin/bash
set -euo pipefail
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
bash tests/bash/runtime.test.sh
