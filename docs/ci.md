# CI and Windows builds

English · [Chinese](zh-CN/ci.md)

Cross-platform checks and Windows packaging are separate, following the division of responsibilities in [Codex workflows](https://github.com/openai/codex/blob/main/.github/workflows/README.md). Both workflows run on pushes to every branch, pull requests, and manual dispatch. `master` is the default branch. Tag builds are not cancelled by later runs.

## Checks

JavaScript coverage must reach at least 90% of lines, 80% of branches, and 80% of functions overall. Connection discovery, the Controller, VM transport, Telegram, and appearance also require 90% line coverage individually. Every server module and UI helper must appear in the report; a newly added module cannot pass just by being omitted from tests. The browser entrypoint has separate render/handler fixtures because Node does not load its CSS and live DOM.

`CI` runs on Ubuntu 24.04 and Windows 2025 with Node.js 22 and Python 3.12. It installs locked npm dependencies, runs JavaScript unit tests and coverage checks, tests Python VM helpers, and builds the frontend. `pycdlib==1.14.0` and OpenSSH are required so seed-image and SSH-key tests cannot silently disappear when tools are missing. Windows DPAPI tests use temporary test keys; Linux explicitly skips Windows-only checks.

Bash and PowerShell files are parsed without creating a VM or requesting administrator access. Tests do not use real model accounts, open microphones, or contact a configured Telegram bot. Telegram tests inject a simulated Bot API and verify owner pairing, authorization, deduplication, attachment bounds, delivery results, and shutdown.

## Windows artifacts

`Windows build` runs the same Node/Python checks, then builds a Tauri NSIS installer with Rust 1.99.1 and locked Cargo dependencies. The cache contains dependency and compiler intermediates, not user data, VM images, or packaging output. Current artifacts are unsigned.

A successful build uploads an Actions artifact retained for 14 days containing:

- `dant_<version>_windows_x64_setup.exe`: NSIS installer.
- `dant_<version>_windows_x64_portable.zip`: `dant.exe` and its complete adjacent `backend/` directory, including Windows Node.js, server code, frontend, dependencies, VM scripts, and the project license. Keep both together after extraction.
- `dant_<version>_windows_x64_build.json`: version, commit, build URL, Node/Rust versions, sizes, and SHA-256 hashes.
- `SHA256SUMS`: hashes for the installer, ZIP, and metadata. Run `sha256sum --check SHA256SUMS` after downloading.

Builds require matching versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Update their lockfiles as well. A release tag must exactly match `v<version>`; mismatches fail before compilation.

## Draft releases

Only pushes of `v*` tags enter the separate draft-release job after successful tests and packaging. The job verifies downloaded hashes, version, commit, and tag before creating a GitHub Release draft. A rerun may replace an existing draft's assets, but refuses to overwrite a published release. Maintainers review and publish drafts manually. Pull requests and workflow dispatch do not create releases.

Normal jobs have `contents: read`; only the draft-release job receives `contents: write`. Workflows need no OpenAI or Telegram credentials. Actions are pinned to full commit hashes; update the version comment when changing a pin.

## Local checks

```powershell
npm run test:coverage
python -m unittest discover -s tests -p test_vm.py -v
node scripts/ci/version.mjs
node --test scripts/ci/version.test.mjs
node scripts/ci/preflight.mjs
pwsh -File scripts/ci/check-powershell.ps1
npm run build
```

Preflight requires the pinned pycdlib version, OpenSSH Client, and Git Bash on Windows. GitHub-hosted runners supply the base tools; a missing prerequisite fails explicitly. Coverage reports describe unit-test execution, not real-device acceptance. See [verification](verification.md).
