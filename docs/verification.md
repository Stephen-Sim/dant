# Windows / VM verification

English · [简体中文](zh-CN/verification.md)

Date: 2026-10-18, Asia/Kuala_Lumpur. Unit tests, protocol simulations, real VM tasks, and real audio acceptance are reported separately. Earlier checkpoints retain their original results and deployment status.

## 0.4.5 Telegram controls and notification previews follow-up

The final JavaScript run passed **1,039 tests, zero failures and zero skips**. Coverage is **98.59% lines, 90.55% branches and 90.93% functions**, with all configured gates satisfied. All **18 native Rust tests** passed with no ignored tests; the seven separate coverage/version gate tests also passed. No real Telegram message, native notification banner or GUI interaction was used for these checks.

The paired Telegram owner can inspect shared work with `/progress` (also `/porgress`) and `/status`, pause shared work without hanging up, and explicitly resume eligible message tasks. Tests cover ownership, duplicate commands, shared plans and history, active or unknown work, human control, and restart. A crash during submission now restores an unknown outcome instead of a safe retry; desktop confirmation must be explicitly true, and Telegram cannot bypass it. Preparing work remains resumable.

Windows notifications now use the latest completed assistant text from the exact delivery, or attachment filenames. Previews strip formatting and controls, bound Unicode length, stay out of persisted notification records, and follow chat edits or deletion. Existing unread grace, notification preferences and acknowledgements remain separate from message reading. The native notification pump consumes this body rather than replacing it with a generic sentence.

After the user exited dant, the idle Worker was updated and reconnected online with all 100 existing message IDs preserved and three-day diagnostics retention. The complete 21-file TETR.IO skill was then saved through the normal authenticated API; its downloaded ZIP matched the verified candidate byte for byte. Chat content, read receipts, registered work, completion records, schedules, shared memory, model thread and voice history were unchanged, and the original external helper sources were preserved. No model turn or desktop action was started.

The Windows installer was rebuilt from clean source commit `d0dca56` and installed silently. All **5,404 runtime files** matched the package, the executable matched apart from the expected NSIS bundle marker, and the existing connection-profile hash was unchanged. File/product versions and the installed version API reported **0.4.5**. A temporary installed Controller connected online to the existing Worker and 100-message conversation; both diagnostic stores retained three-day expiry. The verification Controller was closed afterward without opening a native window. Telegram was not configured on this device, so its new commands remain covered by mocked Bot API tests rather than a live bot acceptance.

## 0.4.5 task registration, file cards and hidden call window follow-up

The final local JavaScript run passed **1,020 tests, zero failures and zero skips**. Coverage is **98.57% lines, 90.67% branches and 90.84% functions**, with every configured gate satisfied. All **16 native Rust tests**, 21 mocked Python VM/MCP tests and seven separate coverage/version gate tests passed without ignored or skipped tests.

The shared `task_plan` workflow records an owned task title and public checklist before acknowledging the save, without creating a user message or another executor. Regressions cover native and typed ownership, the private MCP bridge, persistence failure, restart, exact-turn history and dismissal, atomic acceptance, and terminal status even when an earlier result save fails. The model is instructed to register before entrusted work; this is not a command-level sandbox gate. File-card checks cover consistent compact rows and intact preview/download actions. Call-window tests cover hiding without media actions, same-call visibility, tray restoration and rejection of stale controls. Native GUI interaction and a new live-model call remain for user testing.

Read-only inspection found newer TETR.IO helpers while the user continued working. The refreshed complete candidate contains 21 files, with the current source, tests, dependency manifests, original licenses and provenance. Its **23 offline tests**, 15 JavaScript syntax checks and ZIP import/export byte comparison passed. No live game was run. The candidate's newer versus helper remains an unverified prototype; packaging does not establish live reliability. Installation checks must preserve newer VM edits rather than overwrite a changed source snapshot.

## 0.4.5 in-call control, recent work and complete skills follow-up

