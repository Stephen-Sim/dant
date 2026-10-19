# Code organization and formatting

English · [Chinese](zh-CN/code-style.md)

These conventions apply to new code and to code changed in this repository. [AGENTS.md](../AGENTS.md) makes them part of the repository instructions.

## Feature modules

Group production backend packages under `core/internal/<feature>/` and browser modules under `ui/<feature>/`. Small `core/cmd/` entrypoints delegate role assembly to `application`; Controller assembly lives in `controller`, and Worker assembly in `app`. Domain logic, persistence, rendering and transport stay in their owning features.

| Area                                                                                      | Responsibility                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `core/internal/controller`, `computer`, `platform`                                        | Host configuration, SSH, VM providers, lifecycle and deployment.                                                                         |
| `core/internal/app`, `work`, `runtime`                                                    | Worker API, admission, task continuity and Codex process/RPC boundaries.                                                                 |
| `core/internal/store`, `history`, `memory`, `schedules`                                   | Conversation authority, SQLite memory/recall and schedule dispatch.                                                                      |
| `core/internal/voice`, `telegram`, `files`, `skills`, `security`, `backups`, `updates`    | Their named feature and its storage/transport boundaries.                                                                                |
| `core/internal/config`, `contracts`, `i18n`, `settings`, `diagnostics`                    | Configuration, generated states, embedded language data, preferences and bounded operational metadata.                                   |
| `ui/chat`, `call`, `work`, `schedules`, `files`, `settings`, `platform`, `shared`, `i18n` | Browser features, native adapters and shared browser primitives.                                                                         |
| `src/contracts`, `src/i18n`, `scripts`, `tests`                                           | Shared schema/locale sources, TypeScript tooling and compatibility references. Retained backend TypeScript is not a production launcher. |

Shared contracts must not import a browser, Controller or Worker entrypoint. A compiled Go role cannot fall back to `src/server.mts`; production resources exclude the backend TypeScript tree and Node runtime.

The browser renders state and submits validated user actions. The Windows Controller owns host configuration, VM connections, and forwarding. The Ubuntu Worker owns the task Engine and persistent work. Tauri owns native Windows integration. Keep these boundaries intact when extracting or moving modules. See [architecture](architecture.md).

A move includes every affected import, packaging allowlist, test fixture, coverage path, command, and documentation link. It must preserve saved data locations and public routes, or include an explicit migration. Avoid circular imports and a miscellaneous utilities directory that hides feature ownership.

Retained TypeScript compatibility tests mirror their reference feature: `tests/work/`, `tests/conversation/`, `tests/computer/`, and the other server modules; browser tests use `tests/ui/chat/`, `tests/ui/settings/`, and their matching UI modules. Shared fixtures live in `tests/support/`, compile-time contracts in `tests/types/`, and Python VM tests in `tests/vm/`. Both `npm test` and coverage use the same recursive discovery helper, so moving a test into a feature folder does not silently remove it from the suite. Focused Node runs use the complete test path, for example `node --test tests/work/task-cancel.test.mts`.

Production Go core packages live under `core/internal/<feature>/`, with `*_test.go` beside the implementation. TypeScript tooling for that core belongs under `scripts/core/`, with Node tooling tests under `tests/core/`. Keep the Controller, Worker, browser and authenticated transport boundaries explicit; the Controller may never import execution assembly as an offline fallback.

## Formatting commands

Install locked JavaScript dependencies with `npm ci`. Formatting uses **Prettier 3.9.10**, pinned in `package-lock.json`, and Rust's `rustfmt` component. The packaging toolchain is specified in the Windows build workflow; install its `rustfmt` component before running the Rust checks.

```powershell
npm run format
npm run format:check
```

`format` writes Prettier-supported source and documentation, then runs `cargo fmt` and the pinned Go formatter. `format:check` checks all three without changing files. For a focused pass, use `format:prettier`, `format:prettier:check`, `format:rust`, `format:rust:check`, `format:go`, or `format:go:check`. Use these local commands rather than a global formatter with different defaults.

