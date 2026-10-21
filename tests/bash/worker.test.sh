#!/bin/bash
set -euo pipefail
mkdir -p "$fixture/bin" "$fixture/foreign-source"
source "$root/tests/bash/worker-python.test.sh"
case "$(uname -s)" in
    Linux) fixture_symlink_attributes=native ;;
    *) fixture_symlink_attributes=synthetic ;;
esac

# exec intentionally crosses a process boundary. Its executable uses the same
# strictly bounded fake Python boundary as the in-process verification calls.
cat > "$fixture/bin/python3" <<'SH'
#!/bin/sh
set -eu
. "$DANT_BASH_REPOSITORY/tests/bash/worker-python.test.sh"
worker_python "$@"
SH
command chmod 700 "$fixture/bin/python3"

run_worker() (
    local worker_case=$1
    shift
    export HOME="$fixture/worker-$worker_case/home"
    export DANT_BASH_CASE=$worker_case
    export DANT_BASH_WORKER_SOURCE="$HOME/dant/releases/source.fixture"
    export DANT_BASH_WORKER_OPERATOR="$HOME/dant/releases/source.operator"
    export PATH="$fixture/bin:$PATH"
    mkdir -p "$DANT_BASH_WORKER_SOURCE/vm" "$DANT_BASH_WORKER_OPERATOR/vm"
    printf 'fixture-manifest\n' > "$DANT_BASH_WORKER_SOURCE/deploy-manifest.json"

    case "$worker_case" in
        current|current-invalid|worker-inactive|guest-inactive)
            printf 'fixture-manifest\n' > "$HOME/dant/deployed-source.json" ;;
        manifest-different)
            printf 'previous-fixture-manifest\n' > "$HOME/dant/deployed-source.json" ;;
        app-directory) mkdir "$HOME/dant/app" ;;
        app-symlink)
            if [ "$fixture_symlink_attributes" = native ]; then
                ln -s "$DANT_BASH_WORKER_OPERATOR" "$HOME/dant/app"
            else
                : > "$HOME/dant/app"
            fi
            ;;
    esac
    # The operator's canonical release location is a fake filesystem boundary.
    # Source the original file so kcov still measures production code, rather
    # than a test copy of its implementation or a symlink's fixture filename.
    realpath() {
        [ "$#" -eq 1 ] || return 1
        case "$1" in
            "$root/vm/..")
                if [ "$worker_case" = operator-invalid ]; then
                    printf '%s\n' "$fixture/foreign-source"
                else
                    printf '%s\n' "$DANT_BASH_WORKER_OPERATOR"
                fi
                ;;
            "$DANT_BASH_WORKER_SOURCE"|"$fixture/foreign-source") printf '%s\n' "$1" ;;
            *) echo 'Unexpected synthetic worker path boundary' >&2; return 1 ;;
        esac
    }
    id() {
        [ "$#" -eq 1 ] && [ "$1" = -u ] || return 1
        if [ "$worker_case" = root-user ]; then printf '0\n'; else printf '1000\n'; fi
    }
    function [() {
        # Windows Git Bash does not guarantee native symlink creation. Supply
        # only this fixture's symlink attribute at the filesystem boundary;
        # every other test retains Bash's original predicate and real files.
        case "$#:${1:-}:${2:-}:${3:-}:${4:-}:$worker_case:$fixture_symlink_attributes" in
            "4:!:-L:$HOME/dant/app:]:app-symlink:synthetic") return 1 ;;
        esac
        builtin [ "$@"
    }
    systemctl() {
        case "$*" in
            '--user show dant-worker.service --property=ActiveState --value')
                printf 'service-state\n' >> "$DANT_BASH_RECORD"
                case "$worker_case" in
                    service-error) return 1 ;;
                    service-changing) printf 'activating\n' ;;
                    inactive) printf 'inactive\n' ;;
                    failed) printf 'failed\n' ;;
                    *) printf 'active\n' ;;
                esac
                ;;
            '--user is-active --quiet dant-worker.service') [ "$worker_case" != worker-inactive ] ;;
            '--user is-active --quiet dant-guest-local.service') [ "$worker_case" != guest-inactive ] ;;
            *) echo 'Unexpected synthetic worker service boundary' >&2; return 1 ;;
        esac
    }
    bash() {
        [ "$#" -eq 1 ] || return 1
        case "$1" in
            vm/install-speech.sh)
                printf 'speech\n' >> "$DANT_BASH_RECORD"
                [ "$worker_case" != speech-required-fail ]
                ;;
            vm/install-transcription.sh)
                printf 'transcription\n' >> "$DANT_BASH_RECORD"
                [ "$worker_case" != transcription-optional-fail ] ;;
            *) echo 'Unexpected synthetic worker Bash boundary' >&2; return 1 ;;
        esac
    }
    if [ "$worker_case" = source-invalid ]; then
        run_source "$root/vm/install-worker.sh" "$fixture/foreign-source" "$@"
    else
        run_source "$root/vm/install-worker.sh" "$DANT_BASH_WORKER_SOURCE" "$@"
    fi
)