The local JavaScript coverage run passed **996 tests, zero failures and zero skips**. Coverage is **98.57% lines, 90.54% branches and 90.66% functions**; all configured gates passed. The seven separate coverage/version gate tests and 20 mocked Python VM/MCP tests also passed. No native window, microphone or live user task was operated for these checks.

Connected-call takeover retains media while reserving the guest desktop, pausing exact owned work, then confirming human input. Tests cover both voice providers, changed call ownership, uncertain handoffs, typed reference sharing during control, late speech admissions and stale input leases. Returning control never replays paused work. Model screenshot, input and browser-launch tools remain blocked while the human lease is reserved or held.

Recent inactive work can be dismissed without changing chat, task status, read receipts or model context; active and queued ownership cannot be hidden. Awaiting review uses a small header mark, with chat summaries limited to active or queued work. Attachment tests cover consistent card controls, bounded spacing, loading placeholders, cached-image reconciliation and load errors. These are simulated DOM checks, not visual acceptance of the Windows application.

The reported TETR.IO ZIP contained only instructions because its implementation lived in a separate workspace directory. A self-contained candidate now contains 20 files: actual helpers, tests, manifests, lockfile, licenses and provenance. Its 13 offline tests and ZIP import/export byte comparisons passed without desktop interaction. The packaging adjustment sends runtime outputs outside the skill folder; generated npm dependencies are excluded from source export. Skill reads and metadata edits retain current supporting files, while enable/disable moves the existing directory. Deployment and installation are recorded separately after idle checks; this checkpoint does not claim a new live game or call test.

## 0.4.5 tray, task progress and text files follow-up

The final local JavaScript coverage run passed **961 tests, zero failures and zero skips**. Coverage is **98.54% lines, 90.37% branches and 90.46% functions**, with all configured gates satisfied. The seven separate coverage/version gate tests passed, and all **12 Windows Rust tests** passed with no ignored tests. These are unit, API, protocol and simulated-DOM checks; native windows and editor dialogs were not opened for visual inspection.

Work progress now has a persistent chat summary and an independent header/tray entry. Tests cover speech-only tasks, background continuation, input requests, explicit plans, stale connections, elapsed time, and result navigation without premature read receipts. Exact-turn steering cannot silently enqueue replacement work; blocker notifications do not become final-result history. The tray keeps the existing WebView, media and Controller alive when the main window is hidden, restores the same application instance, and provides a separate graceful Exit command.

Text and code files have inert, closable previews and independent downloads. JSON formatting retains numeric tokens; HTML/SVG remains source text. Main-window-only editor commands validate the authenticated attachment, cache a local copy, and directly launch Notepad or a selected supported editor with one filename. Tests cover preference races, cancellation, errors, text validation, cache expiry and preserving local edits. The real editor process and Windows Save As/tray interactions remain for user device testing.

The reported blank desktop exposed a frontend publication defect: frames were accepted before browser decoding succeeded. Regression tests now cover slow/corrupt/obsolete frames, last-good-frame preservation, aborts, URL cleanup and clearing a successful refresh error. A fresh VM state clears stale bridge errors, and client-aborted requests log bounded metadata with status 499. Read-only checks observed the VM/executor online, 93 retained messages and healthy PNG responses; this does not establish the exact cause of the earlier screenshot's freeze.

The tested Worker was deployed only after idle checks passed. It reconnected online with all 93 existing message IDs preserved, no active call/task, and three-day diagnostics retention.

This is a local development build. GitHub push, tags and releases remain deferred until user testing. The earlier checkpoints below retain their original test counts and device evidence.

## 0.4.5 recorded audio, background work and companion follow-up

At that earlier checkpoint, the local source passed 905 JavaScript tests, with zero failures and zero skips. Coverage is 98.47% lines, 90.17% branches and 90.59% functions, with all coverage gates satisfied; the seven separate coverage/version gate tests also passed. Five Windows Rust tests passed with no ignored tests. The frontend production build passed. These checks cover skill ZIP export/import round trips, current on-disk helpers and licenses, no-navigation downloads, message timestamps, foreground read receipts, draggable call views and native overlay boundaries.

