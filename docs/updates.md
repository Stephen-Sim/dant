# Version and updates

English · [Chinese](zh-CN/updates.md)

Open **Settings → About dant** to see the current application version. The version remains visible when the VM is disconnected.

Choose **Stable** or **Beta**, then select **Check for updates**. Stable checks published formal releases; Beta also includes published prereleases and selects the newest version. The choice is saved on this computer. Switching channels does not install or downgrade anything.

Checks query public releases of [Stephen-Sim/dant](https://github.com/Stephen-Sim/dant/releases) on Windows and do not require VM access, ChatGPT sign-in or an API key. GitHub receives ordinary release requests; dant does not send conversation content or credentials. Checks run when requested, with separate short-lived caches for each channel.

On Windows, **Download update** downloads the official installer in the background and verifies its published size and SHA-256 digest. Chat, calls and work continue during the download. **Install and restart** is a separate action for the default per-user installation at `%LOCALAPPDATA%\dant`; portable and custom locations use the release page. Installation first confirms that ongoing work is paused, ends the current call and releases known human control, then suspends the managed VM. Unconfirmed work or control prevents installation. The installer replaces the local application; reopening restores the owned VM and checks its bundled service. An unmanaged SSH computer can have its work paused, but cannot be suspended without a verified hypervisor identity. Recording, dictation, unsent audio and in-flight input must finish before installation. Failed installation leaves a short recovery notice; a partial installation is not automatically launched.

Before an update restart, dant saves the current unsent chat text, reply and uploaded attachment references in a bounded, short-lived local draft scoped to the same work computer and conversation. Recorded audio drafts must be sent or discarded first. Secure input values are not saved in this draft.

**View update** opens the release page for its notes and manual installer or portable downloads. Manual installation still requires exiting dant through the tray menu. If an installer cannot be verified or the current application layout does not support automatic installation, use the release page instead.

A failed or rate-limited request shows a retry message rather than claiming the application is current. A failed or incomplete download cannot be installed.

## Work computer service updates

### Go Core migration in 0.4.7-beta.13

The Windows Controller and Ubuntu Worker now use compiled Go programs; Tauri remains Rust and the interface remains TypeScript. Updates verify the running Worker role, protocol, version and source commit. A durable installation journal prevents a reboot or an independent service start from bypassing offline backup and preparation. Only a matching successful preparation receipt permits activation. Existing chats, SQLite memory/schedules, skills and workspace keep their saved paths. See [architecture](architecture.md) and [migration](go-core-migration.md).

### Startup compatibility in 0.4.7-beta.10

Beta 10 fixes a desktop state-validation regression that could show **Invalid application state** even while the local Controller and VM service were reachable. The UI now accepts supported empty values and older Worker metadata, including the null call ID of an ordinary active chat task, without inventing task ownership or execution confirmation. The fix is in the desktop executable's embedded frontend, so updating only the VM cannot repair an older embedded frontend. If that screen prevents opening Settings, install the newer desktop package from the release page.

Older Beta 7 installations could retain an unconfirmed update receipt after a pre-install busy-work guard. Automatic checks preserve that receipt rather than retrying an uncertain deployment. An explicit **Reconnect** uses the protected pause, saved-task and final-idle checks before a new update intent; successful live source/version confirmation resolves it. Do not remove update receipts to bypass those checks.

Beta 10 also adds configurable [local VM data backups](backups.md). The backup UI requires the matching Worker capability; upgrade the connected service before using it. Existing backups are retained while the service is unavailable.

If chat state cannot be loaded, the recovery page reads local connection settings independently. It shows the Controller version, permits editing the SSH connection or selecting a discovered profile, and checks published updates without VM access. Saving settings does not silently reconnect or deploy. When the previous VM cannot provide its required pre-change backup, an explicit one-time skip permits changing the connection without disabling future backups. A restore with an unknown outcome remains protected and cannot be bypassed by that checkbox.

dant checks the bundled work computer service when connecting after installation or startup. If the work computer is busy, dant connects to its existing service and keeps a pending update. Once fresh state confirms that work, calls and computer control are idle, it continues the update automatically; no separate Reconnect action is required. Transient connection failures retry with a bounded backoff. Ordinary network recovery does not repeatedly deploy an already current service.

**Settings → Work computer** shows the service update status and target / confirmed running versions. A cached connection or a successful installer exit alone does not mean the service is current; dant confirms the running version through the live VM connection. An executor intentionally stopped for safety is not restarted by automatic updates. Unconfirmed update outcomes are reconciled through read-only checks instead of replaying pause or restart operations. **Pause updates** suspends automatic service updates until **Resume updates**. **Pause work and install**, or an explicit **Reconnect**, first pauses current work and verifies its saved records before replacing the service. A changed call, control owner or unknown execution outcome prevents replacement. Paused tasks require an explicit task reply or Resume afterward.

Explicit installation also supports an older Worker whose executor is already safely stopped: after confirmed pause and fresh idle checks, the existing idle-recovery endpoint confirms the update witness. This does not resume paused tasks. If an owned legacy VM is saved but has no local suspension receipt, explicit **Reconnect** can verify its exact owned disk and recover that saved VM before opening SSH. Automatic startup does not guess that an unrecorded suspension should be resumed, and a powered-off VM is not started by this compatibility path.

The bundled service runs as a compiled Go executable with SQLite and FTS5 included. Deployment verifies the Linux binary and helper hashes, then confirms the live Worker role, Go runtime, protocol, target version and source commit. An incompatible runtime or unconfirmed stop preserves the current service and blocks activation; it does not fall back to Node. Upgrading from the older Node Worker requires an offline backup and confirmed executor shutdown before data preparation. Codex installation and user tools may still use Node/npm independently. See [runtime support](runtime-support.md) and [Go migration](go-core-migration.md).

In **0.4.7-beta.8**, the Worker imports legacy memory and schedules once, with backups, into `memory/dant/memory.sqlite` and `schedules/schedules.sqlite` under the Worker data directory. Chat messages and durable work remain in `state.json`. Keep these databases with data backups; changing application versions does not reverse their migrations. A recovered schedule dispatch preserves its exact message identity and remains paused or uncertain rather than being sent again.

## Work computer updates in 0.4.7-beta.5

The desktop installer preserves the running VM service. In **0.4.7-beta.5**, explicitly choosing **Settings → Work computer → Reconnect** also updates that service when its packaged source has changed. Dependencies are prepared first; the existing worker then confirms a global pause, saves its task records and ends any current call before the service is replaced. This uses the global pause operation supported by older workers, so it does not depend on their having the newer per-task Pause endpoint. Paused work remains available for explicit resume.

In that version, opening the application or recovering a lost network connection preserves busy work. Reconnecting with unchanged deployed source also leaves it running. An unconfirmed pause, control lease or execution prevents replacement. Failed activation restores the old runtime only when no new work has begun; chat, memory, skills and task records are not rolled back. A missing per-task Pause/Resume route displays service-update guidance and never silently pauses unrelated tasks.

## Exit and restore

Closing the window keeps dant in the tray. Choosing **Exit** confirms paused work and suspends the whole managed VM. Reopening restores that same VM after checking its identity. If restoration is declined or cannot be confirmed, **Reconnect** can retry the checked restoration. An unrelated VM is never selected. An unmanaged SSH connection reports when whole-VM suspension is unavailable.
