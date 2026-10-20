# Local configuration

English · [Chinese](zh-CN/configuration.md)

Copy [`.env.example`](../.env.example) to `.env` at the repository root. The development launcher and Vite load it before starting the compiled Go Controller; existing process environment variables take priority. `.env` and private variants are ignored by Git and excluded from VM archives and desktop resources.

| Variable          | Default     | Purpose                           |
| ----------------- | ----------- | --------------------------------- |
| `DANT_HOST`       | `127.0.0.1` | Local development API host.       |
| `DANT_PORT`       | `4317`      | Local development API port.       |
| `DANT_DEV_PORT`   | `4318`      | Vite development port.            |
| `DANT_GUEST_HOST` | `127.0.0.1` | VM graphical desktop bridge host. |
| `DANT_GUEST_PORT` | `4320`      | VM graphical desktop bridge port. |

Hosts accept only `127.0.0.1` or `localhost`; ports must be integers from 1 to 65535. The deployed guest port cannot equal the VM API or bootstrap bridge port. A malformed value stops configuration rather than silently falling back. Go [`config`](../core/internal/config/network.go) owns runtime endpoint validation and VM deployment settings; [`scripts/config`](../scripts/config/network.mts) validates only build/development endpoints. Health, screen and action URLs use the runtime values.

Native desktop IPC and the SSH-forwarded VM API keep the fixed port `4317`. These are protocol constants, not development preferences. VM deployment includes only the two public guest settings in its manifest and applies them to both worker and guest services. Changing those settings changes the deployment fingerprint; `.env` itself is never copied. Keep credentials in the existing protected settings facilities.

## Configuration ownership

| Kind                                      | Source                                                   | Rule                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Development and public deployment options | `.env`, read through the owning configuration boundary   | Validate once before assembling services; existing process values take priority.                                                                             |
| User preferences                          | Existing Settings storage and authenticated settings API | Language, appearance and backup mode/interval remain user settings.                                                                                          |
| Shared native transport contract          | `resources/config/protocol.json`                         | One source for loopback endpoints and routes across Go, Rust, Python and browser/tooling consumers.                                                          |
| New computer resource defaults and bounds | `resources/config/computer.json`                         | One source for creation forms and Go, PowerShell and Python launchers; explicit user choices still take priority. Existing computers retain their resources. |
| Fixed protocol and safety limits          | Named constants in the owning feature                    | Do not add environment overrides for authorization rules, byte limits, allowed routes or execution ownership.                                                |

`npm run generate:contracts` updates the embedded Go protocol and the network fields in Tauri configuration; `npm run check:contracts` rejects drift. Rust reads the embedded canonical protocol, and Python's `vm/network_config.py` validates it for source checkouts, the seed image and installed helpers. Seed images include that resource. Each readiness check selects its service's canonical endpoint; the bootstrap and deployed bridges have separate ports. The Go deployer's first-connection probes embed their Python source and receive the validated native endpoint and routes explicitly, so they also work before a helper has been installed.

The canonical protocol requires the fixed primary loopback address, the exact loopback allowlist, distinct valid ports, and bounded, unique rooted paths. JSON duplicate fields, unknown keys and invalid values are rejected. Changing a shared protocol value is a source/build contract change; it is separate from changing a development `.env` preference. Tauri's development window uses the generated canonical development endpoint, while standalone Vite uses `DANT_DEV_PORT`.

New computers default to 4 CPUs, 8GiB memory and 64GiB disk. Each resource has one `default`, `min` and `max` in the computer resource file. Creation validates selected sizes before invoking a provider. These are creation defaults, not a request to resize an existing VM, and seed descriptions are not proof of a running VM's actual resources.

The seed image's system service uses the canonical `bootstrapGuestPort` (`4319`), while the installed user's desktop bridge defaults to `guestPort` (`4320`). They share the same control lease and use separate listeners, so installing the Worker does not need permission to stop the system service. Bootstrap readiness probes use the bootstrap endpoint; deployed Worker probes use the configured guest endpoint. `scripts/check-vm.ps1` verifies the initial seed services and is not a replacement for deployed Worker acceptance checks.

See [code conventions](code-style.md) for the distinction between configuration, domain enums and fixed security constants.

The installed application needs no `.env`: absent files use built-in defaults. `.env.example` is a template, never a runtime fallback.

SSH defaults to the named protocol constant `22`; each saved computer connection can select its own SSH port in Settings. The API and Vite environment ports do not change that connection setting.

`DANT_DATA` and `DANT_WORKSPACE_ROOT` can select explicit storage locations; the corresponding Go startup flags take precedence. Leave them absent for the normal dynamically resolved user paths. The native host captures its `DANT_DATA` override once at startup. Changing a path does not transfer existing data or restore a backup; use the supported backup and restore workflow for that.

## Worker data

The deployed Worker's default data root is `~/dant/data/`. Relative paths below stay inside its configured data directory; they are private runtime data, not repository files or `.env` settings.

| Path                         | Authority                                                          |
| ---------------------------- | ------------------------------------------------------------------ |
| `state.json`                 | Chat messages, durable work and read/delivery/submission receipts. |
| `memory/dant/memory.sqlite`  | Durable notes, confirmed memory and retained project context.      |
| `schedules/schedules.sqlite` | Schedules, creation-request tombstones and dispatch fences.        |

Legacy schedule imports create a backup beside the schedule database and run once. Memory Markdown files are explicit import/export snapshots after migration. Do not restore an old JSON/Markdown copy over a newer database; see [persistence and recovery](architecture.md#persistence-and-lifecycle).