Background-call regressions verify that normal hangup preserves an acknowledged task, exact turn IDs remain authoritative, results and archive failures become chat messages, credentials remain scoped, chat answers steer the same waiting task, and explicit Stop still waits for confirmed shutdown. Unknown steering acknowledgements are not replayed and retain an explicit recovery path. API media connection loss keeps an already acknowledged task; unsubmitted work never bypasses an unconfirmed speech-context barrier. These lifecycle tests use simulated protocol/media endpoints, not a new real-call acceptance.

Real local recognition was separately exercised inside the VM with synthetic English WAV/WebM and Mandarin Ogg recordings. The pinned multilingual small model recognized the target phrases in all three; 5.49–6.69 second clips took 7.08–8.73 seconds and about 758 MiB peak child RSS. No personal audio or extra API key was used. An extra run was cancelled and reaped when new user work appeared. This verifies the production recognition process, not a deployed full chat/model audio-message round trip or physical microphone quality.

A real public GitHub skill import resolved one immutable commit and preserved its license in an isolated temporary library. ZIP tests also export and reimport actual directory contents, including later shell-added helpers, without executing them. Native overlay placement, controls, Save As behavior and foreground-read decisions have protocol, pure Rust and simulated DOM checks; the new Windows windows/dialogs have not been visually inspected. Current changes remain local and uncommitted while user testing is pending. The earlier records below describe their own tested snapshots.

## 0.4.5 shared call context and skill disclosure follow-up

The final Windows JavaScript run executed 743 tests: 743 passed, zero failed and zero skipped. Coverage was 98.52% lines, 89.91% branches and 90.82% functions; all seven coverage/version gate tests passed. The frontend production build passed. Regressions cover private finalized speech, role preservation, out-of-order transcription, saves added while a prior save is pending, bounded hangup draining, uncertain injection without replay, live memory replacement, memory changes during negotiation, and clearing visible history without replacing the model thread. Private API speech is redacted before persistence and excluded from desktop state snapshots and Telegram chat.

Real subscription WebRTC acceptance passed all four directions on the existing VM conversation: typed information recalled by voice, spoken information recalled by a typed task during the same call, recall in text after hangup, and recall by a subsequent call. A separate acceptance introduced a different fact only through speech, performed no backing task or visible message during that call, then verified exact recall through text after hangup. This independently exercises Codex's transcript-tail persistence instead of relying on a typed task to retain the fact. No speech transcript bubbles appeared, all preceding message IDs were preserved, and the executor remained online after confirmed hangup without forced termination. A separate ephemeral real-Codex protocol probe also confirmed that `thread/inject_items` reference data reaches a later text turn without starting inference itself.

An additional same-peer acceptance sent a new typed fact after the call was connected, replacing an earlier test value. The subsequent spoken question received the new value, verifying live text-to-voice comprehension rather than only startup-history recall or a transport acknowledgement.

Native calls retain Codex's own same-thread startup context and compaction defaults, with explicit shared durable memory supplied to the voice prompt. The adapter does not duplicate the entire canonical history into native startup. Optional API voice uses an explicit role-labelled history bridge and private finalized references. Its transport, ordering and error cases were tested with simulated external media; a paid API call was not performed. Real audio acceptance used file-generated PCM speech, with no physical microphone or speaker.

The skill card's work-computer path now retains its disclosure state through status refreshes, search filtering and navigation. Actual DOM regressions reproduce the old collapse and verify independent cards, explicit closing, stale toggle events and a changed VM scope, while preserving chat drafts and call media. No native GUI preview was performed. These changes remain local and uncommitted; no tag, release or push was created.

