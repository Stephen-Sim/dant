# Versions and updates

English · [Chinese](zh-CN/updates.md)

Open **Settings → About dant** to see the installed version, including when the VM is disconnected. Select **Stable** or **Beta**, then **Check for updates**. Stable checks published stable releases; Beta also includes published prereleases and chooses the newest version. The saved channel never triggers an installation or downgrade by itself.

The Windows update check queries public [Stephen-Sim/dant releases](https://github.com/Stephen-Sim/dant/releases). It needs no VM connection, model account or API key. The request contains no chat or credentials. Checks run when requested, cache each channel briefly and report errors or rate limits without claiming the app is current.

## Desktop application

**Download update** downloads the official Windows installer in the background and verifies its size and SHA-256. Chat, calls and work may continue during download. A failed or incomplete download cannot be installed.

For the default per-user installation, **Install and restart** uses the protected native update path. Before installation it confirms paused work, ends the current call, releases known human control and suspends the owned managed VM. Unknown execution or control outcomes block installation. Finish pending recording, dictation, secure input and input submission first. Unmanaged SSH connections can pause work but cannot claim whole-VM suspension without verified management identity.

The restart draft preserves bounded unsent chat text, reply references and uploaded attachment references only for the same work computer and conversation. It excludes secure inputs; audio drafts must be sent or discarded. Installation failure shows recovery guidance and does not automatically launch a potentially partial installation.

Portable applications and custom install locations use the release page for manual installation. Choose tray **Exit** first and verify native and Controller processes have stopped. Do not use a silent installer to force-close an application. **Open release** opens the exact published release for notes or a manual download.

## Work computer service

The Controller checks the packaged Go Worker source after installation or startup connection. Busy work remains connected to its existing service while an update waits. When a fresh observation confirms tasks, calls and control are idle, the update can proceed. Connection retries are bounded; ordinary network recovery does not repeatedly deploy an already-current source.

**Settings → Work computer** shows target and confirmed running versions. Cached state and installer success alone do not prove the running source. **Pause updates** blocks automatic service updates until **Resume updates**. Explicit **Pause tasks and install** or **Reconnect** first pauses work, verifies saved task state and confirms execution stopped. Paused work requires an explicit matching reply or resume action to continue.

The existing maintenance protocol fences new admission during replacement. An executor confirmed safely stopped may use the supported idle-recovery witness without resuming paused work. A missing per-task capability shows service-update guidance; it does not silently pause unrelated work. Unknown update outcomes are reconciled before another attempt, and receipts must not be removed to bypass that protection.

The Computer panel combines the disconnected executor status and **Reconnect** in one row. While connecting, that action is disabled and shows **Connecting**. A restored connection does not prove that earlier work completed or authorize replaying an unknown submission. Work progress shows task status, and saved records retain the pause reason; message timestamps and delivery/read receipts remain separate from task execution.

Explicit reconnect to the current Worker can restore a paused, idle executor while preserving historical unknown task outcomes. The Controller verifies the same authenticated Worker source, protocol, VM binding and connection generation before and after recovery. A changed conversation, pause state, active work, control handoff or unconfirmed executor stop prevents acceptance. This connection recovery does not relax service replacement checks.

Deployment verifies the Linux binary, fixed helpers, version, source and hashes. Before stopping the service, it checks capture/archive/preparation space on each affected filesystem. A complete authenticated private backup and confirmed stopped executor are required before offline data preparation. The new Worker must prove its role, Go runtime, protocol, target version and source before deployment becomes current. Failure preserves data, journals, backups and uncertainty.

The durable installation journal guards independent starts and reboots. Only the matching successful preparation proof allows activation. Eligible attempts interrupted before preparation have an explicit identity-bound operator recovery path; automatic checks do not edit the journal or replay installation. See [Go Core](go-core.md), [runtime support](runtime-support.md) and [backups](backups.md).

## Saved data and attachments

Chat and durable work retain their identities in `state.json`; memory and schedules use their SQLite databases under the Worker data directory. Supported earlier JSON/Markdown formats are validated and backed up before one-time import. A stale file cannot replace a newer authoritative database or restore a deleted schedule. Application version changes do not reverse data preparation.

Restored attachments resolve stable IDs through the current verified storage before model input or transcription. A different home/workspace root is supported without reusing historical file paths. Missing, changed or unconfirmed files block execution. Restore retains unknown submissions and pauses unfinished work and schedules.

## Recovery settings and exit

When chat state cannot load, recovery settings independently read local connection configuration and show Controller version. They allow reviewing SSH settings, selecting discovered profiles and checking published updates while the VM is offline. Saving settings does not connect or deploy. If the previous computer cannot provide its required pre-change backup, explicit one-time consent can permit the connection change; it does not disable future backups or bypass uncertain restore protection.

Closing the window keeps dant in the tray. Explicit **Exit** confirms paused work and suspends the owned managed VM. Reopening restores the same verified VM; **Reconnect** can explicitly recover an unrecorded Saved state after ownership checks. It does not select another VM or automatically start an Off VM through that recovery path. Service replacement keeps its VM powered while updating the service.

Source checks, candidate artifacts and real installation acceptance are separate. See [testing](testing.md), [CI](ci.md) and [verification](verification.md).
