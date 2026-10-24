# Go Core

English · [Chinese](zh-CN/go-core.md)

dant uses **Go Core + Rust Tauri + TypeScript UI**. The Go executable runs as a Windows Controller or a Linux Worker. Rust owns native Windows integration; TypeScript owns browser interaction and development tools. See [system architecture](architecture.md), [runtime support](runtime-support.md) and [testing](testing.md).

Codex App Server owns model reasoning, tool iterations and its persistent conversation. dant's Engine owns execution admission, durable work, acknowledgments, resource ownership and delivery. Memory, schedules and other event sources use that same admission path.

## Ownership

| Package                                                  | Responsibility                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `core/cmd/dant-core`, `core/internal/application`        | Validate process roles, assemble dependencies, acquire ownership and join shutdown.                    |
| `controller`, `computer`, `platform`                     | Host configuration, providers, SSH forwarding, deployment, VM lifecycle and offline views.             |
| `app`, `work`, `runtime`                                 | Authenticated Worker API, single execution admission, task continuity and Codex RPC.                   |
| `store`, `history`                                       | Conversation files, durable task identities, call input, read state and delivery receipts.             |
| `memory`, `schedules`                                    | SQLite memory, revision-aware recall, recurring jobs and dispatch fences.                              |
| `voice`, `telegram`                                      | Calls, media, transcription, captions and paired messaging.                                            |
| `files`, `skills`, `security`, `backups`, `updates`      | Validated file bytes, skills, credentials, protected archives and updates.                             |
| `config`, `contracts`, `i18n`, `settings`, `diagnostics` | Validated configuration, shared wire types, localization, preferences and bounded operational records. |

The Controller never constructs a task Engine or executes agent work on the host. The Worker runs as an ordinary user inside a graphical Linux VM. Provider abstractions support the Windows Hyper-V and VMware workflows; Unix host abstractions alone do not establish a supported macOS/Linux desktop release.

Entrypoints stay small. Narrow interfaces belong to consumers, and blocking operations receive `context.Context` first. Each feature owns its fixed queries, transactions and validated row mapping. Goroutines have explicit owners, limits, cancellation and joined shutdown.

## Contracts and authority

`resources/contracts/state-domains.json` generates Go states and TypeScript state domains. Protocol defaults live in `resources/config/`; language resources live in `resources/i18n/`. `npm run check:contracts` rejects generated drift. Decoders validate consumed fields and distinguish absence, explicit null and zero. Shared text boundaries specify Unicode normalization, trimming and UTF-16 limits explicitly.

The application API uses loopback port `4317`, session tokens and validated host/origin headers. SSH provides the authenticated host-to-VM tunnel. The Worker's desktop bridge defaults to loopback port `4321`. Changing language, reading memory or receiving a timer event cannot grant execution permission.

Codex event delivery uses bounded observer queues owned by the RPC connection. Unsent, adjacent agent text deltas with identical ownership and metadata may combine using their original UTF-16 code units. Requests and lifecycle events remain ordered barriers. One joined dispatcher delivers immutable events while the reader continues resolving RPC responses; slow history persistence cannot block that reader. The original 64-event capacity remains, with an additional aggregate payload budget. Shutdown flushes already admitted events without requiring the consumer to remain running.

| Durable authority            | Contract                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `state.json`                 | Messages, durable work, submission/continuation receipts, timestamps and supported saved fields. |
| `memory/dant/memory.sqlite`  | Notes, project context, structured entries, revision triggers and FTS5.                          |
| `schedules/schedules.sqlite` | Jobs, creation-request tombstones, occurrence claims and dispatch receipts.                      |
| Files and Skills             | Stable attachment IDs, verified bytes and complete skill directories.                            |
| Credentials and backups      | Private storage, protected envelopes and authenticated recovery archives.                        |

SQLite uses pinned pure-Go `modernc.org/sqlite`, bounded busy waits, `synchronous=FULL` and DELETE journaling. Schema or journal changes require an explicit compatibility and recovery policy. Supported earlier data formats are validated and backed up before import; identities and available timestamps are preserved, and missing values are not invented.

Message and attachment persistence preserves the difference between omitted fields, explicit null, empty arrays, empty strings and false. Typed field edits still replace the saved value. The public chat projection supplies its required text field separately, so displaying a supported older record does not change that record on disk. Repeated open, update and save cycles are covered by behavioral tests.