The updated local 0.4.5 installer was installed after the user exited dant. All 5,381 runtime files and the executable matched the validated package; the connection-profile hash was preserved. The installed Controller and VM worker reported online with the original conversation and 82 messages. File/product versions and the version API reported 0.4.5, and both diagnostic stores retained three-day expiry. The temporary verification Controller was closed afterward; no native window was opened.

## 0.4.5 local disconnect and context follow-up

The next reported disconnect had a different confirmed trigger. At 12:36:31 UTC, the voice observer received an `item/completed` notification of 1,049,077 bytes while its queue was empty, exceeded its 1 MiB budget and deliberately stopped the executor. The VM remained running. Metadata-only inspection of the matching Codex rollout identified the screenshot result as a 1,048,523-character JSON text preview containing a truncated image string. In Codex 0.163.0, [oversized MCP results become serialized text previews for events](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/utils/output-truncation/src/lib.rs#L45-L83), while [the original result is returned to the model separately](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/mcp_tool_call.rs#L629-L652). The Python screenshot producer does not need to reconstruct this preview.

The fix projects large, recognized notification-only results to the metadata needed by the voice observer. It covers serialized screenshot previews, command output and generated media without parsing them as images or changing the original result. Exact regressions reproduce both the failing screenshot shape and a 1 MiB command result on an empty queue through Engine/native voice. Requests with IDs including zero/null, unknown/control events, ownership checks, validated delivery payloads and uncertain shutdown retain their original safeguards. New persisted size/type/status diagnostics exclude output content and retain the three-day expiry.

The fixed VM executor was restored online with all 57 prior messages preserved. A real subscription WebRTC regression then observed one spoken handoff, three sequential desktop screenshots and the requested spoken completion on the same peer. All three original events were 810,196 bytes and retained 554 observer bytes. Hangup was confirmed with the executor online and `executorStopped: false`; 58 messages remained, including one new call record. The exact oversize format is exercised by the protocol regression; this live call's screenshots were below 1 MiB. No physical microphone, speaker or complete 40-line game was tested.

Context management remains native to Codex: tests inspect actual Worker CLI arguments and Engine text/resume/native-call requests to rule out app context-window, output-token or compaction overrides. Additional dant clipping of live call text, safe memory, enabled skill descriptions and optional API voice history/updates is removed. Supplementary message-ID/reaction labels are lookup data; original requests and the reused Codex thread remain authoritative. Provider limits, storage validation and observer/control safety are separate from model context policy. The Telegram card also receives a scoped label/action spacing adjustment.

The final Windows JavaScript run executed 706 tests: all 706 passed, with zero failures and zero skips. Coverage was 98.48% lines, 89.55% branches and 90.51% functions. Long input, editing, steering, live references and complete API voice task-result regressions preserve Unicode tails beyond the old caps; HTTP transport bounds and duplicate-request protection remain tested. Cancellation racing task completion or delayed archival rejects the API task result. English and Chinese documentation links and the frontend production build passed; no Git commit, tag, release or push was created.

The former unconditional Windows skip in the deliverable symlink-escape test is removed. The test now creates real file and directory symbolic links with explicit types, verifies their outside targets, successfully archives a normal inside sentinel, and rejects automatic/explicit export through the links. It also checks that outside bytes remain unchanged and that scanning produced no failure notice. This executed on the actual Windows filesystem without mocks, a fallback skip or a system-permission change. Older skipped counts below describe earlier runs.

After the complete context changes were deployed, a real subscription WebRTC call accepted one 110,285-character typed task. The backing Codex model returned the exact randomly generated marker at the end, beyond the former 100,000-character cutoff. The full live reference RPC was acknowledged on the same call; this is not a voice-model comprehension receipt. Hangup completed with the executor online and no forced termination. All 58 preceding message IDs were preserved; the user task, assistant reply and call record brought the count to 61. The test used silent synthetic RTP without physical microphone or speaker access.

The rebuilt unsigned Windows installer completed successfully. All 5,380 packaged and staged runtime files matched the current source inventory. After the user exited dant, installation returned success; all 5,380 installed runtime files and the executable matched the verified package, and the connection-profile hash was preserved. The installed Controller and VM executor connected online to the original 61-message conversation. The local version route returned 0.4.5 and both diagnostic stores retained three-day expiry. Telegram remained disabled without a token. No native GUI preview was opened. This remains a local, uncommitted test package; user acceptance is separate from these build and connection checks.

## Earlier 0.4.5 local acceptance

This local test build adds categorized Settings with a fixed bilingual search catalog, application version information and manual GitHub update checks, a dedicated voice-message composer, theme-aware avatar colors, two-way Telegram mirroring of new messages and attachments, and a common text/voice identity. Native update reads run independently of serialized task and call controls. Unit and DOM regressions cover category navigation, drafts and live media, private-value exclusion, local version fallback, API failures and caching, voice sending, explicit idle executor recovery, and clean resource packaging. The final Windows run executed 670 JavaScript tests: 669 passed, one Windows symlink check skipped and none failed. Coverage was 98.36% lines, 88.95% branches and 90.21% functions; all seven coverage/version gate checks passed.

The new diagnostics identified the subsequent 0.4.4 disconnect: a valid realtime `handoff_request` was marked `untracked-handoff`, then hangup intentionally stopped the executor. Four screenshot events in that call had already been projected correctly. The fix tracks bounded handoff receipts and checks live thread state where correlation is incomplete, retaining confirmed executor termination for genuinely uncertain work. Exact Codex 0.163.0 source and protocol definitions were inspected; valid handoffs can precede or follow the task's start and completion events.

Initial real acceptance injected file-generated 48 kHz mono PCM16 speech into a subscription WebRTC call, asking for three sequential desktop MCP screenshots. A valid spoken handoff, all three screenshots and the spoken completion were observed on the same peer. Hangup was confirmed with the executor still online and `executorStopped: false`. All 47 earlier message IDs were preserved; one call history record was added. This exercises spoken delegation, while the 0.4.4 acceptance had used an explicit typed task during a call. No physical microphone, speaker or complete TETR.IO 40-line game was used.

A separate real public GitHub request correctly identified 0.4.4 as newer than a synthetic current version of 0.4.3. This checked release metadata only, without VM access or credentials. Publication and user acceptance of this local build remain separate steps.

Five Telegram integration tests use the actual authenticated Worker HTTP API, Engine, Store and change listeners with simulated external transports. They cover desktop text, audio-only messages and exact file bytes, streaming suppression, native and optional API call deliveries, one task per Telegram update, no incoming echo and no restart replay. Additional unit regressions cover pairing and upgrade baselines, same-owner disabled catch-up, history clearing without changing model identity, old-owner and orphan output exclusion, appended attachments, queue pressure and unknown delivery outcomes. No real Bot Token or Telegram delivery was used.

The identity fix uses one common module for text and both voice providers. In Codex 0.163.0, the default voice prompt derives a human name from the operating-system account, while `realtimeStartInstructions` controls the backing task model. The native adapter now explicitly supplies the actual voice `prompt` too. See the [upstream prompt preparation](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/realtime_prompt.rs) and [realtime session configuration](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/realtime_conversation.rs). Cross-path tests capture actual text-thread instructions, native start parameters, API voice creation and context refresh. Real subscription WebRTC acceptance used two synthetic English questions requesting English and Chinese replies: both correctly identified the assistant as dant, preserved the same peer and all earlier messages, and ended with the executor online. No physical microphone or speaker was used. The acceptance harness combines incremental transcript fragments before checking the Chinese reply.

The final native prompt also explicitly preserves task delegation and backend-only tool calls. A fresh spoken regression with that prompt observed one real handoff and exactly three desktop MCP screenshots, followed by the requested spoken completion. It kept the same peer, preserved all 54 preceding messages and added one call record. Hangup completed with the executor online and no forced executor termination.

Resource preparation and standalone runtime staging now replace their generated directories from fresh staging trees rather than merging old output. Nine new fixture tests cover removed assets/files, source validation before replacement, exact cleanup scope, Windows junctions and rename retries. The installer is checked against current source/runtime hashes before delivery; generated output never includes user data or VM keys.

The unsigned local 0.4.5 installer was installed after the user exited dant. All 5,380 runtime files and the executable matched the validated local package; the connection-profile hash was preserved. The installed Controller and VM executor both connected online to the original conversation with 56 messages. The local version route reported 0.4.5 and diagnostics retained three-day expiry on both sides. Telegram remained disabled without a token. No native GUI preview was opened, and no commit, tag, release or push was created for this test build.

A later connection timeout after the user changed VM memory was diagnosed separately: the VM was already running at a new DHCP address. SSH host-key verification against the previous address and the original conversation identity confirmed the same guest, with its Worker service active and 48 messages preserved. After the user reconnected, the running desktop Controller and executor both reported online. No memory setting or VM disk was changed during this diagnosis.

## 0.4.4 voice screenshot stability and diagnostics

The Windows JavaScript run executed 544 tests: 543 passed, one Windows symlink check skipped and none failed. Coverage was 97.95% lines, 87.43% branches and 89.81% functions. All seven coverage/version gate tests and the frontend production build passed. New regressions cover immutable screenshot projection, both voice notification buffers, genuine overflow shutdown, read-only desktop access while the executor is offline, authenticated diagnostics, RPC lifecycle metadata, rotation, three-day expiry and safe cleanup.

Investigation of the reported TETR.IO failure found the original Hyper-V VM and desktop bridge running, with no reboot, kernel crash or OOM evidence in the checked interval; the Codex executor was offline with `Worker stopped`. A regression reproducer showed that a 900,000-byte MCP image can exceed the 1 MiB voice observer budget after base64 encoding and stop the executor. The fix omits duplicate image bytes only from dant's observer copy, preserving the complete model result and all ownership and uncertain-shutdown guards. Historical logs were insufficient to prove that this was the exact trigger of the reported incident.

The fixed backend was deployed through the normal idle-VM update path. Its version and three-day retention were verified, and all 43 existing message IDs were preserved. A real subscription WebRTC call then completed an explicit typed task taking three consecutive desktop MCP screenshots of an isolated diagnostic Firefox window opened at TETR.IO. Three correlated diagnostics recorded original notifications of 791,776, 791,776 and 791,788 bytes, each projected to 554 observer bytes. The same peer, call and online executor were preserved throughout; hangup was confirmed without stopping the executor. The VM boot ID remained unchanged. Only the temporary diagnostic browser profile's process was closed afterward.

This acceptance used no physical microphone or speaker and did not play the complete 40-line game. It verifies screenshot handling during a call, not uninterrupted gameplay or long-running voice reliability. See [diagnostics](diagnostics.md) for log locations, metadata boundaries and retention.

## 0.4.3 sidebar skill library

Skills now open from a dedicated puzzle icon below the sidebar logo, with searchable plugin-style cards, creation, editing and enable switches. Ten additional DOM and handler regressions cover the independent bilingual page, skill-only reads, offline cached cards, unchanged chat drafts and live calls, and late reads or writes after navigation, modal replacement or a VM change. The Windows JavaScript run executed 494 tests: 493 passed, one Windows symlink check skipped and none failed. Coverage was 97.79% lines, 87.09% branches and 89.04% functions; all seven coverage/version gate tests passed. This UI change does not alter skill execution or require a VM redeployment.

## 0.4.2 call view controls

The minimize and expand controls use compact icons with transparent backgrounds and no borders. Bilingual tooltips, accessible names, keyboard focus and hover feedback remain available. Existing interaction tests verify that both controls preserve the call connection, media, identity and running timer. The Windows JavaScript run executed 484 tests: 483 passed, one Windows symlink check skipped and none failed; coverage was 97.78% lines, 86.82% branches and 89.14% functions. All seven coverage/version gate tests passed.

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
