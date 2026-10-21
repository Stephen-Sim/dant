# CI and Windows builds

English · [Chinese](zh-CN/ci.md)

Cross-platform checks and Windows packaging are separate, following the division of responsibilities in [Codex workflows](https://github.com/openai/codex/blob/main/.github/workflows/README.md). The CI, Go core and Windows build workflows run on pushes to every branch, pull requests, and manual dispatch. `master` is the default branch. Tag builds are not cancelled by later runs.

## Checks

Coverage is measured separately for TypeScript, Go Core, native Rust, Python, PowerShell and Bash. Each report names its actual source scope; running TypeScript tests through Node does not measure the other languages. Test totals and successful test processes are behavioral evidence, not coverage percentages. Never average the runtimes into one percentage.

UI TypeScript coverage must reach at least 90% of lines, 80% of branches, and 80% of functions overall; appearance also requires 90% lines individually. Every UI helper must appear. `npm run check:core` runs all Go package tests with atomic statement coverage, requires every feature package to appear, and enforces at least 90% separately for Controller, Computer (including connection discovery and VM transport), and Telegram. Duplicate instrumented blocks are counted once, and the comparison uses unrounded counts. A fresh private profile is required; a failed process or missing report cannot reuse a previous pass. Isolated DOM integration tests load the complete browser entrypoint with synthetic API, media and timer boundaries; its executable source also appears in the full TypeScript report. See [test ownership](testing.md).

`CI` runs on Ubuntu 24.04 and Windows 2025 with Node.js 22.18+, Python 3.12 and Go 1.27.2. It installs locked npm dependencies, runs browser/tooling tests, coverage and state checks, tests Python VM helpers, and builds the frontend. `pycdlib==1.14.0` and OpenSSH are required so seed-image and SSH-key tests cannot silently disappear when tools are missing. Windows DPAPI tests use temporary test keys; Linux explicitly skips Windows-only checks.

Browser and tooling modules use TypeScript; production backend features use Go. The strict compiler checks Node sources, browser sources, and tests as separate projects. Node tests are grouped by module under `tests/`; UI tests mirror `ui/`, shared fixtures live in `tests/support/`, and Python VM tests live in `tests/vm/`. Unit tests and coverage use the same recursive discovery helper and a shared limit of four isolated test processes to bound desktop and CI resource usage.

The separate `Go core` workflow runs on Windows and Ubuntu with exactly Go 1.27.2. It verifies generated contracts, `gofmt`, `go vet`, all Go package tests and critical feature coverage. Linux also runs the race detector. Go tests live under the mirrored `tests/go/` tree; the shared runner supplies the explicit compiler overlay for private-package access. Bare `go test ./...` does not discover that external test tree.

`npm run check:states` requires the pinned Go toolchain because it parses adopted Go scopes as well as UI ASTs. Missing scopes, raw state values, invalid reports and mismatched state domains fail closed. The ordinary Node unit tests inject the checker process; the integrated state command runs the real parser. Main CI and Windows packaging both install the pinned compiler.

Go profiles and statement summaries are saved in `.cache/core/coverage.out`, `.cache/core/coverage.json` and `.cache/core/coverage.md`, uploaded by core CI and Windows packaging. Every feature package must execute at least one statement; zero-hit blocks introduced by `-coverpkg` alone do not count as test execution. The overall percentage is weighted by covered/total unique statements, not the arithmetic mean of package percentages. The report lists every discovered package and the separate critical-package gates.

## Coverage reports

Coverage summaries append a separate language heading to GitHub's job summary through `GITHUB_STEP_SUMMARY`. The Windows packaging job displays these reports together and uploads raw measurements as Actions artifacts; the Go core workflow also publishes its own statement report. Read each report's source scope and covered/total counts rather than interpreting TypeScript results as whole-application coverage.

| Area                               | Metric                                                                                | Reports                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Browser TypeScript                 | UI lines, branches and functions; the existing UI gate remains independent.           | `.cache/coverage/` LCOV, JSON and Markdown.                                   |
| TypeScript tooling and entrypoints | Maintained executable source, including unloaded files as zero.                       | `.cache/coverage/typescript/coverage-final.json`, `lcov.info`, `coverage.md`. |
| Go Core                            | Atomic executable statements, overall and per package.                                | `.cache/core/coverage.out`, `coverage.json`, `coverage.md`.                   |
| Native Rust                        | LLVM source lines, functions and regions.                                             | `.cache/coverage/rust/coverage.json`, `lcov.info`, `coverage.md`.             |
| Python helpers                     | Executable lines and branch arcs; at least 95% lines and 90% branches.                | `.cache/coverage/python/coverage.json`, `coverage.xml`, `coverage.md`.        |
| PowerShell                         | Executable commands measured by Pester, including zero-hit scripts; at least 95%.     | `.cache/coverage/powershell/coverage.json`, `coverage.xml`, `coverage.md`.    |
| Bash                               | Executed shell lines measured by pinned kcov 43 on Linux, including zero-hit scripts. | `.cache/coverage/bash/coverage.json`, `summary.json`, `coverage.md`.          |

The improvement target is close to 100% across maintained executable source, reached by meaningful tests of uncovered behavior and failure paths. Preserve existing minimums. Do not raise percentages by excluding files, treating skipped platforms as executed, or inventing thresholds or results. Unavailable instrumentation and unmeasured scripts remain visible gaps. HTML/CSS and generated declarations are not executable-language coverage. Coverage does not prove successful operation of real hardware or external services.

`npm run coverage:inventory` writes `.cache/coverage/inventory.json` and `inventory.md` and appends the source index to the job summary. It records source commit/dirty status, platform and raw-report SHA-256, checks whether source changed after a report, and lists measured, zero-hit and unmeasured files separately. Ordinary cross-platform CI does not run every native collector; those rows remain unmeasured rather than making the inventory fail or inventing full coverage. Invalid reports and unsafe source paths still fail.

Native coverage uses Rust 1.99.1 with `llvm-tools-preview` and locked `cargo-llvm-cov` 0.9.1. Python uses coverage.py 7.16.2 from `scripts/ci/python-coverage-requirements.txt`, installed into the interpreter environment so subprocess instrumentation is active. PowerShell uses Pester 5.9.0, saved by the shared `scripts/ci/install-pester.ps1` into `.tools/powershell/Modules` and imported by exact manifest path. The installer registers the default PSGallery only when it is absent, verifies the official HTTPS source, and checks the saved module's name and exact version. It preserves the repository's trust policy and rejects query, registration, download, or manifest failures. Its isolated fixtures mock these boundaries, and the installer remains in the PowerShell coverage denominator. Command coverage is distinct from line or branch coverage. Rust test modules live under `tests/native/rust/`, included only under `#[cfg(test)]`; LLVM runtime reports exclude those test files.

`npm run test:bash:coverage` requires Linux and kcov 43 built from upstream commit `a39874f938ce13f7a65f253120d1ec946b349ffe`. CI builds that pinned source into `.tools/kcov`. It also fetches `v43`, verifies its peeled commit against the source pin, and verifies the exact tag before CMake reads the upstream Git version. A missing or moved tag fails the build. DEBUG tracing executes the original scripts through `tests/bash/runtime.test.sh` with isolated HOME and mocked commands; all maintained VM shell scripts stay in the inventory. Embedded Python heredocs have a different execution scope and are not proved by shell line coverage. A Windows run reports the unavailable collector explicitly instead of counting a platform skip as coverage.

Every maintained script with executable shell lines must record an actual execution hit. A complete inventory containing only zero-hit sources fails collection; passing fixture processes alone cannot prove that instrumentation reached the production scripts. Failed reports remain available for diagnosis.

Bash and PowerShell syntax checks do not create a VM or request administrator access. PowerShell coverage executes behavior fixtures with mocked host boundaries. Tests do not use real model accounts, open microphones, or contact a configured Telegram bot. Telegram tests inject a simulated Bot API and verify owner pairing, authorization, deduplication, attachment bounds, delivery results, and shutdown.

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
npm run test:native:coverage
npm run test:python:coverage
npm run test:powershell:coverage
npm run coverage:inventory
python -m unittest discover -s tests/vm -p "test_*.py" -v
node scripts/ci/version.mts
node --test tests/tooling/build/version.test.mts
node scripts/ci/preflight.mts
pwsh -File scripts/ci/check-powershell.ps1
npm run build
```

Preflight requires Node.js 22.18+ LTS or 24+ with native TypeScript, the pinned pycdlib version, OpenSSH Client and Git Bash on Windows. Resource preparation separately validates the pinned Go compiler and compiled manifests; VM activation verifies its Linux binary, source and existing data. Missing prerequisites fail explicitly. Source coverage does not replace real-device acceptance; see [verification](verification.md).

For local launch, commit reviewed source, run `npm run package:resources`, then `npm start` or `npm run dev`. Both launch the validated compiled Go backend; the latter also starts Vite. Native `desktop` prepares the same resources before opening Tauri. See [runtime support](runtime-support.md). Full tests, real packaged launch and user-device acceptance are separate gates; no completed release is implied by these workflow definitions.