Prettier owns JavaScript, TypeScript, JSON, CSS, HTML, Markdown, and YAML. `.prettierrc.json` specifies two spaces, semicolons, single JavaScript quotes, trailing commas, a 100-column target, and LF. Existing prose line breaks are preserved. `.editorconfig` sets UTF-8 and final newlines, and four spaces for Python, Rust, and PowerShell. Python, PowerShell, and Bash retain their syntax and behavioral checks; there is no undeclared Python or shell formatting dependency.

Go source uses exactly **Go 1.27.2** and its bundled `gofmt`, including Go's tab indentation. `scripts/core/go.mts` prefers the pinned `.tools/go1.27.2/go/bin` installation, otherwise validates the PATH Go executable, and rejects any different version before formatting or testing. It sets `GOTOOLCHAIN=local` so checks cannot silently choose or download a compiler. Install that exact official toolchain explicitly when it is unavailable. The dedicated core workflow pins the same version on Windows and Linux.

`.gitattributes` keeps detected text files as LF on every platform, including Windows CI; Git's automatic binary detection keeps image and other binary files unchanged.

Generated output, caches, installed dependencies, private runtime data, environment files, and generated lock formats are excluded in `.prettierignore`. `package-lock.json` remains checked by Prettier. Do not exclude maintained source or add formatter-ignore comments to silence a failure.

## Configuration and constants

Use the shared configuration module for environment options. Parse and validate each option there, supply a documented default, and pass the result to the owning module. Go reads selected environment values through `core/internal/config`; browser/tooling code uses its shared configuration adapters. Do not scatter `os.Getenv` or `process.env` reads throughout features. `.env.example` documents non-secret examples and empty secret placeholders; real values belong in ignored local configuration or the existing secure credential facilities.

Protocol limits, accepted identifiers, security allowlists, and stable error codes are code constants. Keep them beside their feature or in a shared contract when multiple runtimes need exactly the same value. Do not make security invariants configurable merely to avoid a constant in source. No log or error may include secrets or unbounded process output.

Reuse the shared atomic file rename helper when local JSON persistence needs bounded Windows lock retries. Keep its retry policy in named constants. Recheck source, target, and directory identity before another attempt; changed or unconfirmed files must stop the retry. This helper does not retry task execution, network requests, or other external actions.

## Language and user content

Use the shared language registry and localization layer. Supported codes, native language names, direction, and locale metadata must have one source of truth. Translate fixed interface text with its placeholders intact; format dates and numbers with the selected locale. Keep controls labeled and usable with a keyboard, including right-to-left layouts.

User messages, task names, project memory, files, and other user content remain as authored. Changing the interface language does not translate history or authorize new work.

## Named states and cross-runtime contracts

TypeScript uses the frozen runtime enums in `src/contracts/states.mts`; Go uses the same schema's generated `core/internal/contracts` constants, such as `contracts.TaskStatusRunning`. Names use UpperCamelCase keys, such as `TaskStatus.Running`, `TaskPriority.Normal`, and `PlanStepStatus.InProgress`; their serialized values remain the existing strings. Do not replace persisted values with numeric ordinals or translated labels. Each domain has its own vocabulary: a task being paused does not prove that its executor stopped, and an unknown submission is not a failed action that may be repeated.

`ChatTaskStatus` and `WorkStatus` deliberately differ. Chat task validation keeps its existing accepted states, while a durable work record can remain `continuing` between execution turns or `unknown` while its outcome is reconciled. Legacy display normalization stays at its existing compatibility boundary. Use `isEnumValue(domain, value)` when accepting an unknown value; reject or explicitly preserve uncertainty rather than inventing a safe state.

