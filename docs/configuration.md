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

Hosts accept only `127.0.0.1` or `localhost`; ports must be integers from 1 to 65535. A malformed value stops configuration rather than silently falling back. Go [`config`](../core/internal/config/network.go) owns runtime endpoint validation and VM deployment settings; [`scripts/config`](../scripts/config/network.mts) validates only build/development endpoints. Health, screen and action URLs use the runtime values.

Native desktop IPC and the SSH-forwarded VM API keep the fixed port `4317`. These are protocol constants, not development preferences. VM deployment includes only the two public guest settings in its manifest and applies them to both worker and guest services. Changing those settings changes the deployment fingerprint; `.env` itself is never copied. Keep credentials in the existing protected settings facilities.

See [code conventions](code-style.md) for the distinction between configuration, domain enums and fixed security constants.

The installed application needs no `.env`: absent files use built-in defaults. `.env.example` is a template, never a runtime fallback.

## Worker data

The deployed Worker's default data root is `~/dant/data/`. Relative paths below stay inside its configured data directory; they are private runtime data, not repository files or `.env` settings.

| Path                         | Authority                                                          |
| ---------------------------- | ------------------------------------------------------------------ |
| `state.json`                 | Chat messages, durable work and read/delivery/submission receipts. |
| `memory/dant/memory.sqlite`  | Durable notes, confirmed memory and retained project context.      |
| `schedules/schedules.sqlite` | Schedules, creation-request tombstones and dispatch fences.        |

Legacy schedule imports create a backup beside the schedule database and run once. Memory Markdown files are explicit import/export snapshots after migration. Do not restore an old JSON/Markdown copy over a newer database; see [persistence and recovery](architecture.md#persistence-and-lifecycle).
