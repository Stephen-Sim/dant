# dant

English · [简体中文](docs/zh-CN/README.md)

A digital companion for Windows, with its own Ubuntu computer, continuing memories and a personality that grows through shared experience. This rebuild follows the original UI and architecture, using Tauri/Rust, Node.js, Hyper-V or VMware Workstation, and Codex App Server.

Download the installer or complete portable package from [GitHub Releases](https://github.com/Stephen-Sim/dant/releases/latest). Windows x64 packages are unsigned; checksums and build metadata are included. Extract the whole portable archive before opening `dant.exe`.

The **Windows Controller → Ubuntu authoritative Worker** boundary keeps execution and conversation data inside the VM. Windows provides the interface, VM setup, SSH forwarding, offline display cache, and native notifications. It does not run the agent’s work commands.

See [the companion model and task continuity](docs/companion.md) for its product direction and current behavior.

## Features

- Persistent chat with time dividers for new days and gaps longer than 30 minutes, Markdown, files, replies, and six default standard reactions—Like 👍, Love ❤️, Haha 😆, Wow 😮, Sad 😢, and Angry 😡—plus distinct delivery, execution, and read receipts. Current reactions accompany task and call context; changes and removals can also reach an ongoing subscription call.
- dant can choose a reaction to a user message through its model tool. A compact **dant** badge distinguishes its reaction from your own; only your own reaction badges can be clicked to remove them.
- Chinese and English interfaces, light/dark/system themes, font and text-size preferences, and a resizable computer panel.
- Paired Telegram Bot private chats with two-way new-message and attachment sync, sharing the desktop app's VM conversation and task queue.
- Serial VM tasks with pause, explicit resume, review, and acceptance; uncertain submissions are never automatically replayed.
- Open **Work progress** in the chat header to see task status, steps, queued work and recent results. A small marker highlights results awaiting review.
- Related follow-ups reuse one work record across execution turns; ordinary conversation creates no task entry. Unfinished plans stay **In progress** until verified.
- **Scheduled tasks** has its own sidebar page with search, editing and pause controls. Ask dant in chat or a call to manage the same one-time schedules.
- VM memory, scheduled tasks, shared desktop control with an expiring lease, and unread message notifications for results or requests for input. A sidebar badge and first-unread shortcut keep unseen dant replies available; a reply becomes read after it is visible in the foreground chat.
- Up to five attachments per message, each at most 10 MiB, plus automatic delivery of eligible changed files from `output/`.
- Attachment downloads use a desktop Save As dialog, or a browser file download, while keeping chat and image previews open.
- VM-owned encrypted credentials with secure request forms, and a plugin-style **Skills** library for searching, creating, editing and enabling reusable skills. Import supported text skills from public GitHub links or local `SKILL.md`/ZIP files with a preview, and download a managed skill as a portable ZIP. See [credentials and skills](docs/credentials-and-skills.md).
- Chat search and explicit record editing, withdrawal, deletion and clearing; the model session and context remain intact. Saving an edit does not resubmit work unless you choose **Save and send again**.
- Online and working status, with the last actual task or call activity shown as a relative time.
- Structured diagnostics with automatic three-day retention and bounded disk usage. See [diagnostics](docs/diagnostics.md).
- Application version and a manual **Check for updates** action in Settings, with links to newer GitHub releases. See [updates](docs/updates.md).
- Categorized Settings with bilingual search that opens the matching control. See [settings](docs/settings.md).
- Codex-managed context windows and automatic compaction, without an extra dant token budget. See [context management](docs/context.md).
- The composer microphone opens a voice-message recorder with elapsed time, pause/resume, preview, cancellation and explicit sending. Original audio stays playable in chat; the VM recognizes Chinese and English speech locally and sends it internally to the same model conversation. Telegram voice messages use this path too, without an extra API key. **Speech to text** remains a separate attachment-menu option; the header phone starts a realtime call. See [audio processing](docs/architecture.md#voice).
- A draggable horizontal call bar stays available inside the app. Minimizing the Windows app during a call shows a separate floating desktop bar with the same call controls.

## Run locally

Requires Windows 11, Node.js 22+, Python 3.11+, and OpenSSH. To create a computer automatically, use enabled Hyper-V or an existing VMware Workstation installation with `vmrun` and `vmware-vdiskmanager`. Hyper-V creation requires Windows administrator authorization; the VMware flow does not request Hyper-V elevation. An existing Ubuntu VM can connect over SSH regardless of its hypervisor.

```powershell
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>, or use `start.cmd`.

In Settings, choose **Create work computer**, then **Automatic**, **Hyper-V**, or **VMware Workstation**. Automatic keeps a configured provider; otherwise it prefers available Hyper-V, then VMware. An explicitly selected provider never silently switches after failure. Setup verifies Ubuntu, reports preparation/boot/install progress, and connects after readiness checks pass. Defaults are four CPU cores, 6 GB RAM, and a 40 GB disk. The Hyper-V script equivalent is:

```powershell
./scripts/prepare-vm.ps1
# Optional passwordless administration inside a newly created VM:
./scripts/prepare-vm.ps1 -AdminSudo
# Run this step in administrator PowerShell:
./scripts/create-vm.ps1
./scripts/check-vm.ps1
```

For VMware, use `prepare-vmware.ps1` followed by `create-vmware.ps1` in ordinary PowerShell, then the same `check-vm.ps1`. Workstation is reused rather than installed by dant. See [VMware setup](docs/vmware.md) for exact commands and current verification limits.

The `dant` VM account uses SSH keys. After connecting, initiate ChatGPT device-code sign-in from Settings and authenticate on the official page. Codex credentials remain inside the VM. See [VM setup](docs/VM.md).

Already have an Ubuntu VM, including a VMware VM? Choose **Use existing computer** in Settings. SSH connection and profile import do not create or convert disks. The guest needs a working graphical desktop and the VM runtime prerequisites described in [VM setup](docs/VM.md). A single valid connection found in your registered local profiles is imported automatically; multiple connections require selection. You can also import the directory containing an old `vm.json`, or enter the host, SSH user, port, and private-key path manually. Existing disks, VM chat, and ChatGPT sign-in remain in place. An earlier setup failure does not prevent connecting.

For the Windows desktop build, install Visual Studio C++ Build Tools and Windows SDK, then run:

```powershell
./scripts/setup-tools.ps1
./scripts/build-desktop.ps1
```

Launch the project build with `start-desktop.cmd`. Output is under `src-tauri/target/release/`, with the installer under `bundle/nsis/`.

The desktop launcher uses the same per-user data directory as the installed application, and offers the checkout's old `data/` directory as an import source. An explicitly set `DANT_DATA` still selects a separate profile. Valid profiles used by your Controllers are registered for later discovery; credentials and personal data are never bundled.

## Appearance and Telegram

Settings offers visual previews for light, dark, and system modes; theme presets; accent, background and foreground colors; searchable local fonts; separate interface/content/code text sizes; and reduced-motion preferences. Appearance can be exported and imported as JSON. Changes apply immediately and persist on Windows, including while the VM is offline. Fonts retain Chinese and English fallbacks.

For Telegram, connect the VM and enter a Bot Token obtained from the official [@BotFather](https://t.me/BotFather) into the local Telegram settings. Enable the bot, generate a pairing link, and open it in your own private Telegram chat. Only the paired account can send work; group messages are ignored. New messages, completed replies, and attachments synchronize with the desktop's VM conversation. Existing history is not bulk-exported. See [Telegram setup and sync scope](docs/TELEGRAM.md).

The gateway runs inside the VM using outbound long polling, so no public port is required. It can keep receiving messages after the Windows window closes while the VM remains online. It is disabled until configured.

## Voice channels and verification

The default subscription channel uses Codex Realtime V3, WebRTC, and `gpt-live-1-codex`, using your **subscription allowance** without a separate API key. Availability and limits depend on the account and executor version.

The call panel shows elapsed time after confirmed connection. **Minimize to chat** opens a draggable horizontal bar with the avatar on the left, status and duration in the middle, and call controls on the right. **Expand call** returns to the larger view. Minimizing the Windows app during an active call shows a separate desktop bar, initially at the bottom right above the taskbar. Drag it to move it, or use its expand control to restore the app. Restoring the main window or ending the call hides that bar. Both views control the same audio connection and timer; the desktop bar does not open a second microphone or WebRTC session.

Ending or losing the connection freezes the displayed duration, and the final history record supplies the saved duration. During a confirmed connected call, **Take control** keeps audio connected, pauses queued work and waits for the exact active work to stop and the VM lease to be confirmed before accepting input. Returning control does not replay tasks; give a new call instruction to continue. Connecting, stopping or unconfirmed calls still block new takeover; returning an existing human-control lease remains available.

During a call, typed text belongs to the current voice conversation: dant answers aloud instead of starting a separate text task. Quoted replies include the original speaker and full message, so references such as “this” keep their meaning. Both voice providers save the input as shared conversation context before live delivery; actual computer work uses the existing voice task handoff. Ordinary spoken answers are not automatically copied into chat; requested text, useful links, files and background results can still be delivered there. Reaction updates remain reference-only. A delivery acknowledgment confirms receipt, not comprehension or task completion; unknown delivery is never automatically resent.

Actual testing with ChatGPT sign-in and Codex CLI 0.163.0 confirmed SDP negotiation, a silent WebRTC connection, explicit text tasks during the call, and confirmed hangup. This does **not** establish real microphone capture, speaker playback, continuous interruption behavior, or long-running reliability. Local dictation packages and helper logic were checked without automatically enabling the microphone.

**Optional: separate API voice** is an explicit, separately billed choice. Its key is protected with Windows user DPAPI and used transiently by the VM call process. The default subscription channel does not require it. Paid API voice has not been verified with a paid key. See [voice configuration](docs/VOICE-KEY.md) and [verification records](docs/verification.md).

## Data, checks, and downloads

Windows `data/` holds connection and deployment information, notification records, optional encrypted keys, and an offline cache. The VM owns chat, attachments, and memory under `~/dant/data/`, with deliverables under `~/dant/workspaces/<conversationId>/output/`. Installed builds use per-user application data; source launches use project `data/`. These locations, `.cache/`, and `.tools/` are excluded from Git.

Chat shows a time divider at the start of the conversation, on a new day, and after gaps longer than 30 minutes. Each message's original sent time remains saved. Completed dant replies show **Unread** or **Read**. The sidebar count and **unread messages** shortcut derive from saved receipts; opening a notification or restoring the app does not clear them. Reading requires the actual bubble to remain in view for 450 ms in the focused, foreground text chat. A minimized window, a full call view, another page or an open modal does not mark messages read. Native notification delivery is recorded separately.

Click a file card or a preview's download control to save the original attachment. Windows opens **Save As**, using the attachment's name and extension by default; browser mode starts a file download. Cancelling leaves the current chat or image preview open, and downloading does not navigate away from it.

VM user services can continue submitted work after the Windows window closes; native notifications require the Windows app. Run `npm test` and `npm run build` for local checks. Simulated protocol tests do not replace device acceptance.

Run `npm run test:coverage` to enforce unit coverage and write LCOV, JSON, and Markdown reports under `.cache/coverage/`. Reports are also uploaded by CI. The [documentation index](docs/README.md) links to English guides and their Chinese counterparts.

[GitHub Actions](https://github.com/Stephen-Sim/dant/actions) provides Windows installers, complete portable ZIPs, checksums, and build metadata. See [CI details](docs/ci.md) and [architecture](docs/architecture.md).

## License

This project is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.
