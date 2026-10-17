# Diagnostics and log retention

English · [简体中文](zh-CN/diagnostics.md)

dant records structured diagnostics separately on the Windows Controller and Ubuntu Worker. Logs contain connection and task state changes, timeout categories, call shutdown reasons, identifiers, counts and timings. Conversation text, screenshot pixels, file contents, request headers and credential values are not included.

Default retention is **up to three days**, with daily rotation, a **5 MiB file limit** and **50 MiB total limit**. Cleanup runs at startup and periodically while dant is running. Older files may be removed sooner to stay within the size limit. Logging errors do not stop the application.

Cleanup runs every hour. The legacy Windows launcher file `data/startup.log` is managed separately using a first-line retention timestamp, so another launch cannot extend old content's lifetime. An unmarked legacy file is cleared once when adopted. At three days, or above 1 MiB at a cleanup check, it is truncated in place and given a new timestamp; the launcher's open append handle remains valid.

Locations:

- Windows: `%APPDATA%\com.dant.desktop\data\logs`
- Ubuntu Worker: `~/dant/data/logs`

Use the authenticated `GET /api/diagnostics` endpoint for bounded recent metadata and retention status. The Controller includes the Worker report when it is reachable; its own diagnostics remain available while the VM is disconnected. Do not upload an entire application data directory: it also contains personal conversation and connection data.

## A missing desktop does not always mean the VM crashed

The VM, desktop bridge and Codex executor are separate components. A healthy VM may remain reachable while its executor has stopped. The computer panel keeps a read-only preview in this state and offers an explicit reconnect action. Reconnecting does not automatically replay paused tasks. New computer input stays blocked until the executor and ownership checks permit it.

Voice shutdown diagnostics distinguish buffer limits, untracked handoffs, unacknowledged submissions and shutdown confirmation failures. If task ownership or shutdown is uncertain, dant may stop the old executor to prevent background work from continuing. This does not shut down the VM.

Large MCP screenshot payloads remain available to the model. Their duplicate image bytes are omitted from dant's observer queue so that a normal screenshot does not consume the voice event budget.

For a failure report, include the approximate local time, whether a voice call was active, the visible status and the relevant structured records. Kernel reboot or OOM evidence is checked separately; an offline executor alone does not establish either.
