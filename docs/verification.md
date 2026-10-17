# Windows / VM verification

English · [简体中文](zh-CN/verification.md)

Date: 2026-10-17, Asia/Kuala_Lumpur. Unit tests, protocol simulations, real VM tasks, and real audio acceptance are reported separately.

## 0.4.1 voice-message composer

The Windows run executed 484 JavaScript tests: 483 passed, one Windows symlink check skipped, and none failed. Coverage was 97.78% lines, 86.83% branches and 89.14% functions; all seven coverage/version gate tests passed. Ten new recording regressions exercise the actual composer handlers with a simulated recorder: preserving typed text, audio-file upload and preview, explicit sending, bilingual speech-to-text separation, cancellation, late permissions, device errors, stopping read-aloud before recording and call/format guards. They do not open a physical microphone. The unchanged Python helpers retain the 51 passing checks from 0.4.0.

The primary microphone now creates an audio attachment instead of dictating text. The ordinary model task receives the preserved file reference; automatic transcription and guaranteed audio understanding are not part of this change.

## 0.4.0 tool and live-delivery acceptance

The final Windows run executed 474 JavaScript tests: 473 passed, one Windows symlink check skipped, and none failed. Coverage was 97.78% lines, 86.88% branches and 88.95% functions. All 51 Python tests and seven CI coverage/version gate tests passed; workflow lint, Bash parsing and ten PowerShell syntax checks passed. The frontend production build and locked native release build passed. UI event tests also cover credential forms, skills, search, history actions, presence and call-preserving search navigation. A reproduced Windows file-lock failure in atomic memory/skill replacement now uses bounded retries; non-timeout voice fixtures no longer race a 100 ms CI scheduling window.

On the existing authoritative VM, a synthetic credential passed the secure-request, encrypted-save and scoped-retrieval workflow, then was removed. A real model created a managed skill, executed its Python helper and archived verified stdout; the temporary skill was removed afterward. A real model also applied its own reaction to a user message. Presence activity updated, while the original conversation identity, 27 existing messages and legacy Windows state hash were preserved. See [credentials and skills](credentials-and-skills.md) for storage and tool-context boundaries.

A real WebRTC call accepted typed-text and reaction add/remove updates through the same current call's supported RPC. A separate same-peer test injected an offline-generated English question as 48 kHz mono PCM16 audio. The question did not contain the answer: the model's completed output transcript correctly identified the code from the newly typed message and the added thumbs-up reaction. Remote audio was received and hangup was confirmed. No microphone, speaker device or API key was used; this verifies synthetic-audio awareness, not physical device capture/playback or long-running reliability. RPC acknowledgement alone is still not a model-read receipt. The older next-task/new-call reaction limitation in historical records does not describe the new live-delivery path.

## Initial architecture acceptance

The initial Windows/VM rebuild passed 157 Node tests, with one Windows symlink test explicitly skipped, and all 15 Python tests. Four version-gate tests, the frontend production build, locked Cargo checking, Bash parsing, eight PowerShell syntax checks, and actionlint passed.

These checks covered early out-of-order events, serialized steering, uncertain submissions, message idempotency, restart pause, explicit acceptance, viewport read receipts, five-file archival limits, immutable attachments, Linux path anchoring, MCP ownership, leases, exact call-ID stopping, recovery, and native IPC.

Bilingual tests exercised critical UI flows, retained-error translation, offline preferences, reconnect synchronization, VM response-language defaults, attachment-only inputs, and speech permission messages. A first Windows CI run exposed an 8.3 temporary-path alias in a WAV fixture. The fixture now resolves the path and has an actual short-alias regression, preserving the VM directory guard.

## Regression suite and coverage

The 0.3.1 reaction and font-selection update executed 341 JavaScript tests: 340 passed, one Windows symlink check skipped, and none failed. Coverage was 96.94% lines, 84.06% branches, and 85.60% functions. The shared six-reaction catalog, single-standard-emoji validation, legacy compatibility, bilingual labels, adjacent message actions and chat-boundary positioning have direct unit or DOM-handler regressions. Reactions remain feedback and do not start tasks. Full bubbling-click regressions also reproduce and fix root-element appearance handlers clearing a selected installed font.

The 0.3.0 local JavaScript run executed 331 tests: 330 passed, one Windows symlink check skipped, and none failed. Coverage was 96.92% lines, 84.01% branches, and 85.43% functions. All 47 Python tests passed. New cases cover provider detection and selection, VMware profile ownership metadata, strict local appearance validation, installed-font enumeration, theme import/export, real call-handler timer cleanup, and bounded reaction snapshots including cancellation of older feedback. Actual Windows font discovery returned 198 families. VM reaction-route tests verify persistence and voice-context inclusion without starting tasks.

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

For 0.3.0, the idle existing Hyper-V Worker was updated through the normal SSH deployment path and reconnected online. Its conversation identity and all 24 messages present at that time were preserved. The reaction context runs inside this authoritative VM Worker; this check did not add a synthetic task or alter an existing reaction.

## Installed desktop and CI

The Windows 0.3.0 installer completed successfully. SHA-256 comparisons of all 67 installed source files matched the current checkout. The installed AppData profile retained its original Hyper-V binding; its authoritative VM Worker remained online with the existing 24 messages. This installation check did not replace that binding with the isolated VMware test profile.

Both the [CI run 39021107415](https://github.com/Stephen-Sim/dant/actions/runs/39021107415) and [Windows build 39021107410](https://github.com/Stephen-Sim/dant/actions/runs/39021107410) completed successfully.

## Real VMware progress

Workstation 17.0.2 was detected on the Windows host. The official Ubuntu VMDK checksum, disk conversion and expansion to 40 GiB passed. A first boot exposed a generated VMX network-adapter defect; switching the managed adapter from VMXNET3 to E1000 fixed startup. The isolated test VM then ran successfully without altering the existing Hyper-V VM.

The initial address-discovery failure was traced to a stopped VMnetDHCP service. A subsequent normal Windows RunAs administrator authorization successfully started that service. After a soft reboot of the isolated VM, both DHCP and NAT services were running and SSH succeeded as `dant@192.168.163.138`. `systemd-detect-virt` returned `vmware`, and `df` reported a grown 38G root filesystem. `create-vmware.ps1 -Resume` saved the top-level binding with `provider: vmware` and its `vmwareId`, then reported `guest-installing`.

Installation subsequently completed. `check-vm.ps1` passed the SSH, XFCE display, screenshot service and Codex CLI 0.163.0 checks. Normal Controller deployment and connection reported both the VM service and Worker online. A real PNG screenshot measured 1440 × 900 and 607,408 bytes. Acquiring a desktop lease, sending Escape, releasing the lease, and rejecting stale input all passed. The fresh VMware VM has no ChatGPT account signed in and contains no chat messages; model replies and voice were not tested on this new VM. The existing AppData Hyper-V binding remained unchanged. Creation also checks the required NAT/DHCP services before changing managed VM files and reports an actionable failure when they are stopped.

After acceptance, only the isolated VMware test VM was gracefully powered off. Its disk, seed, ownership manifest and SSH binding were retained for an explicit future Resume; the existing Hyper-V VM was not stopped.

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
