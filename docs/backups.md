# Work computer backups

English · [Chinese](zh-CN/backups.md)

Use **Settings → Chat & data → Work computer backups** to keep local copies of a VM's persistent dant data. Restoration always requires a preview and an explicit **Replace data and restore** action. This guide describes the current source; published packages may contain an earlier implementation.

Backup settings, saved copies and portable export live in **Chat & data**. The separate **Import backup file** card stays in **Work computer** so an existing companion can be imported during computer setup. Export chooses an existing saved copy and works while its VM is offline; create a backup first if the list is empty.

## Configure backups

| Setting                       | Behavior                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual                        | Only **Back up now** creates a backup. Periodic, connection and VM-change triggers are disabled.                                                                 |
| Automatic                     | Enables the selected connection/VM-change triggers and periodic backups. This is the default.                                                                    |
| Backup interval               | **15–10,080 minutes**, default **60**.                                                                                                                           |
| After connecting              | Enabled by default. An eligible connection schedules a background backup check.                                                                                  |
| Before changing work computer | Enabled by default. A backup must complete before the connection/configuration change proceeds.                                                                  |
| Retention                     | Default **10 copies per work computer**. The authenticated settings API also accepts `retainCount` from 1 to 100; the current page does not expose that control. |

The Controller owns these settings and background checks. The settings page only reads metadata and submits explicit actions; it does not run an agent, send heartbeat chat messages or schedule another model request. Closing the settings page stops its polling, while the Controller can continue an admitted backup.

Backups require a connected Worker with backup support and available local secret protection. The model provider does not need to be signed in when the Worker can safely export idle data. Active work, a call, human control, an installation or another protected operation can prevent capture. A rejected or changed capture preserves existing backups.

When **Before changing work computer** is enabled, the first change request can start a backup and return `backup_before_vm_change_required`. Wait for the backup to finish, then explicitly retry the original change. The Controller does not queue a delayed VM switch. A recent successful copy can satisfy this guard. Manual mode disables the guard as well as the other automatic triggers.

## Storage and coverage

The Controller stores settings in `dataDir/backup-settings.json` and archives in `dataDir/vm-backups/<id>.dantbak`, under its existing private data directory. There is no configurable destination or plaintext fallback. Retention is applied separately to each source computer, so a new computer's backups do not evict the previous computer's retained copies.

Each local archive uses a fresh **AES-256-GCM** key. Windows **DPAPI** protects that key for the local user profile; authenticated metadata is bound to the encrypted payload. To move to another account or computer, use **Export backup** to create a password-protected portable `.dant` file; copying the private `.dantbak` file alone does not transfer its local key. Host secret protection is an explicit capability: future Unix adapters must provide an implementation before local backup storage is enabled. An unavailable provider causes a safe failure, never an unencrypted archive.

The two archive domains are the Worker's persistent **data** and **workspaces** trees, normally `~/dant/data/` and `~/dant/workspaces/`. They include conversation/task records, memory and schedule databases, retained project context, attachments, managed skills and workspace files. Project `.git` directories are included, preserving local commits and unpublished branches. Exclusions cover the Worker's top-level runtime, deploy, diagnostics, logs, cache, tmp, updates, backups and `.env` entries, plus `node_modules`, `.cache`, `.ssh`, `.codex` and `.openai` subtrees. Ordinary project configuration files in workspaces, including project `.env` files, remain part of the encrypted data. This is a dant data backup, not an operating-system or VM-disk image.

Capture stages ordinary files with bounded reads and identity/version checks. SQLite databases in the Worker's **data** tree, including memory and schedules, use **`VACUUM INTO`** snapshots and integrity checks rather than copying live journal/WAL sidecars as independent data. A locked or invalid data database prevents capture.

Databases in **workspaces** belong to projects or other applications and may hold exclusive locks. They are preserved as ordinary bytes together with every existing `-wal`, `-shm` and `-journal` file; dant does not open, repair or silently omit them. Every included file and directory is checked again before accepting the whole capture, so a changed, added or removed file aborts it. These external database copies are **not SQLite transaction snapshots** and do not guarantee database-level consistency. Each data-tree SQLite snapshot is consistent, but the combined JSON/files/multiple-database archive is **not a whole-system ACID transaction** and does not freeze unrelated external processes. Temporary capture and restore staging is private and cleaned; only completed encrypted archives become retained copies.

Firefox's transient host/PID `lock` symlink is excluded only inside a validated ordinary profile; Firefox recreates it on the destination VM. Its identity and target remain checked during capture. Other symbolic links, hard links and special files are rejected rather than followed or silently omitted.

The Go service ownership file, `.dant-core-owner.lock`, is runtime state and is excluded from capture and portable exports. Restore never transfers that lock into the new data root. Offline Linux restore, recovery and export also acquire the Go ownership lock, in addition to the persistent kernel restore lock outside the replaced roots, so a separately running Go Worker blocks those operations. A confirmed stopped systemd unit must have no remaining cgroup processes; an unknown stop result does not authorize replacement.

The original local and portable AES-GCM byte formats are retained. A short-lived `--role=backup-transform` process authenticates or encrypts an exclusively created private stage using a file-backed mapping and the standard library AEAD. A decrypt must authenticate successfully before any plaintext reader becomes available. Keys travel over bounded stdin, never command arguments or logs; cancellation kills and joins the owned child. This avoids allocating an archive-sized Go heap in the Controller. The mapped pages still consume resident memory in the child, and capture/import/export require private temporary disk space, including plaintext stages. Those stages are removed on completion or failure. An isolated 256 MiB fixture verifies both directions and records only child heap and peak resident sizes; it is a bounded-memory check, not a performance guarantee.

