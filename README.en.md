# dant

[简体中文](README.md) · English

A digital companion for Windows, with its own Ubuntu computer. This rebuild follows the original UI and architecture, using Tauri/Rust, Node.js, Hyper-V, and Codex App Server.

The **Windows Controller → Ubuntu authoritative Worker** boundary keeps execution and conversation data inside the VM. Windows provides the interface, VM setup, SSH forwarding, offline display cache, and native notifications. It does not run the agent’s work commands.

## Features

- Persistent chat with Markdown, files, replies, reactions, and distinct delivery, execution, and read receipts.
- Chinese and English interfaces, remembered language preferences, and a resizable computer panel.
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

For the Windows desktop build, install Visual Studio C++ Build Tools and Windows SDK, then run:

```powershell
./scripts/setup-tools.ps1
./scripts/build-desktop.ps1
```

Launch the project build with `start-desktop.cmd`. Output is under `src-tauri/target/release/`, with the installer under `bundle/nsis/`.

## Voice channels and verification

The default subscription channel uses Codex Realtime V3, WebRTC, and `gpt-live-1-codex`, using your **subscription allowance** without a separate API key. Availability and limits depend on the account and executor version.

Actual testing with ChatGPT sign-in and Codex CLI 0.163.0 confirmed SDP negotiation, a silent WebRTC connection, explicit text tasks during the call, and confirmed hangup. This does **not** establish real microphone capture, speaker playback, continuous interruption behavior, or long-running reliability. Local dictation packages and helper logic were checked without automatically enabling the microphone.

**Optional: separate API voice** is an explicit, separately billed choice. Its key is protected with Windows user DPAPI and used transiently by the VM call process. The default subscription channel does not require it. Paid API voice has not been verified with a paid key. See [voice configuration](docs/VOICE-KEY.md) and [verification records](docs/verification.md).

## Data, checks, and downloads

Windows `data/` holds connection and deployment information, notification records, optional encrypted keys, and an offline cache. The VM owns chat, attachments, and memory under `~/dant/data/`, with deliverables under `~/dant/workspaces/<conversationId>/output/`. Installed builds use per-user application data; source launches use project `data/`. These locations, `.cache/`, and `.tools/` are excluded from Git.

VM user services can continue submitted work after the Windows window closes; native notifications require the Windows app. Run `npm test` and `npm run build` for local checks. Simulated protocol tests do not replace device acceptance.

[GitHub Actions](https://github.com/Stephen-Sim/dant/actions) provides Windows installers, complete portable ZIPs, checksums, and build metadata. See [CI details](docs/ci.md) and [architecture](docs/architecture.md).
