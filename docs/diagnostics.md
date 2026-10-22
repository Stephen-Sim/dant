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

In **0.4.7**, service update diagnostics use fixed status, phase, stage and reason codes, plus validated target and running versions. A failed pause or idle check is distinguishable from a connection failure or unconfirmed activation, including `pause-unconfirmed` and `idle-unconfirmed`. Raw SSH output, installation paths and task content are not retained in these records. User-facing failures show a short localized message instead of the complete installation output.

## A missing desktop does not always mean the VM crashed

The VM, desktop bridge and Codex executor are separate components. A healthy VM may remain reachable while its executor has stopped. The computer panel keeps a read-only preview in this state and offers an explicit reconnect action. Reconnecting does not automatically replay paused tasks. New computer input stays blocked until the executor and ownership checks permit it.

Desktop refresh publishes a frame only after the browser has fully loaded and decoded it. A failed, timed-out or obsolete frame keeps the last good image and shows a retry state. A fresh successful VM state clears an older connection error; cached state alone does not clear it. Requests whose client connection closes before the response finishes record status `499` and reason `client-aborted`, with only the route, method and elapsed time. A cancelled preview request is not evidence that the VM stopped.

Voice shutdown diagnostics distinguish buffer limits, untracked handoffs, unacknowledged submissions and shutdown confirmation failures. If task ownership or shutdown is uncertain, dant may stop the old executor to prevent background work from continuing. This does not shut down the VM.

Large tool results remain available to the model. The voice observer retains bounded metadata for large results it does not consume, including screenshot JSON text previews, command output and generated media; normal MCP image bytes are also omitted from this duplicate queue. Validated chat-delivery results, RPC requests, ownership information and shutdown controls retain their existing checks and budget. `voice_observer_image_omitted` and `voice_observer_payload_omitted` record original/retained sizes and fixed item type/status metadata without output content. A 1 MiB limit remains in place for actual control events and unknown protocol shapes.

For a failure report, include the approximate local time, whether a voice call was active, the visible status and the relevant structured records. Kernel reboot or OOM evidence is checked separately; an offline executor alone does not establish either.
