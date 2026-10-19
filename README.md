<p align="center"><img src="ui/public/brand/dant-logo.svg" width="80" height="80" alt="dant"></p>

# dant

English · [Chinese](docs/zh-CN/README.md)

An AI companion for Windows that talks with you and works on its own Ubuntu computer.

**[Download for Windows](https://github.com/Stephen-Sim/dant/releases/latest)** · [Try Beta](https://github.com/Stephen-Sim/dant/releases) · [Documentation](docs/README.md)

## What you can do

- **Talk or type.** Keep messages, calls, files and results in one conversation.
- **Give dant a computer.** Let it work in an Ubuntu VM, watch its desktop, and take control when you need to.
- **Keep work moving.** Follow task steps, pause or cancel work, reply to a task, and reopen it with its saved context.
- **Build continuity.** Inspect saved memory, add reusable skills, and schedule one-time or repeating tasks.
- **Stay connected.** Use a paired Telegram chat, with configurable unread-only forwarding and grouped replies.

## Get started

You need Windows 11, Python 3.11+, OpenSSH, and Hyper-V or VMware Workstation. An existing Ubuntu desktop VM can also connect over SSH.

1. Download and install dant. For portable use, extract the entire ZIP and open `dant.exe` beside its `backend` folder. Windows packages are unsigned; SHA-256 checksums are included.
2. Open **Settings → Work computer** to create a computer or connect an existing VM. Follow the [setup guide](docs/VM.md).
3. Sign in to ChatGPT from Settings, then send your first task.

Text tasks and default voice use your ChatGPT subscription allowance; voice availability depends on the account. Optional API voice is billed separately. See [voice configuration](docs/VOICE-KEY.md).

## Explore

[Settings](docs/settings.md) · [Telegram](docs/TELEGRAM.md) · [Updates](docs/updates.md) · [Architecture](docs/architecture.md) · [Verification](docs/verification.md)

<details>
<summary>Run from source</summary>

With Node.js 22.18+ LTS / 24+ and the prerequisites above:

```powershell
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>. To build the desktop app, install Visual Studio C++ Build Tools and Windows SDK, then run `scripts/setup-tools.ps1` and `scripts/build-desktop.ps1`. See [development and CI](docs/ci.md).

</details>

[MIT License](LICENSE). Third-party dependencies retain their own licenses.
