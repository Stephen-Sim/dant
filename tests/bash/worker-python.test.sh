#!/bin/bash

worker_python() {
    case "$1" in
        "$DANT_BASH_WORKER_OPERATOR/vm/worker-update-guard.py")
            [ "$#" -eq 2 ] || return 1
            case "$2" in check|final|pause) ;; *) return 1 ;; esac
            printf 'guard:%s\n' "$2" >> "$DANT_BASH_RECORD"
            [ "$DANT_BASH_CASE" != guard-fail ]
            ;;
        "$DANT_BASH_WORKER_OPERATOR/vm/worker-install.py"|"$DANT_BASH_WORKER_SOURCE/vm/worker-install.py")
            [ "$#" -ge 2 ] || return 1
            case "$2" in
                verify|current)
                    [ "$#" -eq 4 ] && [ "$3" = "$DANT_BASH_WORKER_SOURCE" ] && [ "$4" = "$HOME" ] || return 1
                    printf '%s\n' "$2" >> "$DANT_BASH_RECORD"
                    if [ "$2" = verify ]; then
                        [ "$DANT_BASH_CASE" != verify-fail ] || return 1
                        printf '127.0.0.1\t4321\t4317\t0.0.0-fixture\tfixture-source\n'
                    else
                        [ "$DANT_BASH_CASE" != current-invalid ]
                    fi
                    ;;
                activate)
                    [ "$#" -eq 4 ] || { [ "$#" -eq 5 ] && [ "$5" = --update-running-work ]; }
                    [ "$3" = "$DANT_BASH_WORKER_SOURCE" ] && [ "$4" = "$HOME" ] || return 1
                    printf 'activate\n' >> "$DANT_BASH_RECORD"
                    printf '%s\n' "$@" > "$HOME/activation-arguments"
                    [ "$DANT_BASH_CASE" != activate-fail ]
                    ;;
                reconcile-stopped)
                    [ "$#" -eq 8 ] && [ "$3" = "$DANT_BASH_WORKER_SOURCE" ] && [ "$4" = "$HOME" ] || return 1
                    [ "$5" = --attempt-id ] && [ "$6" = fixture-attempt ] || return 1
                    [ "$7" = --journal-sha256 ] && [ "$8" = fixture-sha ] || return 1
                    printf 'reconcile-stopped\n' >> "$DANT_BASH_RECORD"
                    printf '%s\n' "$@" > "$HOME/reconciliation-arguments"
                    [ "$DANT_BASH_CASE" != reconcile-fail ]
                    ;;
                *) return 1 ;;
            esac
            ;;
        *) echo 'Unexpected synthetic worker Python boundary' >&2; return 1 ;;
    esac
}
