# dant

English · [简体中文](docs/zh-CN/README.md)

A digital companion for Windows, with its own Ubuntu computer. This rebuild follows the original UI and architecture, using Tauri/Rust, Node.js, Hyper-V, and Codex App Server.

The **Windows Controller → Ubuntu authoritative Worker** boundary keeps execution and conversation data inside the VM. Windows provides the interface, VM setup, SSH forwarding, offline display cache, and native notifications. It does not run the agent’s work commands.

## Features

- Persistent chat with Markdown, files, replies, reactions, and distinct delivery, execution, and read receipts.
- Chinese and English interfaces, light/dark/system themes, font and text-size preferences, and a resizable computer panel.
- Paired Telegram Bot private chats, sharing the VM conversation, tasks, and files with the desktop app.
- Serial VM tasks with pause, explicit resume, review, and acceptance; uncertain submissions are never automatically replayed.
- VM memory, scheduled tasks, shared desktop control with an expiring lease, and unread completion notifications.
- Up to five attachments per message, each at most 10 MiB, plus automatic delivery of eligible changed files from `output/`.
- User-triggered dictation into the draft and assistant read-aloud. Windows uses local speech helpers; browser support varies. Recording an audio attachment remains a separate option.

## Run locally

Requires Windows 11, Node.js 22+, Python 3.11+, and enabled Hyper-V. VM management requires Windows administrator authorization.

```powershell
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>, or use `start.cmd`.

In Settings, choose **Create work computer**. Setup downloads and verifies Ubuntu, requests Windows authorization, reports progress, and connects when ready. Defaults are four CPU cores, 6 GB RAM, and a 40 GB dynamic disk. Equivalent scripts are:

```powershell
./scripts/prepare-vm.ps1
# Optional passwordless administration inside a newly created VM:
./scripts/prepare-vm.ps1 -AdminSudo
# Run this step in administrator PowerShell:
./scripts/create-vm.ps1
./scripts/check-vm.ps1
```

The `dant` VM account uses SSH keys. After connecting, initiate ChatGPT device-code sign-in from Settings and authenticate on the official page. Codex credentials remain inside the VM. See [VM setup](docs/VM.md).

Already have a VM? Choose **Use existing computer** in Settings. A single valid connection found in your registered local profiles is imported automatically; multiple connections require selection. You can also import the directory containing an old `vm.json`, or enter the host, SSH user, port, and private-key path manually. Existing disks, VM chat, and ChatGPT sign-in remain in place. An earlier setup failure does not prevent connecting.

For the Windows desktop build, install Visual Studio C++ Build Tools and Windows SDK, then run:

```powershell
./scripts/setup-tools.ps1
./scripts/build-desktop.ps1
```

Launch the project build with `start-desktop.cmd`. Output is under `src-tauri/target/release/`, with the installer under `bundle/nsis/`.

The desktop launcher uses the same per-user data directory as the installed application, and offers the checkout's old `data/` directory as an import source. An explicitly set `DANT_DATA` still selects a separate profile. Valid profiles used by your Controllers are registered for later discovery; credentials and personal data are never bundled.

## Appearance and Telegram

Settings offers light, dark, and system themes; system, sans-serif, and monospace fonts; and text sizes from 12 to 18. Changes apply immediately and persist on Windows, including while the VM is offline. Fonts include Chinese and English fallbacks.

For Telegram, connect the VM and enter a Bot Token obtained from the official [@BotFather](https://t.me/BotFather) into the local Telegram settings. Enable the bot, generate a pairing link, and open it in your own private Telegram chat. Only the paired account can send work; group messages are ignored. Text, attachments, and replies use the same VM conversation. See [Telegram setup](docs/TELEGRAM.md).

The gateway runs inside the VM using outbound long polling, so no public port is required. It can keep receiving messages after the Windows window closes while the VM remains online. It is disabled until configured.

## Voice channels and verification

The default subscription channel uses Codex Realtime V3, WebRTC, and `gpt-live-1-codex`, using your **subscription allowance** without a separate API key. Availability and limits depend on the account and executor version.

Actual testing with ChatGPT sign-in and Codex CLI 0.163.0 confirmed SDP negotiation, a silent WebRTC connection, explicit text tasks during the call, and confirmed hangup. This does **not** establish real microphone capture, speaker playback, continuous interruption behavior, or long-running reliability. Local dictation packages and helper logic were checked without automatically enabling the microphone.

**Optional: separate API voice** is an explicit, separately billed choice. Its key is protected with Windows user DPAPI and used transiently by the VM call process. The default subscription channel does not require it. Paid API voice has not been verified with a paid key. See [voice configuration](docs/VOICE-KEY.md) and [verification records](docs/verification.md).

## Data, checks, and downloads

Windows `data/` holds connection and deployment information, notification records, optional encrypted keys, and an offline cache. The VM owns chat, attachments, and memory under `~/dant/data/`, with deliverables under `~/dant/workspaces/<conversationId>/output/`. Installed builds use per-user application data; source launches use project `data/`. These locations, `.cache/`, and `.tools/` are excluded from Git.

VM user services can continue submitted work after the Windows window closes; native notifications require the Windows app. Run `npm test` and `npm run build` for local checks. Simulated protocol tests do not replace device acceptance.

Run `npm run test:coverage` to enforce unit coverage and write LCOV, JSON, and Markdown reports under `.cache/coverage/`. Reports are also uploaded by CI. The [documentation index](docs/README.md) links to English guides and their Chinese counterparts.

[GitHub Actions](https://github.com/Stephen-Sim/dant/actions) provides Windows installers, complete portable ZIPs, checksums, and build metadata. See [CI details](docs/ci.md) and [architecture](docs/architecture.md).

## License

This project is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.
