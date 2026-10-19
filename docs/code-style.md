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

The stable `src/server.mts` launcher and browser entry files may remain at the root of their source tree for existing launch and bundling contracts.

The browser renders state and submits validated user actions. The Windows Controller owns host configuration, VM connections, and forwarding. The Ubuntu Worker owns the task Engine and persistent work. Tauri owns native Windows integration. Keep these boundaries intact when extracting or moving modules. See [architecture](architecture.md).

A move includes every affected import, packaging allowlist, test fixture, coverage path, command, and documentation link. It must preserve saved data locations and public routes, or include an explicit migration. Avoid circular imports and a miscellaneous utilities directory that hides feature ownership.

Tests mirror their feature: `tests/work/`, `tests/conversation/`, `tests/computer/`, and the other server modules; browser tests use `tests/ui/chat/`, `tests/ui/settings/`, and their matching UI modules. Shared fixtures live in `tests/support/`, compile-time contracts in `tests/types/`, and Python VM tests in `tests/vm/`. Both `npm test` and coverage use the same recursive discovery helper, so moving a test into a feature folder does not silently remove it from the suite. Focused Node runs use the complete test path, for example `node --test tests/work/task-cancel.test.mts`.

## Formatting commands

Install locked JavaScript dependencies with `npm ci`. Formatting uses **Prettier 3.9.10**, pinned in `package-lock.json`, and Rust's `rustfmt` component. The packaging toolchain is specified in the Windows build workflow; install its `rustfmt` component before running the Rust checks.

```powershell
npm run format
npm run format:check
```

`format` writes Prettier-supported source and documentation, then runs `cargo fmt`. `format:check` checks both without changing files. For a focused pass, use `format:prettier`, `format:prettier:check`, `format:rust`, or `format:rust:check`. Use these local commands rather than a global formatter with different defaults.

Prettier owns JavaScript, TypeScript, JSON, CSS, HTML, Markdown, and YAML. `.prettierrc.json` specifies two spaces, semicolons, single JavaScript quotes, trailing commas, a 100-column target, and LF. Existing prose line breaks are preserved. `.editorconfig` sets UTF-8 and final newlines, and four spaces for Python, Rust, and PowerShell. Python, PowerShell, and Bash retain their syntax and behavioral checks; there is no undeclared Python or shell formatting dependency.

`.gitattributes` keeps detected text files as LF on every platform, including Windows CI; Git's automatic binary detection keeps image and other binary files unchanged.

Generated output, caches, installed dependencies, private runtime data, environment files, and generated lock formats are excluded in `.prettierignore`. `package-lock.json` remains checked by Prettier. Do not exclude maintained source or add formatter-ignore comments to silence a failure.

## Configuration and constants

Use the shared configuration module for environment options. Parse and validate each option there, supply a documented default, and pass the result to the owning module. Do not scatter `process.env` reads throughout feature code. `.env.example` documents non-secret examples and empty secret placeholders; real values belong in ignored local configuration or the existing secure credential facilities.

Protocol limits, accepted identifiers, security allowlists, and stable error codes are code constants. Keep them beside their feature or in a shared contract when multiple runtimes need exactly the same value. Do not make security invariants configurable merely to avoid a constant in source. No log or error may include secrets or unbounded process output.

Reuse the shared atomic file rename helper when local JSON persistence needs bounded Windows lock retries. Keep its retry policy in named constants. Recheck source, target, and directory identity before another attempt; changed or unconfirmed files must stop the retry. This helper does not retry task execution, network requests, or other external actions.

## Language and user content

Use the shared language registry and localization layer. Supported codes, native language names, direction, and locale metadata must have one source of truth. Translate fixed interface text with its placeholders intact; format dates and numbers with the selected locale. Keep controls labeled and usable with a keyboard, including right-to-left layouts.

User messages, task names, project memory, files, and other user content remain as authored. Changing the interface language does not translate history or authorize new work.

## Named states and TypeScript contracts

