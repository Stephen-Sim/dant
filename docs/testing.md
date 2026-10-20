# Testing

English · [Chinese](zh-CN/testing.md)

Tests follow the production owner: Go for Core behavior, TypeScript for browser and build tools, Rust for native behavior, and Python/PowerShell for VM helpers. They use synthetic data and injected services rather than a configured VM, real model, microphone or Telegram account.

## Layout and entrypoints

| Directory                        | Responsibility                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `tests/go/<package>/`            | Go behavioral, persistence, concurrency and failure tests, mirroring `core/<package>/`. |
| `tests/ui/<feature>/`            | Browser rendering, interaction and wire validation, mirroring `ui/<feature>/`.          |
| `tests/tooling/<module>/`        | Build, configuration, generated contracts, Go tooling and CI scripts.                   |
| `tests/native/`                  | Browser/native integration contracts; Rust behavioral tests also run through Cargo.     |
| `tests/vm/`                      | Isolated Python and PowerShell VM helper checks.                                        |
| `tests/support/`, `tests/types/` | Shared synthetic fixtures and compile-time contracts.                                   |

Keep discovery recursive. `npm test` and `npm run test:coverage` use the same maintained TypeScript test inventory. Go commands validate every mirrored test mapping and pass Go's explicit `-overlay` option. This preserves package-private access and platform suffixes without exporting internals for tests. Bare `go test ./...` from `core/` does not discover `tests/go/`.

## Go Core behavior

| Owner                                       | Required behavior and failure coverage                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller and Computer                     | Offline configuration, authentication, exact VM/binding identity, proxies, lifecycle, deployment and unconfirmed stops.                     |
| Work, Store and Runtime                     | One admission owner, durable work, pause/cancel, continuation, credential waits, RPC correlation and unknown outcomes.                      |
| History and Files                           | Conversation scope, read/delivery receipts, immutable attachment IDs, verified bytes and target-root resolution.                            |
| Memory                                      | SQLite schemas/revisions, normalized and multilingual search, scope-before-limit, confirmation, sensitive-data boundaries and cancellation. |
| Schedules                                   | Occurrence claims, revisions, DST/catch-up, restart recovery and no-replay dispatch receipts.                                               |
| Voice and Telegram                          | Call identity, work after hangup, captions, media bounds, paired-owner authorization, delivery receipts and joined shutdown.                |
| Skills                                      | Complete file preservation, editor/JSON/ZIP capacity, imports, credential boundaries and authenticated downloads.                           |
| Backups and Application                     | Authenticated archives, complete staged capture, cross-root restore, offline proof, activation, rollback and uncertain results.             |
| Security, Diagnostics, Settings and Updates | Secret boundaries, bounded records, concurrent persistence, preferences and target-bound installation leases.                               |

Assert public results, persisted state and bounded side effects. Failure fixtures must distinguish confirmed failure, cancellation and unknown execution; an error alone is not proof that an external operation never happened. Do not replace realistic capacity, concurrency or restore tests with smaller implementation-shaped checks.

## Gates

`npm run check:core` runs pinned formatting, vet and all Go package tests with atomic statement coverage. Every feature package must have actual executed statements. Controller, Computer and Telegram each require at least **90%**; missing packages, stale profiles or failed test processes cannot reuse prior results. Linux CI also runs `npm run test:core:race` with a working C compiler.

Browser coverage requires **90% lines, 80% branches and 80% functions**, with appearance individually at 90% lines. Every maintained UI helper must appear. Go statements and browser lines are separate metrics and must not be combined. The browser entrypoint also has DOM/render/handler fixtures; percentage coverage alone does not validate layout or a packaged native window.

Use exactly Go **1.27.2**, the declared Rust toolchain, locked npm dependencies and the supported Node native-TypeScript baseline. Full checks:

```powershell
npm run format:check
npm run typecheck
npm run check:states
npm run check:contracts
npm run check:core
npm run test:coverage
python -m unittest discover -s tests/vm -p "test_*.py" -v
cargo test --manifest-path src-tauri/Cargo.toml --locked
node scripts/ci/preflight.mts
pwsh -File scripts/ci/check-powershell.ps1
node scripts/ci/version.mts
npm run build
```

Use `npm run format` when changing maintained files. Run focused tests while working and the complete relevant gates before integration. Missing tools, platform-specific exclusions and actual failures must be reported, never described as passing.

Source checks, verified release artifacts and real-device acceptance are separate. See [CI](ci.md) and [verification](verification.md).
