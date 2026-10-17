# Optional voice API key

English · [简体中文](zh-CN/VOICE-KEY.md)

This document describes dant's optional, separate API voice channel. Default calls use ChatGPT sign-in, Codex Realtime V3, and WebRTC without a separate API key, subject to the subscription allowance. A real signed-in account passed silent WebRTC connection tests; that does not establish microphone or speaker acceptance. See the official [voice documentation](https://learn.chatgpt.com/docs/features/voice) and [usage documentation](https://learn.chatgpt.com/docs/pricing).

To choose separate API voice, expand **Optional: separate API voice** in Settings, save an OpenAI API key, and explicitly select an API call. API usage is billed to the API project separately from the ChatGPT subscription. Leaving it unconfigured does not disable subscription calls, chat, or computer tasks.

## Storage and lifetime

Windows stores `voice-key.dpapi` in the application's data directory using DPAPI's `CurrentUser` protection. The file contains ciphertext. The key is not written to state, chat, or Git. Status responses indicate configuration and source without returning the key; configured does not mean remote permissions or credit have been verified.

At the start of an explicitly selected API call, the Controller passes the key through the existing SSH tunnel into VM call-process memory. It is cleared when the call stops or closes, is never model-task text, and is not saved in VM authentication files. Subscription calls do not read or forward it.

Deleting local configuration removes its ciphertext. A process-level `OPENAI_API_KEY` may still provide a key afterward, with source `environment`; the app does not modify the launching process's environment. On Windows, a saved local key takes precedence.

DPAPI depends on the Windows user and profile. After changing accounts, migrating profiles, or damaging ciphertext, configure the key again. Decryption errors fail explicitly, without a plaintext fallback or silently switching to another environment key. Non-Windows environments support process-level `OPENAI_API_KEY` only; saving through the UI fails without creating a plaintext substitute.

## Server integration

```js
import {VoiceKeyStore} from './secrets.mjs';

const voiceKeys = new VoiceKeyStore(dataDir);
voiceKeys.status();               // {configured, source, storage}
await voiceKeys.set(inputKey);    // Returns status, never the key.
await voiceKeys.clear();          // Deletes saved ciphertext.
const key = await voiceKeys.get(); // Internal voice requests only.
```

`source` is `stored`, `environment`, or `null`; `storage` is `windows-dpapi` or `environment`. Never use `get()` in an HTTP response, WebSocket event, log, or persisted state. Request logging must not include the input key.

Saving protects the new value before writing a unique temporary ciphertext file, flushing it, and replacing the target atomically. Protection or write failures retain the previous configuration. Saves and deletes are serialized within one instance.

The PowerShell protection script is fixed. Keys arrive over child-process stdin, not command-line arguments. Protection returns ciphertext; decryption wraps its result with a fresh one-time mask, so stdout does not contain the plaintext key. Child errors become fixed messages without input contents. Plaintext exists only briefly in request-process memory.

## Tests

Constructor overrides inject `platform`, `env`, `protect`, `unprotect`, or `spawnProcess`. Tests use temporary invented values to exercise atomic saves, failure preservation, deletion, non-Windows behavior, subprocess arguments/output, Windows DPAPI round trips, and tamper rejection. They do not read existing credentials.

```powershell
node --test tests/secrets.test.mjs
```

References: Microsoft [ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata) and [CurrentUser scope](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope).
