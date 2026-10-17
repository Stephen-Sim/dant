# Context and token management

English · [简体中文](zh-CN/context.md)

## Codex owns the context policy

dant reuses the conversation's Codex thread for text and native subscription voice tasks. Codex manages the configured model's context window, token accounting and automatic compaction. dant does not set `model_context_window`, `model_auto_compact_token_limit`, maximum output tokens or a custom truncation policy.

Reconnecting resumes the same thread. Editing, deleting or clearing visible chat records does not reset the model conversation. The interface transcript is not used to rebuild a shorter model history. Compaction can still occur according to Codex and the model; this policy does not make the upstream model's window unlimited.

## Shared voice and text continuity

Both voice providers use the same Codex thread's conversation and the same sanitized durable memory. Native calls retain Codex's own startup-history synopsis and context defaults. The independent API provider receives a role-labelled reference read from that authoritative thread, including native speech retained after earlier calls; it is not rebuilt from the visible chat list. Current reaction references are included separately. Historical requests are reference data and must not execute again. Sharing the source conversation does not make the providers' model windows or native summaries identical.

During a call, text without attachments enters the current voice session once, with the full quoted message and its original speaker when replying. The voice responds aloud; actual work follows that provider's existing backend handoff. It does not also start an ordinary text task. Finalized subscription speech remains in call-owned memory and Codex writes native speech history through delegation and the end-of-call transcript flush. This preserves spoken facts without transcript bubbles. Closing or replacing a call discards its temporary speech snapshot.

Typed call inputs also enter the same Codex thread as non-actionable references. Private `callInputHistory` retains their full redacted text, quoted speaker/content, identity and submission state because the public thread projection omits raw injected items. Later API calls receive these references along with authoritative thread history, including after visible chat is cleared or the app restarts. This ledger is excluded from desktop state snapshots. It is conversation context, not another work request or an automatic preference note. Unconfirmed delivery is never replayed automatically.

Optional API voice supplies finalized human and assistant speech to the same Codex thread using reference-only `thread/inject_items`, which does not start inference. A private `voiceHistory` field retains those finalized references because Codex's chat-history projection excludes raw injected items. This field is not exposed in desktop state snapshots, Telegram chat, or visible messages. Input transcripts are ordered by provider item IDs; cancelled, partial and out-of-band assistant outputs are excluded. Typed work waits for confirmed preceding speech context. An unconfirmed injection is not automatically retried.

Ending media does not replace the conversation or cancel an accepted task. A confirmed backing task keeps the same turn and continues producing chat results after normal hangup; its results are available to later text messages and calls through that same thread. Explicit Stop work, executor failure and uncertain task ownership retain their separate interruption rules.

Saving memory from either settings or a model tool refreshes the current voice session and backing thread. API voice replaces its previous memory snapshot after acknowledgement, and completed text replies also reach its live reference context. Speech context does not automatically become a durable preference note; `memory_write` remains explicit. API transcription uses `gpt-transcribe` over the existing WebRTC/sideband connection and still needs a separately configured API key.

## Complete content reaches the model

- Text messages, edits, steering and call task requests are passed without dant's former 100,000-character input cutoff. Saving an edit and explicitly resending it retain their existing separate behavior.
- Live call references include the full message, quoted message or reaction target text. They remain reference data; the current human input is delivered once to the voice session for its response.
- Safe durable memory and enabled skill descriptions are supplied without the former 12,000/16,000-character context cuts. Credential redaction remains active.
- Optional API voice receives the full supplied chat history and live reference updates. dant does not evict updates at 16 entries or 32 KiB, or set provider token/truncation options.
- API voice task results are collected separately from the bounded interface output. Completed items replace streamed fragments; the complete redacted result is returned only after confirmed task completion. Cancellation or uncertain submission does not return partial work as success.

Supplementary message-ID and reaction lookup snapshots contain short labels. They help target feedback and do not replace the original inputs already held in the Codex thread. Filenames do not imply that attachment contents were read.

## Observer and storage boundaries

The interface and voice adapter also consume protocol notifications. These duplicate observations are separate from the model context. Large recognized notification-only results can be reduced to metadata, including Codex's serialized screenshot text previews; the model's original tool result remains intact. Actual RPC requests, delivery results, task ownership and shutdown controls retain their checks.

The 1 MiB voice observer queue, request-body limits, attachment limits and 64 KiB memory-file storage limit are transport or storage boundaries. They are not a model token budget. See [diagnostics](diagnostics.md) for failure metadata and [architecture](architecture.md) for data ownership. Exact automated and real-device verification is recorded in [verification](verification.md).
