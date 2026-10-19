# Code organization and formatting

English · [Chinese](zh-CN/code-style.md)

These conventions apply to new code and to code changed in this repository. [AGENTS.md](../AGENTS.md) makes them part of the repository instructions.

## Feature modules

Group runtime modules by responsibility under `src/` and browser modules by feature under `ui/`. Use descriptive file names within each directory. Entry files assemble the application; transport, persistence, rendering, and domain logic belong in their owning modules. Shared contracts may be imported by multiple runtimes, but must not depend on their entrypoints.

| Area                                                               | Responsibility                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/app/`, `src/runtime/`                                         | Application assembly, Controller/Worker services, process and RPC boundaries.     |
| `src/work/`, `src/conversation/`                                   | Task execution, continuity, plans, conversation and persisted state.              |
| `src/computer/`, `src/files/`, `src/voice/`                        | VM/desktop operations, attachments and delivery, audio and calls.                 |
| `src/telegram/`, `src/security/`, `src/skills/`, `src/schedules/`  | Their named integration or domain.                                                |
| `src/config/`, `src/settings/`, `src/updates/`, `src/diagnostics/` | Validated environment configuration, preferences, releases, operational metadata. |
| `src/i18n/`                                                        | Language registry, shared translation helpers, and locale catalogs.               |
| `ui/chat/`, `ui/call/`, `ui/work/`, `ui/schedules/`, `ui/files/`   | Browser features and their renderers/controllers.                                 |
| `ui/settings/`, `ui/platform/`, `ui/shared/`, `ui/i18n/`           | Settings UI, native adapters, shared browser primitives, browser localization.    |

The stable `src/server.mjs` launcher and browser entry files may remain at the root of their source tree for existing launch and bundling contracts.

The browser renders state and submits validated user actions. The Windows Controller owns host configuration, VM connections, and forwarding. The Ubuntu Worker owns the task Engine and persistent work. Tauri owns native Windows integration. Keep these boundaries intact when extracting or moving modules. See [architecture](architecture.md).

A move includes every affected import, packaging allowlist, test fixture, coverage path, command, and documentation link. It must preserve saved data locations and public routes, or include an explicit migration. Avoid circular imports and a miscellaneous utilities directory that hides feature ownership.

## Formatting commands

Install locked JavaScript dependencies with `npm ci`. Formatting uses **Prettier 3.9.10**, pinned in `package-lock.json`, and Rust's `rustfmt` component. The packaging toolchain is specified in the Windows build workflow; install its `rustfmt` component before running the Rust checks.

```powershell
npm run format
npm run format:check
```

`format` writes Prettier-supported source and documentation, then runs `cargo fmt`. `format:check` checks both without changing files. For a focused pass, use `format:prettier`, `format:prettier:check`, `format:rust`, or `format:rust:check`. Use these local commands rather than a global formatter with different defaults.

Prettier owns JavaScript, JSON, CSS, HTML, Markdown, and YAML. `.prettierrc.json` specifies two spaces, semicolons, single JavaScript quotes, trailing commas, a 100-column target, and LF. Existing prose line breaks are preserved. `.editorconfig` sets UTF-8 and final newlines, and four spaces for Python, Rust, and PowerShell. Python, PowerShell, and Bash retain their syntax and behavioral checks; there is no undeclared Python or shell formatting dependency.

`.gitattributes` keeps detected text files as LF on every platform, including Windows CI; Git's automatic binary detection keeps image and other binary files unchanged.

Generated output, caches, installed dependencies, private runtime data, environment files, and generated lock formats are excluded in `.prettierignore`. `package-lock.json` remains checked by Prettier. Do not exclude maintained source or add formatter-ignore comments to silence a failure.

## Configuration and constants

Use the shared configuration module for environment options. Parse and validate each option there, supply a documented default, and pass the result to the owning module. Do not scatter `process.env` reads throughout feature code. `.env.example` documents non-secret examples and empty secret placeholders; real values belong in ignored local configuration or the existing secure credential facilities.

Protocol limits, accepted identifiers, security allowlists, and stable error codes are code constants. Keep them beside their feature or in a shared contract when multiple runtimes need exactly the same value. Do not make security invariants configurable merely to avoid a constant in source. No log or error may include secrets or unbounded process output.

## Language and user content

Use the shared language registry and localization layer. Supported codes, native language names, direction, and locale metadata must have one source of truth. Translate fixed interface text with its placeholders intact; format dates and numbers with the selected locale. Keep controls labeled and usable with a keyboard, including right-to-left layouts.

User messages, task names, project memory, files, and other user content remain as authored. Changing the interface language does not translate history or authorize new work.

## Named states and TypeScript contracts

Use the frozen runtime enums in `src/contracts/states.mjs` for state values. Names use UpperCamelCase keys, such as `TaskStatus.Running`, `TaskPriority.Normal`, and `PlanStepStatus.InProgress`; their serialized values remain the existing strings. Do not replace persisted values with numeric ordinals or translated labels. Each domain has its own vocabulary: a task being paused does not prove that its executor stopped, and an unknown submission is not a failed action that may be repeated.

`ChatTaskStatus` and `WorkStatus` deliberately differ. Chat task validation keeps its existing accepted states, while a durable work record can remain `continuing` between execution turns or `unknown` while its outcome is reconciled. Legacy display normalization stays at its existing compatibility boundary. Use `isEnumValue(domain, value)` when accepting an unknown value; reject or explicitly preserve uncertainty rather than inventing a safe state.

`src/contracts/contracts.ts` defines strict shared boundary shapes. The pinned TypeScript compiler runs with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noEmit`. Compile fixtures include intentional invalid states that must remain type errors. `npm run typecheck` checks these contracts and the checked JavaScript enum module; it does not claim that every legacy JavaScript module has already been migrated to TypeScript. `npm run check:states` rejects raw enum-value literals in the explicitly adopted Store, plan, continuation, desktop lifecycle, and VM lifecycle modules. Each module lists its applicable domains, so unrelated brand names or external protocol fields are not mistaken for states. Extend that enforced list as other domains are migrated.

The runtime stays `.mjs`, so existing Node 22 launchers, packaged services, and deployment paths continue to work. Do not rely on native TypeScript stripping across the entire declared Node version range. A future feature may adopt `.ts` after its compilation and packaging boundary is defined; changing file extensions alone is not a migration. Vite transpiles TypeScript but does not type-check it, so retain the separate compiler gate.

For format-independent source fixtures, use `tests/source-fixtures.mjs` to locate declarations and bindings through the JavaScript AST. CSS assertion views normalize whitespace through PostCSS while preserving quoted selectors, color formats, and values. Avoid extracting a function by a particular spacing pattern or a single physical line.

## Verification and side effects

Formatting and behavior are separate checks. Run relevant tests during implementation and complete the integrated checks listed in [AGENTS.md](../AGENTS.md) before handoff. [CI](ci.md) checks Prettier on the test runners and Rust formatting on the Windows packaging runner before building.

Tests use fixtures, injected clocks and transports, and temporary data. They must not contact real model accounts or Telegram bots, operate a user's VM, or use live audio devices. Preserve exact task and connection identity, durable state, and the rule that an unknown action is reconciled rather than resent. Do not disable gates or lower coverage requirements to pass a refactor.