`src/contracts/contracts.ts` defines shared boundary shapes; feature-specific types stay beside their owning modules. Production backend packages use Go's checked types. Browser code, tools and retained Node compatibility tests use strict TypeScript. Node tooling/reference modules use `.mts`; files containing only types use `.ts` and type-only imports. Generated browser bundles, vendor files, and JavaScript inside user-file fixtures retain their original formats.

`src/contracts/state-domains.json` owns the shared state vocabulary. `npm run generate:contracts` regenerates the TypeScript and Go contracts; `npm run check:contracts` verifies their exact generated contents, using the pinned formatters. Do not hand-maintain a second set of Go wire values or edit generated contracts separately. Go boundary validation must reject unknown states and retain the same task identities, legacy compatibility and explicit uncertainty semantics. Feature-specific Go types stay in their owning packages. Dependencies remain pinned in `core/go.mod` and `core/go.sum`; dependency changes must be deliberate and reviewed.

Keep persistence inside the owning feature's repository. Separate fixed parameterized queries, transaction ownership and validated row mapping from application policy; do not pass SQL or database rows to an entrypoint or renderer. Use named bindings for repeated optional scope values. Authorization predicates, persisted document names, confirmation rules and schema/revision checks are code invariants, not user-editable configuration. Prefer concrete feature operations over a generic CRUD abstraction. Introduce an ORM or a SQL generator only when its benefit and SQLite/FTS/schema compatibility are demonstrated; never enable automatic schema changes during a runtime-language migration.

The pinned compiler runs with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noEmit`. `npm run typecheck` checks three projects: Node entrypoints and tools, the Vite browser application, and all Node tests. Node uses `NodeNext` resolution; browser and mixed browser-test imports use `Bundler`, matching their package entrypoints. Declaration checking remains enabled. Compile fixtures include intentional invalid states that must remain type errors. `npm run check:states` rejects raw enum-value literals in the explicitly adopted Store, plan, continuation, scheduler, desktop lifecycle, and VM lifecycle modules. Each module lists its applicable domains, so unrelated brand names or external protocol fields are not mistaken for states. Extend that enforced list as other domains are migrated.

Node tooling/reference modules use `.mts` with erasable types on Node 22.18+ LTS or 24+. Development preflight still probes native TypeScript, built-in SQLite and FTS5 for the reference tests. This is not a production Worker prerequisite: the VM runs the verified Go executable and separately installed Codex/Python helpers. Do not use unchecked `any`, suppression directives or an extension rename as a migration. Remove superseded implementations only after imports, resources and meaningful replacement tests are verified; retain reference oracles deliberately. Vite transpiles TypeScript but does not type-check it, so keep the separate compiler gate.

Treat disk JSON and transport results as `unknown` until the owning boundary validates their consumed fields. Preserve supported legacy omissions without inventing task identities, execution confirmations, or timestamps. Define injected services by the capabilities a consumer actually uses; do not require a concrete implementation's private fields or its event listener method's concrete return type.

For format-independent source fixtures, use `tests/support/source-fixtures.mts` to erase TypeScript annotations and locate declarations and bindings through the JavaScript AST. VM evaluation also erases types before executing the selected fixture. CSS assertion views normalize whitespace through PostCSS while preserving quoted selectors, color formats, and values. Avoid extracting a function by a particular spacing pattern or a single physical line.

The DOM fixtures use only LinkeDOM's public `parseHTML` entrypoint. `tests/types/linkedom.d.ts` preserves that entrypoint's documented return contract and restricts its input to HTML strings. This isolates the upstream package's incompatible internal DOM class declarations without disabling declaration checks for the repository or its other dependencies.

## Go packages and interfaces

Use blank lines to separate validation, ownership capture, I/O, commit and notification phases. Split large structs into named fields and logical groups. Avoid multi-statement one-line callbacks and long uninterrupted functions; `gofmt` aligns syntax but does not provide these readability boundaries.

Keep each `core/internal/<feature>` package responsible for its own policy and data access. Small `cmd` entrypoints parse validated startup options, assemble dependencies and own process shutdown; they do not grow into query, mapping or protocol implementations. Prefer concrete types by default. Define a narrow interface where a consumer needs a replaceable boundary, using only the operations it actually consumes. Avoid provider-owned universal interfaces, generic `BaseRepository` layers and `common` or `utils` packages that mix unrelated features.

Keep static embedded resources in the owning feature's `assets/` directory, with their source provenance and license when required. Track every `//go:embed` input in Git and include it in source provenance and clean-checkout checks. A runtime `data/` ignore rule must never hide required build inputs; moving static resources does not move persisted user data.

