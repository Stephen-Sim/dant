# Verification and acceptance

English · [Chinese](zh-CN/verification.md)

Acceptance has three separate layers: source checks, artifact integrity and real-device behavior. A passing unit suite cannot establish that a particular installer, VM update, microphone or external delivery works. Record evidence for the exact source and artifact being accepted; an earlier candidate's result is not a pass for a changed candidate.

## Source checks

Run the complete commands in [testing](testing.md) and [CI](ci.md), using the pinned toolchains and isolated fixtures. Record the source commit, platform, tool versions, command outcomes, coverage counts and any platform-specific exclusions. A missing prerequisite or failed process remains a failure; do not reuse stale reports or lower thresholds.

- Go checks cover every feature package, vet, formatting and the required statement coverage. Linux also runs the race detector.
- Browser/tooling checks cover strict TypeScript, generated contracts, state domains, recursive tests and required UI coverage.
- Rust tests cover native behavior with separate LLVM instrumentation. Python measures lines and branch arcs; PowerShell measures executable commands through Pester. Bash uses the pinned Linux kcov collector with isolated fixtures and an inventory of every maintained shell script; syntax checks and passing fixtures alone do not establish coverage. Missing platform prerequisites must be reported as unavailable. These checks must not operate a real VM.
- Build and version checks validate matching manifests, locked dependencies, clean source provenance and prepared resources.

Record each coverage metric with its source scope, covered/total counts, platform and toolchain. TypeScript percentages do not describe Go, Rust or Python; test totals do not substitute for instrumented coverage. Missing or failed instrumentation remains unavailable, never 100% by inference. Track uncovered maintained files and platform-specific gaps while working toward close to 100%; retain current gates and do not hide unmeasured scripts. Keep CI summaries and downloadable raw reports for the same source.

Keep behavioral evidence separate from layout review. A browser fixture should use the actual renderer and stylesheet with synthetic responses, and verify wide/narrow layouts, keyboard controls and relevant language directions. The recovery view must remain usable when application state is unavailable.

## Candidate artifacts

Before installation, verify that the tag, commit, version and Windows build metadata identify the same candidate. Require its relevant CI jobs to succeed, including Linux race checks. Validate `SHA256SUMS`, asset lengths, metadata and all packaged resource manifests. Published assets must never be replaced.

Keep the portable application's `dant.exe` beside the complete `backend/` directory. Verify the Windows Core, Linux Worker, fixed helper inventory, frontend and source manifests. Installer and portable native payloads can have different PE resources; compare a payload only against the artifact that actually supplies it.

Use an ordinary private staging location. Reject changed files, links, unsafe archive paths, duplicate entries or mismatched bytes. Preserve existing data and backups. No checksum result by itself authorizes stopping a task, changing a VM or publishing a release.

## Desktop acceptance

1. Preserve drafts and use supported protected exit/update controls. Confirm paused execution and the expected VM lifecycle result. Verify the installed native process and its Controller have exited before replacing their files; a silent installer is not a graceful shutdown API.
2. Install the verified candidate through its supported path. Check installed version and expected resource hashes before first launch. Classify retained files separately; do not delete user data or unrelated resources to make validation pass.
3. Launch once. Read the local session without exposing its token; require `product=dant`, `mode=controller`, `runtime=go`, `protocol=1` and the exact candidate version/source.
4. Confirm the actual chat renders, including attachment-only and empty-text records. Compare retained conversation/message/task identities and pause/unknown fences privately, not just record counts.
5. Verify settings, offline recovery, Work progress, read/unread state, file preview/download and tray lifecycle. Test native call overlays and editor preferences without changing unrelated user settings.

## Worker deployment and data recovery

Use the exact configured VM identity and verified SSH host key. Keep automatic deployment paused during an explicit maintenance procedure. Before changing resources or stopping a VM, require the separately authorized backup, offline state and ownership checks. New VM defaults are 4 CPUs, 8 GiB RAM and a 64 GiB disk; existing resource sizes must not be silently reduced.

Before Worker replacement, confirm maintenance admission, stopped service/executor processes, adequate per-filesystem staging space and a complete authenticated backup. Preserve partial archives and original installation journals as evidence; never label a partial archive as a usable backup.

Offline preparation and activation must bind the exact attempt, source, bundle, roots and backup. Verify the committed journal, preparation proof and deployed source, then the live Worker session with `mode=worker`, `runtime=go`, `protocol=1` and exact target version/source. A successful script exit or cached desktop status is insufficient.

Restore checks include conversation identities, verified attachment bytes under the target root, skill contents, SQLite memory/schedules, paused work and retained uncertainty. A restore must not replay unfinished tasks or scheduled deliveries. Supported earlier data formats keep their compatibility validation and backups. See [Go Core](go-core.md) and [backups](backups.md).

For reconnect acceptance, click **Reconnect** once and confirm the fresh Controller and Worker identities, target source, online state and desktop preview. Use a newly authorized verification task that makes no external changes to check execution after reconnection. Keep earlier unknown tasks and outbox records intact; do not resume or resend them as a connectivity test. Record connection recovery and the new task's outcome separately. Only publish after the exact installed candidate and live Worker pass their checks.

## Live features

Live checks require an authorized account and device scope; they are not unit-test side effects.

| Feature                 | Evidence                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Chat and task execution | One admitted execution, retained task identity/context, pause/cancel and meaningful completion or blocker reporting.    |
| Voice                   | Input/output devices, call state, shared text/call context, work continuing after hangup and current-call captions.     |
| Computer                | Fresh screenshots, stable display, owned input/takeover and safe release.                                               |
| Files and Skills        | Correct bytes/names, preview/download without navigation, complete ZIP import/export and configured editor behavior.    |
| Telegram                | Explicit owner pairing, new-message/attachment delivery and receipts; unconfirmed historical deliveries are not resent. |
| Backup and restore      | Complete authenticated archive, independent target validation, byte preservation and no automatic execution on restore. |

## Acceptance record

Report what was executed, on which exact source/artifact/platform, and its actual outcome. Keep source tests, packaged startup and live feature checks in separate fields. Diagnostics contain bounded fixed codes, booleans, counts and durations; tokens, account identifiers, user text, private paths and raw process output do not belong in public reports.

An incomplete live check remains pending even when all source gates pass. Publishing or installing another candidate requires its own artifact identity and acceptance evidence.