Memory checks the durable revision before reusing its bounded cache. Recall scopes candidates before ranking and limits, checks confirmed status and source, redacts references and enforces input budgets. It supplies context to admitted work; it cannot start or authorize work.

Scheduler claims and JSON messages are separate durable writes. A fixed message identity is materialized before the no-replay handoff receipt. Missing acknowledgments retain uncertainty. Restart and restore keep unfinished work paused or unknown until the owning operation is reconciled.

## Installation and recovery

1. Verify the target version, source commit, fixed bundle paths, lengths and SHA-256 hashes.
2. Acquire the installation lock and durable attempt identity. Check the actual filesystems for capture, archive, validation and preparation headroom before stopping the service.
3. Reserve maintenance, pause admission and confirm the service and owned executor processes have stopped. An unconfirmed stop blocks installation.
4. Capture a complete private recovery archive and authenticate it before offline `prepare-worker` opens or updates existing data. Preparation starts no model, schedule or Telegram delivery.
5. Bind successful preparation to the exact attempt, source, bundle, data/workspace roots and backup. Activate only that Worker, then confirm its live role, protocol, version and source before marking deployment current.

Desktop bridge checks confirm service, process and listening-socket ownership. When `systemctl show` omits an empty `EnvironmentFiles` array, the observer resolves the unit through systemd's D-Bus manager and requires a successful typed empty-array response. Missing, unreadable, malformed or nonempty properties do not become an empty configuration. These read-only queries require no service restart or administrator approval.

The Worker service passes the verified ordinary release directory through `--config-root`. Its `--root` remains the managed `app` link so activation checks still confirm the deployed target. Configuration loading never follows that link as an exception to ordinary-directory checks, and generated paths use the actual verified release name and the service user's home.

`install-attempt.json` also guards independent service starts and reboots. `reserving`, `stopping` and `preparing` cannot open live services. `activating` requires the matching `worker-preparation.json` and unchanged recovery archive. `committed` retains the preparation proof while allowing normal backup retention. The managed `app` link must resolve to the verified release directory. A malformed or partial journal never becomes a fresh-install exception.

Failed or uncertain operations retain their journals and archives. They do not authorize replay or starting another executor against prepared data. The explicit `reconcile-stopped` operator path accepts only eligible pre-preparation attempts with the exact attempt ID, original journal hash, verified source manifests, stopped-process proof and installation lock. It preserves the original evidence before creating a new attempt; automatic connection checks never invoke it.

Restore authenticates its archive and target first, pauses unfinished work and schedules, disables Telegram delivery and retains unknown outcomes. See [backups](backups.md) and [updates](updates.md).

### Early export format

`--role=legacy-import --source-dir <absolute-export> --data-dir <absolute-empty-target>` imports the supported early `manifest.json`, `state.json` and `files/<id>` format. It is separate from portable-backup restore and starts no service, model or scheduler.

The target must be empty and exclusively owned. The importer preserves source evidence, maps available attachments once, clears active host connection credentials and keeps unfinished work paused. Missing identities and timestamps are not fabricated. A durable intent precedes publication; only unchanged authenticated completed output is idempotent. Partial or changed output requires reconciliation.

This format permits at most 10 MiB per file, 1,000 unique files, 512 MiB total attachment bytes, 128 MiB state and a 64 KiB manifest. These limits apply to that import role, not current VM backups.

## Build and verification

Go **1.27.2** is pinned in tooling and CI with `GOTOOLCHAIN=local`. Production binaries use `CGO_ENABLED=0`, `-trimpath` and explicit version/source metadata. Builds require a clean committed tree and recheck source identity after compilation.

`npm run package:resources` builds the UI and prepares the Windows `dant-core.exe`, Linux Worker, fixed host/VM helpers, licenses and provenance manifests. Secrets and runtime data are excluded. The native host accepts a Controller only when runtime, protocol, version and source match its bundle.

After committing reviewed source, prepare resources and use `npm start`, `npm run dev` or the native desktop launcher. Prepared manifests must match the source being launched; changing backend resources requires rebuilding them.

All Go test sources live under `tests/go/`, mirroring their complete package paths. Use `npm run check:core`, `npm run test:core` and, on Linux with a C compiler, `npm run test:core:race`. Their explicit compiler overlay preserves private package access and validates recursive discovery. Bare `go test ./...` from `core/` does not discover that external test tree.

Source checks, artifact integrity and real-device acceptance are distinct. See [testing](testing.md), [CI](ci.md) and [verification](verification.md) for their required evidence.
