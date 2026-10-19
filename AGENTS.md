# Repository instructions

Read [docs/code-style.md](docs/code-style.md) before changing this repository. These rules apply to source, tests, scripts, native code, and documentation.

## Structure and ownership

- Put runtime modules in the matching feature directory under `src/`. Put browser modules under the matching feature directory under `ui/`. Keep entrypoints small; put shared behavior in a module rather than growing an entrypoint.
- Keep the browser, Windows Controller, Ubuntu Worker, and Tauri native host separate. The Controller must not create a task Engine or execute agent work on Windows. Cross a boundary through its existing authenticated API, IPC command, or validated transport.
- Keep dependency direction explicit. Shared contracts must not import a browser entrypoint, the Controller entrypoint, or the Worker entrypoint. Avoid circular imports and generic utility folders for unrelated features.
- On a module move, update imports, resource allowlists, tests, coverage discovery, scripts, and documentation together. Preserve persisted file names and public API routes unless the change explicitly includes a migration.

## Code and configuration

- Use the repository's pinned Prettier and Rust formatter. Run `npm run format` after editing supported files, then `npm run format:check`. Do not hand-format generated files, add ignore directives to bypass a failure, or disable the CI formatting gates.
- Use UTF-8, LF, spaces, and final newlines as defined in `.editorconfig`. Python and PowerShell use four-space indentation; keep their existing syntax checks and behavioral tests. Do not add a formatter that is not declared and reproducible in this repository.
- Read deployment and local development options through the shared configuration module. Validate environment values once at the configuration boundary. Use named constants for protocol limits, fixed allowlists, error codes, and security invariants; these are not user-tunable environment options.
- Never commit `.env`, credentials, tokens, private keys, real account identifiers, runtime state, or logs. `.env.example` contains documented non-secret examples and empty placeholders only. Never expose secret values in diagnostics or errors.
- Use the shared language registry for supported codes, locale metadata, and language validation. Reuse the localization layer for interface and fixed system text. Preserve placeholders, counts, and keyboard accessibility. Do not translate user messages, task titles, project memory, file contents, or other user-provided content.

## State and side effects

- Define shared state domains as named frozen enums in `src/contracts/states.mjs`, with stable string wire values and literal JSDoc types. Use `TaskStatus.Running`, `PlanStepStatus.InProgress`, and the matching domain instead of repeating raw status strings. Keep task, submission, continuation, connection, and update states distinct. Validate unknown external values before accepting them; never coerce an unknown value into success or a safe retry.
- Keep TypeScript contracts under `src/contracts/` and check them with `npm run typecheck`. Runtime modules remain ordinary ESM compatible with the declared Node baseline. Use type-only imports for types; do not add TypeScript runtime `enum`, `const enum`, decorators, or other transform-dependent syntax to a direct Node entrypoint. Extend the adopted-module list in `scripts/ci/check-state-contracts.mjs` when migrating another domain, and run `npm run check:states`.
- Preserve exact task, turn, conversation, and connection identity across asynchronous operations. Check that the captured identity is still current before applying a result.
- Do not automatically retry a task or external action whose outcome is unknown. Reconcile its actual state first; retain an explicit unknown result when confirmation is unavailable.
- Keep durable task state separate from an execution turn. Closing a window, ending a call, or an ended response must not mark unfinished work complete. Explicit pause, cancellation, input blockers, and human control must continue to stop automatic execution.
- Diagnostics record bounded, validated operational metadata. They must not copy user content, credentials, raw request bodies, or arbitrary process output.

## Verification

- Add or update behavioral tests for changed contracts and meaningful failure paths. Avoid tests that merely reproduce implementation details; prefer public outputs, persisted state, and bounded side effects.
- Run relevant tests while working. Before handing off an integrated change, run `npm run format:check`, `npm run typecheck`, `npm run check:states`, `npm run test:coverage`, the Python VM-helper suite, `node scripts/ci/preflight.mjs`, `pwsh -File scripts/ci/check-powershell.ps1`, `node scripts/ci/version.mjs`, and `npm run build`. Run native tests when changing Rust behavior. Report unavailable prerequisites and actual failures; do not describe unrun checks as passing.
- Keep CI formatting, coverage, version, syntax, and release-integrity checks enabled. Fix failures at their source; do not lower thresholds, remove required modules, or skip required checks to make a change pass.
- Use isolated fixtures for tests. Do not start real model sessions, reconnect a user's VM, send Telegram messages, use the microphone, or install an application as a side effect of a test.
- Keep English and Chinese developer documentation consistent when changing a documented workflow. Releases must retain matching manifest and lockfile versions, verified assets, and their source provenance. Do not replace assets on a published release.
