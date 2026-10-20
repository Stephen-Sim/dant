# CI and Windows builds

English · [Chinese](zh-CN/ci.md)

Cross-platform checks and Windows packaging are separate, following the division of responsibilities in [Codex workflows](https://github.com/openai/codex/blob/main/.github/workflows/README.md). The CI, Go core and Windows build workflows run on pushes to every branch, pull requests, and manual dispatch. `master` is the default branch. Tag builds are not cancelled by later runs.

## Checks

UI TypeScript coverage must reach at least 90% of lines, 80% of branches, and 80% of functions overall; appearance also requires 90% lines individually. Every UI helper must appear. Backend coverage now runs against the actual Go implementation: `npm run check:core` runs all package tests with atomic statement coverage, requires every feature package to appear, and enforces at least 90% separately for Controller, Computer (including connection discovery and VM transport), and Telegram. Duplicate instrumented blocks are counted once, and the comparison uses unrounded counts. Go statements and Node lines are reported separately. A fresh private profile is required; a failed process or missing report cannot reuse a previous pass. The browser entrypoint has separate render/handler fixtures because Node does not load its CSS and live DOM. See [test ownership](testing.md).

`CI` runs on Ubuntu 24.04 and Windows 2025 with Node.js 22.18+, Python 3.12 and Go 1.27.2. It installs locked npm dependencies, runs browser/tooling tests, coverage and state checks, tests Python VM helpers, and builds the frontend. `pycdlib==1.14.0` and OpenSSH are required so seed-image and SSH-key tests cannot silently disappear when tools are missing. Windows DPAPI tests use temporary test keys; Linux explicitly skips Windows-only checks.

Browser and tooling modules use TypeScript; production backend features use Go. The strict compiler checks Node sources, browser sources, and tests as separate projects. Node tests are grouped by module under `tests/`; UI tests mirror `ui/`, shared fixtures live in `tests/support/`, and Python VM tests live in `tests/vm/`. Unit tests and coverage use the same recursive discovery helper and a shared limit of four isolated test processes to bound desktop and CI resource usage.

The separate `Go core` workflow runs on Windows and Ubuntu with exactly Go 1.27.2. It verifies generated contracts, `gofmt`, `go vet`, all Go package tests and critical feature coverage. Linux also runs the race detector. Go tests live under the mirrored `tests/go/` tree; the shared runner supplies the explicit compiler overlay for private-package access. Bare `go test ./...` does not discover that external test tree.

`npm run check:states` requires the pinned Go toolchain because it parses adopted Go scopes as well as UI ASTs. Missing scopes, raw state values, invalid reports and mismatched state domains fail closed. The ordinary Node unit tests inject the checker process; the integrated state command runs the real parser. Main CI and Windows packaging both install the pinned compiler.

Go profiles and statement summaries are saved in `.cache/core/coverage.out` and `.cache/core/coverage.json`, uploaded by core CI and Windows packaging. Every feature package must execute at least one statement; zero-hit blocks introduced by `-coverpkg` alone do not count as test execution.

Bash and PowerShell files are parsed without creating a VM or requesting administrator access. Tests do not use real model accounts, open microphones, or contact a configured Telegram bot. Telegram tests inject a simulated Bot API and verify owner pairing, authorization, deduplication, attachment bounds, delivery results, and shutdown.

## Windows artifacts

`Windows build` runs the browser/tooling and Python checks, generated contracts, pinned Go formatting/vet/package tests and coverage, then builds the Go resources and Tauri NSIS installer with Rust 1.99.1 and locked Cargo dependencies. The cache holds dependency/compiler intermediates, not user data, VM images or packaging output. Current artifacts are unsigned.

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
npm run test:coverage
python -m unittest discover -s tests/vm -p "test_*.py" -v
node scripts/ci/version.mts
node --test tests/tooling/build/version.test.mts
node scripts/ci/preflight.mts
pwsh -File scripts/ci/check-powershell.ps1
npm run build
```

Preflight requires Node.js 22.18+ LTS or 24+ with native TypeScript, the pinned pycdlib version, OpenSSH Client and Git Bash on Windows. Resource preparation separately validates the pinned Go compiler and compiled manifests; VM activation verifies its Linux binary, source and existing data. Missing prerequisites fail explicitly. Source coverage does not replace real-device acceptance; see [verification](verification.md).

For local launch, commit reviewed source, run `npm run package:resources`, then `npm start` or `npm run dev`. Both launch the validated compiled Go backend; the latter also starts Vite. Native `desktop` prepares the same resources before opening Tauri. See [runtime support](runtime-support.md). Full tests, real packaged launch and user-device acceptance are separate gates; no completed release is implied by these workflow definitions.