## Restore deliberately

On first use, dant asks whether you already have a backup. Import a portable backup first, or choose to create a new work computer. Importing does not require an online VM and does not restore or start tasks. Connect or create the destination VM afterward, then preview the imported backup before restoring it.

Use **Export backup** to share or move dant between supported clients, computers and VMs. Enter and confirm a passphrase, then save the portable file. On the destination computer choose **Import backup**, select that file and enter its passphrase. The Controller verifies authentication and archive structure before saving it under that computer's local protection. Wrong passwords, tampering and interrupted uploads cannot become successful imports. The Windows file picker streams large files; the browser fallback has a 64 MiB transfer limit.

Portable exports preserve identity, memories, skills, history, schedules and project contents, including local Git history. They omit known credential stores, model/SSH authentication and integration secrets; sign in and pair integrations again on the destination. Portable backups contain personal chat and memory, so share them only with intended recipients. Google Drive synchronization is planned as a storage adapter; this version uses explicit file export/import and does not connect to Drive.

The portable filter also omits private `.env` variants and Git remote configuration (`.git/config`), while retaining `.env.example`, Git references and objects. Recreate private environment values and remote settings on the destination. Ordinary source modules named `credentials` and fixture files named `auth.json` are preserved; the filter uses the archive domain and explicit authentication paths, rather than guessing from user content.

1. Connect the intended work computer and open the backup list.
2. Choose **Preview restore**. Inspect the time, service version, file count and size. The preview warns when the source computer or service version differs, and that current data will be replaced.
3. Choose **Replace data and restore** only for that preview. Cancellation, expiry, refreshing, switching computers/conversations, leaving the page or losing the connection discards the UI's consent. The server also binds its short-lived, single-use confirmation to the exact backup and target connection.
4. Wait for the result. An accepted `202 {started:true}` means the operation was admitted, not that it finished. The UI polls metadata for completion.

The Controller pauses work and confirms quiescence, stops `dant-worker.service`, and runs the fixed restore CLI over SSH. The VM stays running. The CLI validates the complete archive in private staging and replaces the owned data/workspace roots through a journal with rollback/recovery for interrupted two-root replacement. This is not a single atomic rename across two filesystems. The Worker restarts, and the Controller confirms the exact startup-loaded restore receipt before declaring success.

Restoration preserves historical IDs and results while removing live execution/thread bindings. Nonterminal work stays paused; existing uncertain submissions stay uncertain and are not replayed. Scheduled work is disabled/paused, dispatched history and dispatch fences remain, and incomplete handoffs require reconciliation. Telegram is disabled after restoration. Model authentication is excluded, so sign-in may be required. Restoring data does not silently resume tasks, recurring jobs or outbound messages.

An interrupted or unconfirmed restoration retains its durable receipt and reports an unknown outcome. Checks first inspect the startup-loaded receipt. If the service stopped after a confirmed data commit, a fixed CLI can finish starting it only after checking the exact committed restore ID and current service state while holding the Linux kernel restore lock. It does not upload, apply or roll back the archive again. A missing or uncertain commit remains blocked. Resolve the observed state before attempting another restoration or changing the VM.

## Implementation

| Boundary                                   | Modules                                                                                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and validation                          | [`vm-backups.mts`](../ui/settings/vm-backups.mts), shared backup types, enums and limits                                                                                                                                                                 |
| Local scheduling and consent               | [`manager.go`](../core/internal/backups/manager.go)                                                                                                                                                                                                      |
| Protected local archives                   | [`vault.go`](../core/internal/backups/vault.go), [`transform.go`](../core/internal/backups/transform.go)                                                                                                                                                 |
| Portable format and authenticated transfer | [`portable.go`](../core/internal/backups/portable.go), [`local_routes.go`](../core/internal/controller/local_routes.go)                                                                                                                                  |
| First use and native file transfer         | [`first-run.mts`](../ui/onboarding/first-run.mts), [`backup-transfer.mts`](../ui/platform/backup-transfer.mts), [`backup_transfer.rs`](../src-tauri/src/backup_transfer.rs)                                                                              |
| Authenticated export / offline SSH restore | [`vm_transport.go`](../core/internal/backups/vm_transport.go), [`worker_cli.go`](../core/internal/backups/worker_cli.go)                                                                                                                                 |
| Worker capture, validation and recovery    | [`worker_archive.go`](../core/internal/backups/worker_archive.go), [`archive.go`](../core/internal/backups/archive.go), [`worker_restore.go`](../core/internal/backups/worker_restore.go), [`worker_state.go`](../core/internal/backups/worker_state.go) |

Controller routes are `GET /api/backups`, `PATCH /api/backups/settings`, `POST /api/backups/run`, `POST /api/backups/import`, `POST /api/backups/:id/export`, `POST /api/backups/:id/preview` and `POST /api/backups/:id/restore`. They use the existing local API authentication. The Worker export and receipt endpoints remain behind its authenticated VM transport. No backup route makes the Windows Controller an agent executor.

Tests use isolated data, injected transports and clocks. They do not back up, restore, stop or reconnect a user's real VM. See [architecture](architecture.md), [VM setup](VM.md) and [verification](verification.md) for the surrounding boundaries and acceptance records.
