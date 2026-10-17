# Telegram

English · [简体中文](zh-CN/TELEGRAM.md)

The Telegram gateway runs inside the Ubuntu VM and uses the same persistent conversation and serial task engine as the desktop app. It is disabled until configured. The Windows window may close while the VM continues receiving work. The VM needs outbound HTTPS access to Telegram; no public inbound port is required.

## Connect your bot

1. Open the official [@BotFather](https://t.me/BotFather), create a bot using `/newbot`, and copy its Bot Token. See Telegram's [official tutorial](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
2. Connect dant to its existing VM. Open **Settings → Telegram**, enter the token in the password field, and enable the gateway. Do not paste the token into dant chat, source files, or an issue.
3. Generate a pairing link. Open it in your own private Telegram chat and press **Start**. The one-time code expires after ten minutes. The app should then show a paired account.
4. Send a message in Chinese or English. Eligible images, documents, and audio attachments enter the same conversation. Voice attachments are recognized locally inside the VM and supplied internally to the shared model thread; both interfaces retain the original audio. New desktop messages and completed dant replies also appear in the paired private chat.

Only one private account is paired. Both its Telegram user ID and chat ID must match. Groups, channels, forwarded automation requests, and other users cannot gain task access just by discovering the bot's username. Keep the pairing link private until it has been used.

## Commands and delivery

- `/help`: show available commands.
- `/status`: report the shared executor, call, current work and queue state.
- `/progress` (also `/porgress`): show the same current and recent work as desktop Work progress, including registered titles, step states and task IDs.
- `/pause`: request confirmed interruption of current shared work and pause queued work. The voice call stays connected.
- `/resume <task-id>`: explicitly resume a known paused or failed message task, using its full task ID from `/progress`. Without an ID, `/resume` only selects a single eligible paused task; multiple candidates require an explicit ID.
- `/stop`: request interruption of an active task owned by this Telegram connection. It cannot interrupt unrelated desktop work or a subscription call.

These commands are available only to the paired private owner. `/pause` controls the shared work, including work requested from desktop or a call; `/stop` keeps its narrower Telegram ownership rule. They do not reset the conversation or create another executor. Plan checkmarks do not override the actual task status.

Resume never bypasses unknown submissions, active work, disconnected executors, human control or subscription-call restrictions. Resolve the reported condition first. A task requested only by speech has no user-message task ID to resume; give a new explicit instruction in chat or the connected call instead.

Ordinary input follows the same interactive delivery, queue, human-control lease and call restrictions as desktop input. A followup goes to the current acknowledged task when it can accept it; during a call, text goes to that same voice session. Scheduled work and explicit resumes retain independent queue behavior. Ordinary conversation does not create a work entry; related work reuses its registered task ID across turns. Unfinished plans stay **In progress**, and only a complete plan awaits review. Delivery does not accept a task. Group messages do not create work.

Attachments use the app's content inspection and 10 MiB per-file limit. Unsupported content or oversized downloads fail explicitly. Outgoing files are read from immutable app attachments; arbitrary VM paths are not uploaded.

## One conversation on both devices

The desktop app and paired Telegram chat use one VM conversation, context, attachments, and serial task queue. A Telegram instruction creates one task and appears on the desktop. It is not echoed back to Telegram as a second user message. Desktop user messages are mirrored by the bot with a **You · desktop** prefix; Telegram bots send these copies under the bot's identity.

New completed dant messages and their attachments are mirrored regardless of whether the request started on the desktop, in Telegram, or was explicitly delivered during a call. Streaming fragments and the live call audio are not mirrored. Long text is split into Telegram-sized plain-text messages.

Sync starts from pairing, or from the first upgrade that enables conversation mirroring for an existing pairing. Existing history is not bulk-exported. Restarting the VM does not resend the baseline history. Editing, deleting, clearing history, quoted-reply links, and reactions are not currently synchronized between Telegram and the desktop; clearing the desktop history also does not reset the model conversation.

Duplicate updates use stable input IDs and do not execute the same task again. Restart recovery does not automatically resume interrupted model work.

An outbound request may reach Telegram even if its response is lost. Such deliveries are marked **unknown** and are not blindly resent. Check Telegram before repeating an operation. Explicit failures remain visible in gateway status.

## Credentials and disconnecting

The token is sent through the existing authenticated SSH connection and stored separately under the VM user's data directory with restricted file permissions. It is not stored in conversation state, memory, Windows display cache, browser storage, logs, or Git. Status APIs expose configuration and pairing state, never the token.

Disable the gateway to stop polling. Disconnecting removes the owner pairing; removing the token clears its saved credential. Replacing a token resets pairing and polling state so a different bot does not inherit access. Generate a fresh pairing link to authorize another account.

## Troubleshooting

An existing webhook prevents long polling. dant reports this conflict rather than removing another application's webhook automatically. Use a separate bot or deliberately remove its previous webhook before reconnecting. The [Bot API reference](https://core.telegram.org/bots/api#getupdates) documents this restriction.

A second polling client can also conflict. Run one gateway per bot. Check VM internet access if the gateway reports a network error. Disabling Telegram does not remove VM chat or files.

Automated tests use a simulated Bot API, isolated data, and an injected task engine. Real end-to-end Telegram acceptance requires your own token and pairing; no real Telegram account or secret is used by CI.
