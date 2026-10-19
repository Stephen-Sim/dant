# Local configuration

English · [Chinese](zh-CN/configuration.md)

Copy [`.env.example`](../.env.example) to `.env` at the repository root. The server and Vite load it for local development; existing process environment variables take priority. `.env` and private variants are ignored by Git and excluded from VM archives and desktop resources.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DANT_HOST` | `127.0.0.1` | Local development API host. |
| `DANT_PORT` | `4317` | Local development API port. |
| `DANT_DEV_PORT` | `4318` | Vite development port. |
| `DANT_GUEST_HOST` | `127.0.0.1` | VM graphical desktop bridge host. |
| `DANT_GUEST_PORT` | `4320` | VM graphical desktop bridge port. |

Hosts accept only `127.0.0.1` or `localhost`; ports must be integers from 1 to 65535. A malformed value stops configuration rather than silently falling back. The shared configuration module constructs health, screen and action URLs from these validated values.

Native desktop IPC and the SSH-forwarded VM API keep the fixed port `4317`. These are protocol constants, not development preferences. VM deployment includes only the two public guest settings in its manifest and applies them to both worker and guest services. Changing those settings changes the deployment fingerprint; `.env` itself is never copied. Keep credentials in the existing protected settings facilities.

See [code conventions](code-style.md) for the distinction between configuration, domain enums and fixed security constants.
