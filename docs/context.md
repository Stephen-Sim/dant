# Context and token management

English · [Chinese](zh-CN/context.md)

## Codex owns the context policy

dant reuses the conversation's Codex thread for text and native subscription voice tasks. Codex manages the configured model's context window, token accounting and automatic compaction. dant does not set `model_context_window`, `model_auto_compact_token_limit`, maximum output tokens or a custom truncation policy.

Reconnecting resumes the same thread. Editing, deleting or clearing visible chat records does not reset the model conversation. The interface transcript is not used to rebuild a shorter model history. Compaction can still occur according to Codex and the model; this policy does not make the upstream model's window unlimited.

## Shared voice and text continuity

Both voice providers use the shared identity/working notes and fresh scoped memory references. Native calls retain Codex's own thread history, startup summary and context defaults. The independent API provider builds role-labelled references from the current stored chat, including attachment names and reactions; reading these references does not open, resume or authenticate a Codex subscription thread. Historical requests are reference data and must not execute again. Clearing visible chat changes the references available to a later API call while leaving the Codex thread intact. The providers do not have identical histories or context windows.

During a call, text without attachments enters the current voice session once, with the full quoted message and its original speaker when replying. The voice responds aloud; actual work follows that provider's existing backend handoff. It does not also start an ordinary text task. Finalized subscription speech remains in call-owned memory and Codex writes native speech history through delegation and the end-of-call transcript flush. This preserves spoken facts without transcript bubbles. Closing or replacing a call discards its temporary speech snapshot.

Typed call inputs also enter the same Codex thread as non-actionable references. Private `callInputHistory` retains their full redacted text, quoted speaker/content, identity and submission state because the public thread projection omits raw injected items. These records preserve thread context across visible-history changes and restarts; the API call's initial chat projection does not read this private ledger. It is excluded from desktop state snapshots and is not another work request or an automatic preference note. Unconfirmed delivery is never replayed automatically.

Optional API voice supplies finalized human and assistant speech to the same Codex thread using reference-only `thread/inject_items`, which does not start inference. A private `voiceHistory` field retains those finalized references for thread continuity because Codex's chat-history projection excludes raw injected items. It is not part of the API call's initial chat projection, desktop state snapshots, Telegram chat or visible messages. Input transcripts are ordered by provider item IDs; cancelled, partial and out-of-band assistant outputs are excluded. Typed work waits for confirmed preceding speech context. An unconfirmed injection is not automatically retried.

Ending media does not replace the conversation or cancel an accepted task. A confirmed backing task keeps the same turn and continues producing chat results after normal hangup; its results are available to later text messages and calls through that same thread. Explicit Stop work, executor failure and uncertain task ownership retain their separate interruption rules.

Saving durable memory refreshes the current voice session and backing thread. API voice replaces its previous memory snapshot after acknowledgement, and completed text replies also reach its live reference context. Speech context does not automatically become a durable preference note; `memory_write` remains explicit. API transcription uses `gpt-transcribe` over the existing WebRTC/sideband connection and still needs a separately configured API key.

## Durable memory and personality

Durable notes and retained project context live in SQLite, behind the Go [`memory.Store`](../core/internal/memory/store.go) and its revision-aware cache. The `identity.md` / `working-memory.md` labels remain compatible views; Markdown files are explicit import/export snapshots after migration. Agent base memory context uses these safe notes only. The latest-32-confirmed-entry context view remains for compatibility/read-only use, rather than automatically adding all those entries to agent prompts.

Immediately before an already-admitted input is sent, `memory.Store.Retrieve` performs bounded local FTS5 recall using literal OR terms from the current request or selected unfinished task. Shared notes and eligible confirmed facts are filtered by conversation/work scope before ranking; project memory requires the selected work ID. Normal turns, steering, automatic continuation, recognized audio, native/API typed call messages and API voice task handoffs use this path without another inference request. Matching excerpts are bounded, redacted and carry provenance; no match leaves the original input unchanged. Edits, deletion and conflict changes are read afresh before sending.

Retrieved text is current-input reference data, not a new human instruction, permission or reason to resume other work. It does not alter the stored human message, add a separate persistent injection or clear old Codex history. Earlier excerpts remain in that provider history where applicable, so their wrapper explicitly limits their scope and supersedes them for the current input. An idle heartbeat does not perform recall. Details are in [memory architecture](architecture.md#memory-storage-cache-and-recall).

Conversation history and durable memory are separate sources. **Memory & personality** keeps the fixed `DANT_IDENTITY_INSTRUCTIONS` read-only, and manages the authoritative SQLite shared documents and structured facts/experiences through search and paged lists. Logical document IDs are not file locations. Source and project references remain visible; a sparse list does not mean the model's conversation thread has been emptied.

The connected management UI can edit or clear documents, edit or delete structured records, and explicitly confirm reviewed candidates. Editing a fact returns it to candidate review. Writes compare the captured database revision, and redacted records cannot overwrite hidden originals. Offline copies remain read-only; a stale or unconfirmed mutation requires a fresh authoritative read before another action. These operations do not send model input or start tasks. See [memory settings](settings.md).

The model can still save reference notes through `memory_write`, but dant does not automatically extract or consolidate notes from each message, call or completed task. Saved notes can influence future responses; the fixed identity instructions are not a separately learned personality profile. Refreshing memory reloads saved content and does not generate new notes.

## Complete content reaches the model

- Text messages, edits, steering and call task requests are passed without dant's former 100,000-character input cutoff. Saving an edit and explicitly resending it retain their existing separate behavior.
- Live call references include the full message, quoted message or reaction target text. They remain reference data; the current human input is delivered once to the voice session for its response.
- Safe identity/working notes and enabled skill descriptions are supplied without the former 12,000/16,000-character context cuts. Supplemental recalled excerpts have their own fixed size/count limits; they do not truncate the human input. Credential redaction remains active.
- Optional API voice receives the full supplied chat history and live reference updates. dant does not evict updates at 16 entries or 32 KiB, or set provider token/truncation options.
- API voice task results are collected separately from the bounded interface output. Completed items replace streamed fragments; the complete redacted result is returned only after confirmed task completion. Cancellation or uncertain submission does not return partial work as success.

Supplementary message-ID and reaction lookup snapshots contain short labels. They help target feedback and do not replace the original inputs already held in the Codex thread. Filenames do not imply that attachment contents were read.

## Observer and storage boundaries

The interface and voice adapter also consume protocol notifications. These duplicate observations are separate from the model context. Large recognized notification-only results can be reduced to metadata, including Codex's serialized screenshot text previews; the model's original tool result remains intact. Actual RPC requests, delivery results, task ownership and shutdown controls retain their checks.

The 1 MiB voice observer queue, request-body limits, attachment limits and 64 KiB memory-file storage limit are transport or storage boundaries. They are not a model token budget. See [diagnostics](diagnostics.md) for failure metadata and [architecture](architecture.md) for data ownership. Exact automated and real-device verification is recorded in [verification](verification.md).

The [Usage settings](settings.md#token-usage) page records provider-reported consumption for display. It does not change model context windows, compaction, output limits or provider billing, and it does not estimate unavailable voice usage.
