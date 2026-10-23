# Diagnostics and log retention

English · [Chinese](zh-CN/diagnostics.md)

dant records structured diagnostics separately on the Windows Controller and Ubuntu Worker. Logs contain connection and task state changes, timeout categories, call shutdown reasons, identifiers, counts and timings. Conversation text, screenshot pixels, file contents, request headers and credential values are not included.

Default retention is **up to three days**, with daily rotation, a **5 MiB file limit** and **50 MiB total limit**. Cleanup runs at startup and periodically while dant is running. Older files may be removed sooner to stay within the size limit. Logging errors do not stop the application.

Cleanup runs every hour. The legacy Windows launcher file `data/startup.log` is managed separately using a first-line retention timestamp, so another launch cannot extend old content's lifetime. An unmarked legacy file is cleared once when adopted. At three days, or above 1 MiB at a cleanup check, it is truncated in place and given a new timestamp; the launcher's open append handle remains valid.

Locations:

- Windows: `%APPDATA%\com.dant.desktop\data\logs`
- Ubuntu Worker: `~/dant/data/logs`

Use the authenticated `GET /api/diagnostics` endpoint for bounded recent metadata and retention status. The Controller includes the Worker report when it is reachable; its own diagnostics remain available while the VM is disconnected. Do not upload an entire application data directory: it also contains personal conversation and connection data.

The retention status identifies the current logger version; individual records retain the version that wrote them. A healthy current logger can still return older records when no newer event has been recorded. Worker startup and the outcome of its first executor connection are recorded separately. Telegram polling begins after that initial connection attempt finishes, so messages waiting at startup cannot race its admission maintenance window.

Telegram input failures distinguish queue capacity, attachment transfer, persistence, admission, cancellation and timeout using fixed diagnostic codes and localized messages. Admission diagnostics also distinguish an unavailable executor, changed ownership, unconfirmed execution and backpressure. Logs do not include the message body, bot token or raw underlying error. Older records containing the combined attachment-or-queue error cannot establish which operation originally failed. Existing failed messages remain unchanged, and a code update does not retry them automatically; uncertain submissions retain their existing confirmation requirements.

Service update diagnostics use fixed status, phase, stage and reason codes, plus validated target and running versions. A failed pause or idle check is distinguishable from a connection failure or unconfirmed activation, including `pause-unconfirmed` and `idle-unconfirmed`. Raw SSH output, installation paths and task content are not retained in these records. User-facing failures show a short localized message instead of the complete installation output.

Executor disconnection records retain the first observed reason, such as end-of-stream, read or write failure, an invalid or oversized protocol frame, event backpressure, or a request timeout. An unclassified failure remains `unknown` instead of being inferred as a read error. A later process exit cannot overwrite the first reason. When observed, the same record includes the exit code, signal, whether dant requested a stop and whether the process stopped, without process stderr or protocol frame contents. A stop request after a transport failure does not establish what caused the original failure. Explicit shutdown and obsolete connection generations do not produce an unexpected-disconnection record. Missing exit evidence remains unconfirmed; an offline executor alone does not prove a VM crash, kernel reboot or out-of-memory kill.

Task admission preserves the safety pause reason, distinguishing an explicit user pause, human control, executor disconnection and an unconfirmed submission or continuation. Receiving another message while stopped does not relabel that pause as `user-paused`. An explicit pause or resume can change that state, but reconnecting or updating the application does not automatically retry unknown work. Historical records without this evidence cannot establish the original cause.

## A missing desktop does not always mean the VM crashed

The VM, desktop bridge and Codex executor are separate components. A healthy VM may remain reachable while its executor has stopped. The Computer panel keeps a read-only preview in this state and shows one connection status row with **Reconnect**. The pending action shows **Connecting** and blocks duplicate clicks; there is no second offline notice or separate refresh action in that state. Reconnecting does not automatically replay paused tasks. New computer input stays blocked until the executor and ownership checks permit it.

Desktop refresh publishes a frame only after the browser has fully loaded and decoded it. A failed, timed-out or obsolete frame keeps the last good image and shows a retry state. A fresh successful VM state clears an older connection error; cached state alone does not clear it. Requests whose client connection closes before the response finishes record status `499` and reason `client-aborted`, with only the route, method and elapsed time. A cancelled preview request is not evidence that the VM stopped.

Voice shutdown diagnostics distinguish buffer limits, untracked handoffs, unacknowledged submissions and shutdown confirmation failures. If task ownership or shutdown is uncertain, dant may stop the old executor to prevent background work from continuing. This does not shut down the VM.

Large tool results remain available to the model. The voice observer retains bounded metadata for large results it does not consume, including screenshot JSON text previews, command output and generated media; normal MCP image bytes are also omitted from this duplicate queue. Validated chat-delivery results, RPC requests, ownership information and shutdown controls retain their existing checks and budget. `voice_observer_image_omitted` and `voice_observer_payload_omitted` record original/retained sizes and fixed item type/status metadata without output content. A 1 MiB limit remains in place for actual control events and unknown protocol shapes.

For a failure report, include the approximate local time, whether a voice call was active, the visible status and the relevant structured records. Kernel reboot or OOM evidence is checked separately; an offline executor alone does not establish either.
