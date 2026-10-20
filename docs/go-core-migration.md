# Go Core migration and cutover

English · [Chinese](zh-CN/go-core-migration.md)

The current source assembles **Go Agent Core + Rust Tauri + TypeScript UI**. Go owns the Controller and Linux Worker backend, including persistence, execution orchestration, memory, scheduling, calls, Telegram, files, Skills, security, VM deployment and backups. TypeScript remains in the browser and build tools. The root `src/` backend has been removed; independent synthetic Node golden results remain as data fixtures. This is a source implementation statement, not a record of a published release or completed local installation acceptance.

Codex App Server still owns model reasoning, tool iterations and its persistent conversation. dant's Go Engine owns admission, durable work, acknowledgments, resource ownership and delivery. It does not implement another LLM loop. See [system architecture](architecture.md) and [runtime support](runtime-support.md).

## Runtime and package ownership

| Owner                                                             | Production responsibility                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `core/cmd/dant-core`, `core/internal/application`                 | Validate process roles, assemble dependencies and own shutdown.                                                   |
| `core/internal/controller`, `computer`, `platform`                | Host configuration, providers, SSH forwarding, deployment, lifecycle and offline views. No Engine on Windows.     |
| `core/internal/app`, `work`, `runtime`                            | Authenticated Worker API, single execution admission, task continuity and the existing Codex RPC protocol.        |
| `core/internal/store`, `history`                                  | Original conversation files, exact IDs, durable work, typed call-input history and read/delivery receipts.        |
| `core/internal/memory`, `schedules`                               | SQLite ownership, revision-aware memory/FTS recall, recurrence and dispatch fences.                               |
| `core/internal/voice`, `telegram`                                 | Existing call/media lifecycle, transcription, captions and paired messaging with no replay of unknown deliveries. |
| `core/internal/files`, `skills`, `security`, `backups`, `updates` | Validated files, supporting Skill bytes, credentials, protected archives and update contracts.                    |
| `src-tauri/src`, `ui`                                             | Native window/OS integration and TypeScript browser interaction.                                                  |

Every Go test lives under `tests/go/`, mirroring its complete package path; the official compiler overlay preserves package-private access. Fixed queries, transaction ownership and validated row mapping stay inside their owning repository. Entrypoints and HTTP adapters do not receive arbitrary SQL or open caller-selected database paths. Narrow interfaces belong to consumers; there is no generic repository or automatic ORM migration.

Controller and Worker are distinct roles of the compiled executable. The Controller never starts a task Engine or executes agent work on the host. Host and provider abstractions retain Windows Hyper-V/VMware behavior; recognized Unix host capabilities are extension points, not a claim of macOS/Linux desktop release support.

## Stable contracts and data

`resources/contracts/state-domains.json` generates typed Go states and frozen TypeScript domains. `core-protocol.json` supplies shared transport limits. `npm run check:contracts` rejects drift. Runtime decoders still validate consumed fields, including enum values, message/turn/conversation identity and absence versus explicit null or zero. Shared text helpers preserve ECMAScript trimming, UTF-16 budgets and supported legacy JSON text; Unicode golden fixtures compare normalization and case behavior with the reference implementation.

Existing API routes, `X-Dant-Token`, origin/host validation, native IPC, `4317` application API, `4320` guest desktop bridge and authenticated SSH forwarding remain in place. Tokens authenticate local HTTP; SSH encrypts the host-to-VM channel. The Worker remains an ordinary user inside a graphical Linux VM. Changing language does not grant new permissions.

The runtime cutover preserves original locations and identities:

| Authority                     | Preserved contract                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `state.json`                  | Messages, durable work, submission/continuation receipts, timestamps, nullable values and supported legacy fields.        |
| `memory/dant/memory.sqlite`   | Schema 1, notes, projects, entries, revision triggers, confirmation/conflict rules and FTS5.                              |
| `schedules/schedules.sqlite`  | Saved jobs, creation-request tombstones, occurrence claims and prepared/materialized/held/handed-off receipts.            |
| Files, Skills and credentials | Immutable attachment IDs, supporting files, private vault paths and protected envelopes.                                  |
| Backups and Codex home        | Existing archive formats and source identities, with model authentication excluded where the backup contract requires it. |