Pass `context.Context` as the first argument of blocking and cancellable operations, carry the request deadline into SQL and child work, and do not replace it with a background context inside the call chain. Root assembly owns long-lived contexts. Classify wrapped failures with `errors.Is` and `errors.As`; wrap internal causes only when the owning boundary can safely retain them. Transport errors expose fixed validated codes, not SQL text, paths, query contents or raw causes. Cancellation of one request must retain the existing distinction between a stopped execution and durable unfinished work.

Every goroutine has an owner and an exit path. Bound worker and queue counts, input/output frames, deadlines and session lifetime; cancel and join workers during shutdown. Release rows, statements, transactions and files on every path. Protect shared state explicitly and retain exact request, snapshot and revision identity across asynchronous work. A timeout or missing reply does not authorize replay of an operation with an unknown outcome.

Use fixed parameterized SQL inside the owning repository and map rows into validated feature-specific types. At JSON boundaries, a temporary `map[string]json.RawMessage` may validate allowed fields before decoding typed DTOs; do not carry untyped maps through the application as its data model. Represent absence, explicit null and zero deliberately, using pointers or a feature-specific nullable type when the contract distinguishes them. Preserve existing Unicode, numeric precision, ordering, scope and legacy wire semantics rather than silently normalizing them during migration.

Place table-driven behavioral and failure-path tests beside each package. Use isolated SQLite fixtures and injected narrow dependencies at process or storage boundaries; preserve cancellation, concurrency and cleanup checks. The adopted gates remain the pinned `gofmt`, `go vet`, package tests and Linux race detector. Add another linter or generator only with a demonstrated need, an exact reproducible version and corresponding local and CI commands.

## Verification and side effects

Formatting and behavior are separate checks. Run relevant tests during implementation and complete the integrated checks listed in [AGENTS.md](../AGENTS.md) before handoff. [CI](ci.md) checks Prettier on the test runners and Rust formatting on the Windows packaging runner before building.

`npm run check:core` checks Go formatting, runs `go vet ./...` and tests every core package. `npm run test:core` runs the package tests; `npm run test:core:race` additionally enables the race detector on Linux with a working C compiler. Core CI runs Windows and Linux checks plus the Linux race pass; a missing prerequisite is a failure, never an ignored test. Core tests must use isolated data and injected dependencies, with no real model sessions, VM operations or user account data.

`npm run test:core:parity` explicitly builds the read-only shadow tool with `CGO_ENABLED=0`, creates private temporary memory fixtures, and compares authoritative TypeScript search/retrieval references against the persistent Go IPC reader. Only scores permit an absolute `1e-10` tolerance; reference fields and ordering must match exactly. It separately records 200 sequential reads per runtime as experimental p50/p95 statistics, with no performance guarantee. Output contains statistics, not fixture contents. Ordinary Node test discovery does not start this Go-dependent runner; core CI invokes it explicitly.

Tests use fixtures, injected clocks and transports, and temporary data. They must not contact real model accounts or Telegram bots, operate a user's VM, or use live audio devices. Preserve exact task and connection identity, durable state, and the rule that an unknown action is reconciled rather than resent. Do not disable gates or lower coverage requirements to pass a refactor.
