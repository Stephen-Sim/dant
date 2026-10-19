# Go Core migration design

English · [Chinese](zh-CN/go-core-migration.md)

**Status: adopted target; implementation is planned.** The current application, including the Beta12 source, still uses a TypeScript/Node.js Controller and Worker. No Go backend, Go build gate or Go runtime cutover is implemented by this document. [System architecture](architecture.md) remains the description of current behavior.

The target is **Go Agent Core + Rust Tauri + TypeScript UI**. This changes the language of dant's backend orchestration; Codex App Server continues to own model reasoning, tool iterations and its conversation. Go must not introduce a second LLM loop.

## Ownership

| Component          | Target responsibility                                                                                                       | Existing boundary to preserve                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| TypeScript UI      | Pages, interaction, rendering and validated requests                                                                        | No local execution or direct database access                                 |
| Rust Tauri         | Window management, tray, notifications, native IPC, installer, system editor and OS integration                             | Native commands stay scoped to their existing window and validated transport |
| Go Controller      | HostPlatform, VMProvider, SSH forwarding, lifecycle, deployment, updates, host preferences, local backups and offline views | Never construct an execution Engine or run agent tools on the host           |
| Go Worker          | Authoritative conversation state, execution admission, task lifecycle, memory, scheduling, heartbeat and tool routing       | Linux VM, ordinary user, healthy desktop, one execution owner                |
| Codex App Server   | Model reasoning, persistent model threads and tool iterations                                                               | Existing subprocess stdio JSON-RPC with acknowledged thread/turn identity    |
| VM desktop helpers | Screenshot, input, file operations and human-control lease                                                                  | Preserve the Python bridge and existing authorization checks                 |

Controller and Worker remain separate runtime roles, even if shipped from one Go module. An offline Worker must never cause the Controller to become an executor. HostPlatform and VMProvider remain explicit adapters; the Go migration alone does not implement macOS or Linux host support.

The present implementation boundaries are [`src/app/`](../src/app/), [`src/work/`](../src/work/), [`src/runtime/`](../src/runtime/), [`src/conversation/`](../src/conversation/) and [`src/schedules/`](../src/schedules/). Migrate these responsibilities through narrow adapters; do not grow a new entrypoint containing all of them.

## Contracts before implementation

Use a single language-neutral schema source for dant-owned API DTOs, named state domains, errors, identity fields and protocol limits. Generate Go, TypeScript and relevant Rust types and validators, with a CI drift check. Keep existing wire values; generated types do not replace runtime validation. Keep the Codex protocol adapter separate and compatible with the pinned App Server version.

The compatibility contract includes:

- Current API routes, authentication, allowed origins, event streams and native IPC. Preserve the `4317` application API and `4320` desktop bridge defaults from [`protocol.json`](../src/config/protocol.json), existing size limits and SSH forwarding. A transport redesign is a separate change.
- Exact conversation, work, message, thread, turn, call and connection-generation identity. Recheck captured identity before applying asynchronous results.
- Missing, `null`, `false` and zero as distinct values where the current API distinguishes them. Go `omitempty` must not erase explicit clears; decode numbers through typed fields or exact JSON numbers, not unchecked `float64` maps.
- Existing unknown outcomes and stable error codes. Lost acknowledgments cannot become automatic retries or successful receipts.
- Named state domains with stable string values. Unknown external states fail validation or retain explicit uncertainty; they are never normalized into permission to execute.

Keep the existing local token/Origin checks, authenticated forwarding and credential-bridge scope. A Go subprocess used during migration should communicate through parent-controlled bounded stdio rather than introducing an unauthenticated port. Do not send tokens through command-line arguments or copy credentials into diagnostics, schemas or test fixtures.

## Persistence compatibility

Preserve `state.json`, attachment identities, Skills and supporting bytes, Codex home/thread data, backup manifests, credential envelopes and these databases:

| Authority                    | Required compatibility                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `memory/dant/memory.sqlite`  | Schema version, notes, project keys, memory entries, revision triggers, FTS5 and confirmation/conflict rules |
| `schedules/schedules.sqlite` | Jobs, creation-request tombstones, unique occurrence claims and dispatch receipts                            |
| `state.json`                 | Messages, durable work, submission state, source identities, timestamps and legacy fields                    |

Changing runtime language is not a reason to rename storage, generate replacement IDs or invent missing timestamps. Keep current revision comparisons, busy timeouts, `synchronous=FULL` and DELETE journaling until a separately tested migration changes them. Preserve exact revision-trigger definitions expected by the existing schema guards. The Go SQLite implementation must prove FTS5 support and the current Unicode/CJK search behavior on Windows and Linux; select and pin its driver only after those tests.

