# Runtime support

English · [Chinese](zh-CN/runtime-support.md)

The source runtime is **Go Controller + Go Ubuntu Worker + Rust Tauri host + TypeScript UI**. A source change or passing fixture does not mean the corresponding installer has been released or accepted on a real VM.

## Installed application

| Component        | Requirement and ownership                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows desktop  | Tauri 2 with Windows WebView2, the bundled `dant-core.exe`, fixed host helpers and an available configured VM provider.                        |
| Ubuntu Worker    | Bundled Linux amd64 Go executable, ordinary VM user, systemd user service, working graphical desktop and Python desktop helpers.               |
| Codex App Server | Separately installed pinned Codex CLI, existing authenticated account/configuration and stdio JSON-RPC. It owns reasoning and tool iterations. |
| Transport        | Authenticated loopback API and SSH forwarding. Existing SSH alone does not imply a suspend/resume-capable provider.                            |
| Data             | Original state files, SQLite memory/schedules, Skills, workspace and protected secrets. No external database service is required.              |

The installed dant backend needs neither Node 22 native TypeScript nor `node:sqlite`, and it does not load `.env.example`. Optional local `.env` uses validated defaults when absent. Codex installation or user-authored tools may independently use Node/npm; removing dant's Node backend does not remove those tools.

Windows remains the desktop release target. HostPlatform/VMProvider capability adapters prepare for other hosts, but they do not establish a supported macOS or Linux desktop installer. The Linux executable is currently packaged for the Ubuntu Worker and isolated tooling, not evidence of complete Linux desktop acceptance.

## Build and test tools

| Tool                   | Repository requirement                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Go                     | Exactly 1.27.2, pinned dependencies, `GOTOOLCHAIN=local`. Production builds use `CGO_ENABLED=0`.                                |
| Node                   | 22.18+ LTS or 24+ with native TypeScript, built-in SQLite and FTS5, for UI/build tooling and fixture-only compatibility checks. |
| npm                    | Locked dependencies through `npm ci`, including the repository's Prettier and Vite.                                             |
| Rust                   | Packaging workflow's pinned 1.99.1 toolchain with rustfmt and locked Cargo dependencies.                                        |
| Python and shell tools | Python 3.12 CI, `pycdlib==1.14.0`, OpenSSH, Bash and PowerShell for existing isolated VM/helper gates.                          |
| Linux race checks      | A working C compiler for Go's race detector; this does not change CGO-free production builds.                                   |

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

Preparation builds the UI and Windows/Linux binaries and stages the verified runtime under `src-tauri/resources` (or the configured Cargo resources location). The native debug host uses that prepared resource root and keeps development data separate in the project data directory. `npm start` and `npm run dev` validate prepared manifests; they do not compile uncommitted backend changes or start the retired Node server. Rebuild from a clean commit when backend resources change.

The portable ZIP keeps `dant.exe` beside its complete `backend/` directory. That directory contains Go executables, UI, fixed helpers, protocol JSON, license and provenance manifests. It excludes backend TypeScript, `node_modules`, Node executable, `.env` and private runtime state. Do not separate or replace individual binaries without rebuilding and verifying their manifests.

## VM update compatibility

The Controller verifies the Linux bundle before an update, pauses work through the existing maintenance path and confirms the old executor stopped. Offline preparation requires a validated private backup of existing data. The new service reports version and source proof before the Controller marks it ready. Unknown stops, incompatible data, missing backup or mismatching source block activation. There is no automatic fallback to the old Node executor.

Closing the window can leave work running in the tray. Explicit Exit pauses work and suspends an owned managed VM after confirmation; service updates keep the VM powered while replacing its service. See [migration](go-core-migration.md), [VM setup](VM.md), [updates](updates.md) and [backups](backups.md).