worker_success() {
    local worker_case=$1
    shift
    export DANT_BASH_RECORD="$fixture/worker-$worker_case.actions"
    : > "$DANT_BASH_RECORD"
    run_worker "$worker_case" "$@" > "$fixture/worker-$worker_case.txt" 2>&1
}
worker_failure() {
    local worker_case=$1
    shift
    export DANT_BASH_RECORD="$fixture/worker-$worker_case.actions"
    : > "$DANT_BASH_RECORD"
    expect_failure 'Worker acknowledged an invalid or failed operation' run_worker "$worker_case" "$@" \
        > "$fixture/worker-$worker_case.txt" 2>&1
    ! has_line 'activate' "$DANT_BASH_RECORD"
    ! has_line 'reconcile-stopped' "$DANT_BASH_RECORD"
}

worker_failure source-invalid
has_text 'Invalid worker source directory' "$fixture/worker-source-invalid.txt"
worker_failure operator-invalid
has_text 'Invalid worker operator directory' "$fixture/worker-operator-invalid.txt"
worker_failure root-user
! has_line 'verify' "$DANT_BASH_RECORD"
worker_failure unknown-option --unknown
worker_failure duplicate-update --update-running-work --update-running-work
worker_failure duplicate-guard --guard-only --guard-only
worker_failure reconcile-missing --reconcile-stopped fixture-attempt
worker_failure reconcile-duplicate --reconcile-stopped fixture-attempt fixture-sha --reconcile-stopped fixture-attempt fixture-sha
worker_failure reconcile-guard --reconcile-stopped fixture-attempt fixture-sha --guard-only
worker_failure reconcile-update --reconcile-stopped fixture-attempt fixture-sha --update-running-work
worker_failure verify-fail
! has_line 'service-state' "$DANT_BASH_RECORD"
worker_failure app-directory
! has_line 'speech' "$DANT_BASH_RECORD"
worker_failure speech-required-fail
! has_line 'transcription' "$DANT_BASH_RECORD"

worker_success guard-final --guard-only
has_line 'guard:final' "$DANT_BASH_RECORD"
! has_line 'speech' "$DANT_BASH_RECORD"
worker_success guard-pause --guard-only --update-running-work
has_line 'guard:pause' "$DANT_BASH_RECORD"
worker_success inactive --guard-only
! has_text 'guard:' "$DANT_BASH_RECORD"
worker_success failed --guard-only
! has_text 'guard:' "$DANT_BASH_RECORD"
for worker_case in service-error service-changing guard-fail; do
    worker_failure "$worker_case" --guard-only
    ! has_line 'speech' "$DANT_BASH_RECORD"
done

worker_success current
has_line 'DANT_UPDATE_CURRENT' "$fixture/worker-current.txt"
has_line 'current' "$DANT_BASH_RECORD"
! has_line 'speech' "$DANT_BASH_RECORD"
! has_line 'activate' "$DANT_BASH_RECORD"

for worker_case in activate manifest-different current-invalid worker-inactive guest-inactive app-symlink transcription-optional-fail; do
    worker_success "$worker_case"
    has_line 'guard:check' "$DANT_BASH_RECORD"
    has_line 'speech' "$DANT_BASH_RECORD"
    has_line 'transcription' "$DANT_BASH_RECORD"
    has_line 'activate' "$DANT_BASH_RECORD"
    ! has_text 'DANT_UPDATE_CURRENT' "$fixture/worker-$worker_case.txt"
done
has_text 'Local audio recognition is unavailable' "$fixture/worker-transcription-optional-fail.txt"
worker_success update-running --update-running-work
! has_text 'guard:' "$DANT_BASH_RECORD"
has_line --update-running-work "$fixture/worker-update-running/home/activation-arguments"
worker_success reconcile --reconcile-stopped fixture-attempt fixture-sha
has_line 'reconcile-stopped' "$DANT_BASH_RECORD"
! has_text 'guard:' "$DANT_BASH_RECORD"
! has_line 'speech' "$DANT_BASH_RECORD"
! has_line 'activate' "$DANT_BASH_RECORD"

for worker_case in activate-fail reconcile-fail; do
    export DANT_BASH_RECORD="$fixture/worker-$worker_case.actions"
    : > "$DANT_BASH_RECORD"
    worker_arguments=()
    worker_action=activate
    if [ "$worker_case" = reconcile-fail ]; then
        worker_arguments=(--reconcile-stopped fixture-attempt fixture-sha)
        worker_action=reconcile-stopped
    fi
    expect_failure 'Worker retried or acknowledged a failed activation helper' \
        run_worker "$worker_case" "${worker_arguments[@]}" > "$fixture/worker-$worker_case.txt" 2>&1
    action_count=0
    while IFS= read -r action; do
        if [ "$action" = "$worker_action" ]; then action_count=$((action_count + 1)); fi
    done < "$DANT_BASH_RECORD"
    test "$action_count" -eq 1
done

export HOME="$fixture/home"
export DANT_BASH_RECORD="$fixture/actions"