**FTS retrieval currently has a write side effect.** [`memory-search.mts`](../src/conversation/memory-search.mts) rebuilds the search index when `search_revision` differs from `revision`. A read-only Go query cannot silently skip that work. The current Node owner must first synchronize the index and produce a consistent SQLite snapshot, or provide bounded immutable candidate records. A Go snapshot reader must require a matching search revision; a stale index is an explicit unavailable/deferred result, not an empty successful search. Do not copy a live database file without SQLite snapshot coordination.

Keep the existing SQLite-plus-JSON scheduling boundary explicit: a SQLite claim serializes the exact-ID JSON patch, but those two files are not one atomic database transaction. The durable `handed-off` fence prevents replay; it does not prove execution succeeded.

## Migration phases

1. **Establish the implementation foundation.** Before the first Go source change, update [AGENTS.md](../AGENTS.md) and [code style](code-style.md) to define Go module ownership, tests and reproducible formatting. Add pinned build, format, test and race-check gates without weakening existing gates. The proposed toolchain pin is **Go 1.27.2**, verified on 19 October 2026 against the [official release history and support policy](https://go.dev/doc/devel/release). This is a future pin, not an installed prerequisite or an existing repository configuration.
2. **Shadow memory retrieval.** Keep Node as the only writer and executor. A Go helper reads an immutable, revision-bound snapshot or bounded candidates, and compares recall, scoping, ranking, redaction and text budgets against current outputs. Shadow results do not reach the model or trigger tools. After parity, connect this read path to Memory search and already-admitted input context through an adapter.
3. **Transfer Memory ownership.** Route every memory mutation, project-context write and consolidation action to Go. Establish one writer before enabling Go writes. Preserve user revision conflicts, confirmation and explicit import/export; retain the Node adapter only as a client.
4. **Transfer Worker execution ownership.** Implement Store, Scheduler, Heartbeat, Codex RPC and Engine admission behind compatibility tests. Activate their dispatch authority together. A shadow Scheduler or Engine may observe fixtures or snapshots, but must never claim jobs, create live Codex sessions or call tools.
5. **Transfer Controller and packaging.** Preserve Windows provider behavior while moving its host orchestration to Go. Update Tauri sidecar launch, resource allowlists, deployment, service management, source fingerprints, versions and artifact provenance together. Remove old backend modules only after imports, deployment and rollback behavior are verified. Node remains a UI build dependency and may still be needed by user-authored tools; removing the backend runtime does not authorize deleting those tools.

Keep each phase reviewable and independently releasable. Existing behavior remains authoritative until that phase's owner is deliberately switched.

## Execution cutover

The Worker transition requires a process-level ownership fence shared by the old and new runtimes, in addition to the existing Engine's single-admission checks. Do not rely on an in-memory Go mutex or the API port alone to exclude an old executor.

1. Block new chat, voice, schedule and heartbeat admission; retain durable queued work.
2. Use the existing pause/update path and reconcile the active turn. Confirm the old executor and its Codex child have stopped before transferring ownership. An unknown stop blocks activation.
3. Capture a validated backup and verify data/schema compatibility without modifying the backup or old runtime's files.
4. Give the Go Worker exclusive ownership before starting its timers, gateway dispatch or Codex connection. Reconcile unfinished claims by their original IDs; retain paused and unknown states rather than resubmitting them.
5. Verify version, capability and source provenance, authenticated state/events, memory and schedules before the Controller marks the new service ready.

Rollback also requires exclusive ownership. Once an external action may have occurred, reconcile it before any fallback can execute; switching binaries is not permission to replay it. A schema change requiring conversion needs a separate backed-up migration and compatibility policy.

## Verification and completion

Use isolated, redacted golden fixtures and differential tests against the current implementation. Cover memory revision/cache changes, FTS staleness, Unicode recall, scope/redaction budgets, candidate confirmation and CRUD conflicts; schedule time zones/DST, catch-up, priority, crash phases and duplicate claims; and delayed RPC acknowledgment, stale connections, cancellation, takeover and unknown outcomes. Reuse the behavior represented by `tests/conversation/`, `tests/work/`, `tests/runtime/`, `tests/schedules/` and `tests/backups/`.

Go tests must not start a real model, reconnect a user's VM, send Telegram messages or use the microphone. Validate mixed Controller/Worker versions, restart and backup recovery, Windows/Linux builds, native IPC and packaged provenance. Keep existing TypeScript, Python, Rust, formatting, coverage and release checks until their responsibilities have actually moved and replacement gates are verified.

Completion means the packaged Go roles own their documented responsibilities, preserve existing data and demonstrate one execution owner through restart and recovery. Performance claims require measured startup, memory, state-transfer and interaction results; changing backend language does not by itself fix UI rendering latency.
