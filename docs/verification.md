# Windows / VM verification

English · [简体中文](zh-CN/verification.md)

Date: 2026-10-17, Asia/Kuala_Lumpur. Unit tests, protocol simulations, real VM tasks, and real audio acceptance are reported separately.

## Initial architecture acceptance

The initial Windows/VM rebuild passed 157 Node tests, with one Windows symlink test explicitly skipped, and all 15 Python tests. Four version-gate tests, the frontend production build, locked Cargo checking, Bash parsing, eight PowerShell syntax checks, and actionlint passed.

These checks covered early out-of-order events, serialized steering, uncertain submissions, message idempotency, restart pause, explicit acceptance, viewport read receipts, five-file archival limits, immutable attachments, Linux path anchoring, MCP ownership, leases, exact call-ID stopping, recovery, and native IPC.

Bilingual tests exercised critical UI flows, retained-error translation, offline preferences, reconnect synchronization, VM response-language defaults, attachment-only inputs, and speech permission messages. A first Windows CI run exposed an 8.3 temporary-path alias in a WAV fixture. The fixture now resolves the path and has an actual short-alias regression, preserving the VM directory guard.

## Regression suite and coverage

The 0.2.0 local run executed 277 JavaScript tests: 276 passed, one Windows symlink check skipped, and none failed. Measured coverage was 96.6% lines, 81.81% branches, and 83.78% functions. All 15 Python tests, seven version/coverage-gate checks, PowerShell/Bash parsing, actionlint, the frontend build, and locked Cargo checking also passed. CI produces independent platform reports for the committed source.

Run `npm run test:coverage` for the current JavaScript unit suite and coverage gate. It writes the full test log, LCOV data, machine-readable totals, and a Markdown table under `.cache/coverage/`. CI uploads reports for Windows and Ubuntu. Source percentages and the exact executed test count come from each report rather than a manually maintained claim of complete coverage.

The regression suite includes existing-VM import and discovery, protection of valid profiles, multiple-source selection, missing keys, failed setup followed by reconnect, offline appearance persistence, native/system theme behavior, actual settings handlers, and Telegram pairing, authorization, bounded attachments, deduplication, delivery uncertainty, and shutdown. Mocked API-route tests also verify account/configuration ownership, active-document downloads, memory, receipts, uncertain retry refusal, and single schedule dispatch.

The browser entrypoint is exercised through rendering and handler fixtures; its CSS imports and live DOM are not included in Node's loaded-module coverage percentage. Rust compilation and Python helper tests are separate checks. A JavaScript coverage percentage is not a claim that every platform or device path was executed.

## Real Hyper-V VM

Ubuntu 24.04 AMD64, the ordinary `dant` user, Hyper-V detection, the graphical session, SSH, two user services, and user lingering were verified. Worker APIs and the leased desktop bridge listen only on VM loopback.

Original Windows conversation data and files were backed up before migration; VM Codex retained its authentication. Real Controller tasks left the SHA-256 of the original Windows `state.json` unchanged, with new conversation records owned by the VM.

Actual task acceptance included text and icon attachments, an MCP screenshot, exactly-once MCP chat delivery, automatic archival of `output/architecture-acceptance.txt`, a 105,662-byte PCM WAV, execution confirmation, reading and explicit acceptance, a 607,309-byte real desktop screenshot, human keyboard input under a lease, and rejection of stale session input. Real Chinese and English model replies and saved language synchronization also passed.

The later installed-profile defect was reproduced as a missing AppData `vm.json`, while the original VM remained SSH-accessible. Import restored connection fields by reference and preserved the independently generated AppData key and earlier failed-setup record. The VM and its disk were not recreated.

After repair, the real Controller started against that installed AppData profile, reconnected despite its retained `failed` setup status, and reported both Controller and Worker online with the original conversation and all 21 messages. The deployed Telegram status route was available and remained disabled without credentials. The original Windows state hash stayed unchanged. A separate unauthenticated HTTPS check from the VM verified Telegram DNS/TLS reachability, without sending a bot message.

## Subscription voice

Using existing ChatGPT sign-in, Codex CLI 0.163.0, `gpt-live-1-codex`, and Realtime V3:

1. A real WebRTC implementation generated an audio transceiver and `oai-events` SDP.
2. The Windows Controller invoked VM NativeRealtimeVoice and received a V3 event and SDP answer.
3. WebRTC reached `connected` and its data channel reached `open`, then explicitly reported connection.
4. Explicit call text executed in the same real thread with confirmation and delivery; repeating its client ID did not execute it again.
5. Hangup was confirmed and an actually connected call record was persisted.

No API key was configured for this path. An earlier conclusion based only on the default WebSocket channel was incorrect; subscription calls now default to V3 WebRTC. The optional API channel has not been tested with a paid key.

## Acceptance still requiring devices or credentials

Real microphone capture, speaker playback, continuous voice interruption, notification banners, and long-running stability have not been established by these checks. Windows speech packages and helper logic were checked without automatically opening a microphone.

The UI follows the supplied screenshots and passes build and interaction-logic checks. A previously declined browser preview was not bypassed for screenshot inspection. Telegram's automated suite uses invented tokens and a simulated API; real end-to-end messaging requires a user-provided token and pairing in local settings.