The Go Memory Store is the only production writer after activation. It synchronizes stale FTS within its own SQLite transaction and checks revisions before cache reuse. Automatic recall filters conversation/work scope before ranking and limits, rechecks confirmed status and source, redacts references and enforces UTF-16 budgets. It attaches relevant memory to an already-admitted input; it cannot authorize work. Candidate/conflicted entries remain excluded until explicitly confirmed.

Scheduler SQLite claims and the JSON message fence remain separate durable writes. The exact message ID is materialized before a no-replay handoff receipt is committed. A lost enqueue acknowledgment does not create another dispatch. Recovery retains paused/unknown work and original IDs. The continuation Supervisor and Scheduler both use the same Engine admission owner; timers do not create a second executor.

SQLite uses pinned pure-Go `modernc.org/sqlite`, bounded busy waits, `synchronous=FULL` and DELETE journaling. The runtime-language migration does not change the schema or enable WAL. A later schema/journaling change requires its own backup and compatibility policy.

## Old Node Worker to Go Worker

The installer owns this boundary because a Go-only mutex or data-root lock cannot establish that a legacy Node executor stopped.

1. The Controller verifies version, source commit, fixed bundle paths, file lengths and hashes before uploading the Linux executable and helpers.
2. `vm/worker-install.py` takes a kernel installation lock and records the installation phase. The current maintenance protocol blocks new admission; a positively identified legacy route uses its existing guard and stopped-process proof.
3. The installer stops the old user service and verifies the service and owned Codex processes have ended. An unknown shutdown stops the cutover.
4. It installs the verified Go executable and Go service definition, captures a private recovery archive, and validates that archive before offline `prepare-worker` opens or migrates existing data. Preparation does not start a model, schedules or Telegram dispatch.
5. The new Worker takes exclusive data-root ownership before enabling its live services. Readiness must confirm the target version and source provenance before deployment is recorded as current.

A failure preserves data, the private archive and an explicit unconfirmed installation receipt. It does not restart an old Node Worker against prepared data or replay an uncertain action. Recovery requires independent reconciliation and exclusive ownership. Restore likewise validates the archive first, pauses tasks/schedules, disables Telegram and uses the existing target-bound receipt protocol.

Before stopping an existing Worker, a read-only footprint check accounts for capture staging, encoded recovery archives, validation staging and migration headroom on their actual filesystems. Insufficient capacity stops the attempt before service shutdown. Temporary backup copies do not require a durable flush for every file; archive integrity checks and final archive/vault flushes remain the persistence boundary.

Background deployment and the three native deployment request routes retain a bounded budget for the complete sequence, rather than cancelling preparation at the ordinary connection deadline. Ordinary VM/API reads keep their shorter limits. Cancellation or a lost final reply still records an unknown result and does not authorize another installation.

An interrupted attempt before preparation can be reconciled only through the explicit operator command `reconcile-stopped`. It requires the exact attempt ID and original journal hash, verified old/new source manifests, stopped-process proof and the installation lock. The original journal is retained as durable evidence before a new fenced attempt is written. Preparation or activation uncertainty cannot use this path, and automatic connection checks never invoke it.

The Worker also checks `install-attempt.json` before opening Store or Memory, including independent service starts and reboots. `reserving`, `stopping` and `preparing` cannot start live services. Offline preparation writes `worker-preparation.json` only after archive authentication and all preparation steps succeed; this receipt binds the attempt, version, source commit, verified bundle, exact data/workspace roots and archive identity/hash. `activating` requires that receipt and the unchanged recovery archive. `committed` retains the receipt while allowing normal archive retention, without scanning a multi-gigabyte archive on every boot. The managed `app` symlink must resolve to the exact verified release directory. An absent installation journal remains an explicit fresh/manual-install compatibility case; malformed or partial journals never use that exception.

## Explicit early-export import