Use the frozen runtime enums in `src/contracts/states.mts` for state values. Names use UpperCamelCase keys, such as `TaskStatus.Running`, `TaskPriority.Normal`, and `PlanStepStatus.InProgress`; their serialized values remain the existing strings. Do not replace persisted values with numeric ordinals or translated labels. Each domain has its own vocabulary: a task being paused does not prove that its executor stopped, and an unknown submission is not a failed action that may be repeated.

`ChatTaskStatus` and `WorkStatus` deliberately differ. Chat task validation keeps its existing accepted states, while a durable work record can remain `continuing` between execution turns or `unknown` while its outcome is reconciled. Legacy display normalization stays at its existing compatibility boundary. Use `isEnumValue(domain, value)` when accepting an unknown value; reject or explicitly preserve uncertainty rather than inventing a safe state.

`src/contracts/contracts.ts` defines shared boundary shapes; feature-specific types stay beside their owning modules. All maintained application code, browser code, tools, and Node tests use TypeScript. Runtime modules use `.mts`; files containing only types use `.ts` and type-only imports. Generated browser bundles, vendor files, and JavaScript inside user-file fixtures retain their original formats.

The pinned compiler runs with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noEmit`. `npm run typecheck` checks three projects: Node entrypoints and tools, the Vite browser application, and all Node tests. Node uses `NodeNext` resolution; browser and mixed browser-test imports use `Bundler`, matching their package entrypoints. Declaration checking remains enabled. Compile fixtures include intentional invalid states that must remain type errors. `npm run check:states` rejects raw enum-value literals in the explicitly adopted Store, plan, continuation, scheduler, desktop lifecycle, and VM lifecycle modules. Each module lists its applicable domains, so unrelated brand names or external protocol fields are not mistaken for states. Extend that enforced list as other domains are migrated.

Runtime TypeScript uses `.mts` with erasable types and native Node support. Supported Node versions are 22.18+ LTS or 24+; preflight and packaging execute a bounded probe for native TypeScript, built-in SQLite and a working FTS5 query. The VM installer checks the same capabilities before touching an existing runtime or service. An incompatible old VM runtime is preserved and reports `runtime-incompatible`; update that runtime through its maintenance process before reconnecting. Do not use unchecked `any`, suppression directives, or a mere extension rename as a migration. Remove the superseded implementation only after imports, packaging and behavior tests use its replacement. Vite transpiles TypeScript but does not type-check it, so retain the separate compiler gate.

Treat disk JSON and transport results as `unknown` until the owning boundary validates their consumed fields. Preserve supported legacy omissions without inventing task identities, execution confirmations, or timestamps. Define injected services by the capabilities a consumer actually uses; do not require a concrete implementation's private fields or its event listener method's concrete return type.

For format-independent source fixtures, use `tests/support/source-fixtures.mts` to erase TypeScript annotations and locate declarations and bindings through the JavaScript AST. VM evaluation also erases types before executing the selected fixture. CSS assertion views normalize whitespace through PostCSS while preserving quoted selectors, color formats, and values. Avoid extracting a function by a particular spacing pattern or a single physical line.

The DOM fixtures use only LinkeDOM's public `parseHTML` entrypoint. `tests/types/linkedom.d.ts` preserves that entrypoint's documented return contract and restricts its input to HTML strings. This isolates the upstream package's incompatible internal DOM class declarations without disabling declaration checks for the repository or its other dependencies.

## Verification and side effects

Formatting and behavior are separate checks. Run relevant tests during implementation and complete the integrated checks listed in [AGENTS.md](../AGENTS.md) before handoff. [CI](ci.md) checks Prettier on the test runners and Rust formatting on the Windows packaging runner before building.

Tests use fixtures, injected clocks and transports, and temporary data. They must not contact real model accounts or Telegram bots, operate a user's VM, or use live audio devices. Preserve exact task and connection identity, durable state, and the rule that an unknown action is reconciled rather than resent. Do not disable gates or lower coverage requirements to pass a refactor.
