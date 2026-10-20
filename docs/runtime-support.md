# Runtime support

English · [Chinese](zh-CN/runtime-support.md)

The runtime is **Go Controller + Go Ubuntu Worker + Rust Tauri host + TypeScript UI**. Source checks, artifact integrity and real-device acceptance have separate evidence requirements; see [verification](verification.md).

## Installed application

| Component        | Requirement and ownership                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows desktop  | Tauri 2 with Windows WebView2, the bundled `dant-core.exe`, fixed host helpers and an available configured VM provider.                        |
| Ubuntu Worker    | Bundled Linux amd64 Go executable, ordinary VM user, systemd user service, working graphical desktop and Python desktop helpers.               |
| Codex App Server | Separately installed pinned Codex CLI, existing authenticated account/configuration and stdio JSON-RPC. It owns reasoning and tool iterations. |
| Transport        | Authenticated loopback API and SSH forwarding. Existing SSH alone does not imply a suspend/resume-capable provider.                            |
| Data             | Original state files, SQLite memory/schedules, Skills, workspace and protected secrets. No external database service is required.              |

The installed Core runs from its bundled Go executables and does not load `.env.example`. Optional local `.env` uses validated defaults when absent. Codex installation or user-authored tools may independently require Node/npm.

Windows remains the desktop release target. HostPlatform/VMProvider capability adapters prepare for other hosts, but they do not establish a supported macOS or Linux desktop installer. The Linux executable is currently packaged for the Ubuntu Worker and isolated tooling, not evidence of complete Linux desktop acceptance.

## Build and test tools

| Tool                   | Repository requirement                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Go                     | Exactly 1.27.2, pinned dependencies, `GOTOOLCHAIN=local`. Production builds use `CGO_ENABLED=0`.       |
| Node                   | 22.18+ LTS or 24+ with native TypeScript, for browser tests and development/build tooling.             |
| npm                    | Locked dependencies through `npm ci`, including the repository's Prettier and Vite.                    |
| Rust                   | Packaging workflow's pinned 1.99.1 toolchain with rustfmt and locked Cargo dependencies.               |
| Python and shell tools | Python 3.12 CI, `pycdlib==1.14.0`, OpenSSH, Bash and PowerShell for existing isolated VM/helper gates. |
| Linux race checks      | A working C compiler for Go's race detector; this does not change CGO-free production builds.          |

The compiler lookup prefers `.tools/go1.27.2/go/bin`, then verifies the PATH compiler. It does not download another compiler automatically. See [CI](ci.md) and [code style](code-style.md).

## Development launch

Commit reviewed source before building production resources. Version/source metadata must identify the bytes being compiled; a dirty tree or mismatching CI SHA fails preparation.

```powershell
npm ci
npm run package:resources
npm start
# Or use the same validated compiled backend with Vite:
npm run dev
```

Preparation builds the UI and Windows/Linux binaries and stages the verified runtime under `src-tauri/resources` (or the configured Cargo resources location). The native debug host uses that prepared root and keeps development data separate. `npm start` and `npm run dev` validate prepared manifests and require rebuilding from a clean commit when backend resources change.

The portable ZIP keeps `dant.exe` beside its complete `backend/` directory, containing Go executables, UI, fixed helpers, protocol JSON, licenses and provenance manifests. Secrets and runtime state are excluded. Replacing individual binaries requires rebuilding and verifying their manifests.

## VM update compatibility

The Controller verifies the Linux bundle, fences new admission and confirms the current executor stopped before updating. Offline data preparation requires a complete validated private backup. The new service proves its version and source before becoming current. Unknown stops, incompatible data, missing backups or mismatched source block activation.

Closing the window can leave work running in the tray. Explicit Exit pauses work and suspends an owned managed VM after confirmation; service updates keep the VM powered while replacing its service. See [Go Core](go-core.md), [VM setup](VM.md), [updates](updates.md) and [backups](backups.md).