`core/internal/legacyimport` replaces the former Node `vm/migrate-state.mts` operator tool. The verified executable accepts `--role=legacy-import --source-dir <absolute-export> --data-dir <absolute-empty-target>`. It reads the early `manifest.json`, `state.json` and `files/<legacy-id>` layout without constructing a Controller, Engine, model session or Scheduler. It is separate from current portable-backup restore.

The target must be empty and exclusively owned. Available attachments receive one UUID mapping per original ID, preserving arbitrary bytes and safe display names; missing files receive bounded unavailable markers. Original state and manifest bytes remain private evidence, while active host VM credentials are cleared, unfinished user/work records are paused, schedules disabled and uncertain outcomes retained. Supported missing legacy identities and timestamps are not fabricated. The original source is unchanged.

A durable intent precedes output writes. State, attachment metadata, receipt and completion proof are flushed and bound by hashes. Only an unchanged, fully authenticated completed import can return idempotent success; a partial write, changed source or changed destination requires independent reconciliation. The early format has limits of 10 MiB per file, 1,000 unique files, 512 MiB total attachment bytes, 128 MiB state and a 64 KiB manifest. These limits belong to this operator tool, not modern VM backups. See [test migration](testing-migration.md).

## Build, resources and development

Go **1.27.2** is pinned in tooling and CI; automatic toolchain selection is disabled. Production binaries use `CGO_ENABLED=0`, `-trimpath` and explicit version/source build metadata. `buildCore` requires a clean committed tree, validates the expected CI commit, and checks it again after compilation. Dirty source cannot be labeled with an unrelated clean commit.

`npm run package:resources` builds the TypeScript UI and prepares these verified resources:

- Root `dant-core.exe` for the Windows Controller.
- `resources/core/dant-core-linux-amd64` and its fixed VM-helper bundle manifest.
- The UI, fixed host/VM helpers, protocol JSON and license.
- Build and complete resource manifests binding bytes to version, source commit and SHA-256.

No backend TypeScript tree, `node_modules`, Node executable, `.env` or runtime data is packaged. The native host launches the compiled Go Controller and accepts only a matching runtime/version/source marker. There is no production Node fallback. Python desktop helpers and Codex App Server retain their separate roles.

After committing reviewed changes, run `npm run package:resources`, then `npm start` to launch the validated compiled Go backend. `npm run dev` uses the same prepared backend with Vite. The launcher does not silently rebuild dirty source or run `src/server.mts`. See [runtime support](runtime-support.md) for tools and [CI](ci.md) for gates.

All Go test sources live in `tests/go/`, mirroring the package path under `core/`. Run `npm run check:core`, `npm run test:core` or `npm run test:core:race`; the shared runner recursively validates the complete inventory and passes an explicit Go compiler overlay, preserving private package access and platform suffixes. Bare `go test ./...` from `core/` does not discover this external test tree. No production interface is exported solely for test access.

## Compatibility evidence and remaining acceptance

The original read-only Memory shadow role remains an explicit test tool with bounded stdio framing, four workers, a bounded queue, cancellation, revision checks and no execution capability. The fixture-only Node tool reconstructs sanitized SQLite snapshots from frozen independent golden data; Go Store and reader tests compare scope, ranking, nullable metadata, excerpts and scores. Shadow results never enter production context. Production recall uses the Go Store directly.

`npm run test:core:parity` retains the isolated reference comparison, including CJK, NFKC expansion, UTF-16 boundaries, source isolation and integral SQLite REAL timestamps. Other Go fixtures cover writes, conflicts, restart/dispatch phases, calls, unknown outcomes, backup recovery and transport cancellation. The old backend tests have moved to their owning Go packages; browser and tooling tests remain TypeScript. The independent golden data retains exact Node source provenance without retaining Node business logic. See [test migration](testing-migration.md).

Run pinned formatting, `go vet`, all package tests and Linux race checks, together with strict TypeScript, existing coverage, Python VM helpers, Rust, version and release-integrity gates. Source-test success does not prove packaged native launch, real VM update/restore, live audio, Telegram delivery or desktop task success. Those require separately recorded acceptance with verified artifacts; no release or installation success is implied by this document.
