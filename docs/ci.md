# CI and Windows builds

English · [Chinese](zh-CN/ci.md)

Cross-platform checks and Windows packaging are separate, following the division of responsibilities in [Codex workflows](https://github.com/openai/codex/blob/main/.github/workflows/README.md). The CI, Go core and Windows build workflows run on pushes to every branch, pull requests, and manual dispatch. `master` is the default branch. Tag builds are not cancelled by later runs.

## Checks

TypeScript coverage must reach at least 90% of lines, 80% of branches, and 80% of functions overall. Connection discovery, the Controller, VM transport, Telegram, and appearance also require 90% line coverage individually. Every server module and UI helper must appear in the report; a newly added module cannot pass just by being omitted from tests. The browser entrypoint has separate render/handler fixtures because Node does not load its CSS and live DOM.

`CI` runs on Ubuntu 24.04 and Windows 2025 with Node.js 22.18+ and Python 3.12. It installs locked npm dependencies, runs TypeScript unit tests and coverage checks, tests Python VM helpers, and builds the frontend. `pycdlib==1.14.0` and OpenSSH are required so seed-image and SSH-key tests cannot silently disappear when tools are missing. Windows DPAPI tests use temporary test keys; Linux explicitly skips Windows-only checks.

Browser, tooling and retained Node compatibility-test modules use TypeScript; production backend features use Go. The strict compiler checks Node sources, browser sources, and tests as separate projects. Node tests are grouped by module under `tests/`; UI tests mirror `ui/`, shared fixtures live in `tests/support/`, and Python VM tests live in `tests/vm/`. Unit tests and coverage use the same recursive discovery helper and a shared limit of four isolated test processes to bound desktop and CI resource usage.

The separate `Go core` workflow runs on Windows and Ubuntu with exactly Go 1.27.2. It verifies generated contracts, `gofmt`, `go vet`, all Go package tests and isolated Node/Go Memory parity. Linux also runs the race detector. Go tests live under the mirrored `tests/go/` tree; the shared `npm run check:core` / `test:core:race` runner supplies the explicit compiler overlay for complete private-package coverage. Bare `go test ./...` does not discover this external test source tree. The explicit parity runner builds a private CGO-free helper and uses fixture-only SQLite snapshots; ordinary Node tests do not require a Go compiler. Latency reports describe the synthetic workload and do not establish a production speed improvement. Production resources now contain separate compiled Go Controller/Worker targets. The shadow reader remains a fixture-only differential tool, with no production execution authority.

Bash and PowerShell files are parsed without creating a VM or requesting administrator access. Tests do not use real model accounts, open microphones, or contact a configured Telegram bot. Telegram tests inject a simulated Bot API and verify owner pairing, authorization, deduplication, attachment bounds, delivery results, and shutdown.

## Windows artifacts

`Windows build` runs the Node/Python checks, generated-contract checks, pinned Go formatting/vet/package tests and Memory parity, then builds the Go runtime resources and a Tauri NSIS installer with Rust 1.99.1 and locked Cargo dependencies. The cache contains dependency and compiler intermediates, not user data, VM images, or packaging output. Current artifacts are unsigned.

CI retains formatting, strict TypeScript and state-contract checks; the Go workflow adds all package checks and Linux race detection. The Windows release job executes its own Go and compatibility gates as well. The Windows packaging job runs these gates itself, so a tag cannot produce a release draft while depending on unchecked results from the separate `CI` workflow.

A successful build uploads an Actions artifact retained for 14 days containing:

- `dant_<version>_windows_x64_setup.exe`: NSIS installer.
- `dant_<version>_windows_x64_portable.zip`: `dant.exe` and its complete adjacent `backend/` directory, including `dant-core.exe`, the Linux Worker executable, frontend, fixed host/VM helpers, protocol JSON, provenance manifests and license. Backend TypeScript, Node executable and `node_modules` are excluded. Keep both together after extraction.
- `dant_<version>_windows_x64_build.json`: version, commit, build URL, Go/Rust versions, build-tool Node version, sizes and SHA-256 hashes. Runtime metadata identifies `go`.
- `SHA256SUMS`: hashes for the installer, ZIP, and metadata. Run `sha256sum --check SHA256SUMS` after downloading.

Go resources are built with pinned Go 1.27.2, `CGO_ENABLED=0`, `-trimpath` and explicit version/source metadata from a clean commit. Build, VM-bundle and complete resource manifests verify fixed paths, lengths and SHA-256 before copying or packaging; host helpers and UI are covered too. Source mutation during compilation or a stale/tampered binary fails preparation. A published asset is never overwritten.

Builds require matching versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Update their lockfiles as well. A release tag must exactly match `v<version>`; mismatches fail before compilation.

## Draft releases

Only pushes of `v*` tags enter the separate draft-release job after successful tests and packaging. The job verifies downloaded hashes, version, commit, and tag before creating a GitHub Release draft. A rerun may replace an existing draft's assets, but refuses to overwrite a published release. Maintainers review and publish drafts manually. Pull requests and workflow dispatch do not create releases.

Normal jobs have `contents: read`; only the draft-release job receives `contents: write`. Workflows need no OpenAI or Telegram credentials. Actions are pinned to full commit hashes; update the version comment when changing a pin.

## Local checks

```powershell
npm run format:check
npm run typecheck
npm run check:states
npm run check:contracts
npm run check:core
npm run test:core:parity
npm run test:coverage
python -m unittest discover -s tests/vm -p "test_*.py" -v
node scripts/ci/version.mts
node --test scripts/ci/version.test.mts
node scripts/ci/preflight.mts
pwsh -File scripts/ci/check-powershell.ps1
npm run build
```

Preflight requires Node.js 22.18+ LTS or 24+ with native TypeScript, built-in SQLite and FTS5, plus the pinned pycdlib version, OpenSSH Client, and Git Bash on Windows. A bounded in-memory FTS5 query verifies actual runtime capabilities; a version string alone is insufficient. This Node gate belongs to UI/tooling/reference tests, not the deployed Go Worker. Resource preparation separately validates the pinned Go compiler and compiled artifact manifests; VM activation verifies its Linux binary, source provenance and existing data before startup. GitHub-hosted runners supply the base tools; a missing prerequisite fails explicitly. Coverage reports describe unit-test execution, not real-device acceptance. See [verification](verification.md).

For local launch, commit reviewed source, run `npm run package:resources`, then `npm start` or `npm run dev`. Both launch the validated compiled Go backend; the latter also starts Vite. Native `desktop` prepares the same resources before opening Tauri. See [runtime support](runtime-support.md). Full tests, real packaged launch and user-device acceptance are separate gates; no completed release is implied by these workflow definitions.
