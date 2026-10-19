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

dant checks the bundled work computer service when connecting after installation or startup. If the work computer is busy, dant connects to its existing service and keeps a pending update. Once fresh state confirms that work, calls and computer control are idle, it continues the update automatically; no separate Reconnect action is required. Transient connection failures retry with a bounded backoff. Ordinary network recovery does not repeatedly deploy an already current service.

**Settings → Work computer** shows the service update status and target / confirmed running versions. A cached connection or a successful installer exit alone does not mean the service is current; dant confirms the running version through the live VM connection. An executor intentionally stopped for safety is not restarted by automatic updates. Unconfirmed update outcomes are reconciled through read-only checks instead of replaying pause or restart operations. **Pause updates** suspends automatic service updates until **Resume updates**. **Pause work and install**, or an explicit **Reconnect**, first pauses current work and verifies its saved records before replacing the service. A changed call, control owner or unknown execution outcome prevents replacement. Paused tasks require an explicit task reply or Resume afterward.

The bundled service requires Node.js 22.18+ LTS or 24+ with native TypeScript, built-in SQLite and FTS5 support. Preflight, packaging and VM deployment verify these capabilities with a bounded in-memory database query. If Reconnect reports `runtime-incompatible`, dant preserves the existing VM runtime and service. Update that Node runtime through the VM’s maintenance process, then reconnect.

## Work computer updates in 0.4.7-beta.5

The desktop installer preserves the running VM service. In **0.4.7-beta.5**, explicitly choosing **Settings → Work computer → Reconnect** also updates that service when its packaged source has changed. Dependencies are prepared first; the existing worker then confirms a global pause, saves its task records and ends any current call before the service is replaced. This uses the global pause operation supported by older workers, so it does not depend on their having the newer per-task Pause endpoint. Paused work remains available for explicit resume.

In that version, opening the application or recovering a lost network connection preserves busy work. Reconnecting with unchanged deployed source also leaves it running. An unconfirmed pause, control lease or execution prevents replacement. Failed activation restores the old runtime only when no new work has begun; chat, memory, skills and task records are not rolled back. A missing per-task Pause/Resume route displays service-update guidance and never silently pauses unrelated tasks.

## Exit and restore

Closing the window keeps dant in the tray. Choosing **Exit** confirms paused work and suspends the whole managed VM. Reopening restores that same VM after checking its identity. If restoration is declined or cannot be confirmed, **Reconnect** can retry the checked restoration. An unrelated VM is never selected. An unmanaged SSH connection reports when whole-VM suspension is unavailable.
