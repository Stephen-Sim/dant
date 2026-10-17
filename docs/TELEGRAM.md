# Telegram

English · [简体中文](zh-CN/TELEGRAM.md)

The Telegram gateway runs inside the Ubuntu VM and uses the same persistent conversation and serial task engine as the desktop app. It is disabled until configured. The Windows window may close while the VM continues receiving work. The VM needs outbound HTTPS access to Telegram; no public inbound port is required.

## Connect your bot

1. Open the official [@BotFather](https://t.me/BotFather), create a bot using `/newbot`, and copy its Bot Token. See Telegram's [official tutorial](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
2. Connect dant to its existing VM. Open **Settings → Telegram**, enter the token in the password field, and enable the gateway. Do not paste the token into dant chat, source files, or an issue.
3. Generate a pairing link. Open it in your own private Telegram chat and press **Start**. The one-time code expires after ten minutes. The app should then show a paired account.
4. Send a message in Chinese or English. Eligible images, documents, and audio attachments enter the same conversation. Replies and delivered files for those Telegram tasks return to that private chat.

Only one private account is paired. Both its Telegram user ID and chat ID must match. Groups, channels, forwarded automation requests, and other users cannot gain task access just by discovering the bot's username. Keep the pairing link private until it has been used.

## Commands and delivery

- `/help`: show available commands.
- `/status`: report the gateway and task state.
- `/stop`: request interruption of an active task owned by this Telegram connection. It cannot interrupt unrelated desktop work or a subscription call.

Ordinary input goes through the same queue, human-control lease, and call restrictions as desktop input. A finished turn awaits review; delivery does not automatically accept a task. Group messages do not create work.

Attachments use the app's content inspection and 10 MiB per-file limit. Unsupported content or oversized downloads fail explicitly. Outgoing files are read from immutable app attachments; arbitrary VM paths are not uploaded.

The gateway sends completed results belonging to Telegram tasks, not streaming fragments, past chat history, or unrelated desktop replies. Long text is split into Telegram-sized plain-text messages. Duplicate updates use stable input IDs and do not execute the same task again. Restart recovery does not automatically resume interrupted model work.

An outbound request may reach Telegram even if its response is lost. Such deliveries are marked **unknown** and are not blindly resent. Check Telegram before repeating an operation. Explicit failures remain visible in gateway status.

## Credentials and disconnecting

The token is sent through the existing authenticated SSH connection and stored separately under the VM user's data directory with restricted file permissions. It is not stored in conversation state, memory, Windows display cache, browser storage, logs, or Git. Status APIs expose configuration and pairing state, never the token.

Disable the gateway to stop polling. Disconnecting removes the owner pairing; removing the token clears its saved credential. Replacing a token resets pairing and polling state so a different bot does not inherit access. Generate a fresh pairing link to authorize another account.

## Troubleshooting

An existing webhook prevents long polling. dant reports this conflict rather than removing another application's webhook automatically. Use a separate bot or deliberately remove its previous webhook before reconnecting. The [Bot API reference](https://core.telegram.org/bots/api#getupdates) documents this restriction.

A second polling client can also conflict. Run one gateway per bot. Check VM internet access if the gateway reports a network error. Disabling Telegram does not remove VM chat or files.

Automated tests use a simulated Bot API, isolated data, and an injected task engine. Real end-to-end Telegram acceptance requires your own token and pairing; no real Telegram account or secret is used by CI.
