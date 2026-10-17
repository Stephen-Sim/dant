# Credentials and reusable skills

English · [简体中文](zh-CN/credentials-and-skills.md)

Connect the work computer, then open **Settings → Credential vault** or **Skills**. Both are owned by the Ubuntu Worker, alongside its conversation. These settings do not install skills into the Windows host or the Codex desktop app.

## Credential workflow

Add a name, service or hostname, optional username, and a password, token or API key in the dedicated password field. The list shows metadata only. Editing never fetches the existing secret: leave the password field blank to retain it, or enter a replacement. Removal requires confirmation.

When dant needs a credential, its model tools can find matching saved metadata and retrieve the value for the login operation. A missing credential produces a request with its service and purpose. The app opens a separate secure form and keeps a request entry available in chat and settings. **Save and continue** stores the value and resumes the waiting tool; **Cancel request** declines it. Never put the value in the ordinary chat composer.

The VM vault uses AES-256-GCM encryption. Its master key is a separate file restricted to the ordinary VM user with mode `0600`; this protects stored files, not against that same VM user or an administrator. This vault does not use Windows DPAPI. Windows settings, state events, lists and the offline cache contain credential metadata, not secret values. Typed secrets stay in the current password control through ordinary UI updates and clear when the form closes or succeeds; they are not saved in localStorage or displayed in toasts.

`credential_get` intentionally supplies the secret to the model's scoped tool context when needed for login. It is not an ordinary chat response. Secrets must not be echoed into chat, command output, repositories or skill files. The optional paid voice API key remains a separate configuration described in [voice configuration](VOICE-KEY.md).

## Skill workflow

Create or edit a lowercase skill name, description and instructions. Expand **Supporting text files (JSON)** for a mapping such as `{"scripts/check.py":"print('check')"}`. Only relative `scripts/`, `references/` and `assets/` paths are accepted. Instructions are limited to 48 KiB, the description to 1,000 UTF-8 bytes, and supporting files to 20 text files of 64 KiB each, with a combined 256 KiB limit.

Enabled skills live in the managed workspace's `.agents/skills/<name>/SKILL.md`; disabled skills move to `.dant-disabled-skills/` outside discovery. The list shows the actual VM path. You can edit, enable, disable or remove managed skills. Unrelated system or user skill folders are not managed by this page.

The model may discover and create a skill when a procedure is reusable. Saving creates real `SKILL.md` and support files and requests refreshed skill discovery; it does **not** run helpers. Discovery and script validation are separate: a listed or freshly saved skill is not evidence that its scripts passed a test. Helpers must be explicitly exercised and their results checked in the VM.

## API boundaries

| Routes | Purpose |
| --- | --- |
| `GET /api/credentials` | Metadata and pending requests only |
| `POST /api/credentials`, `PATCH/DELETE /api/credentials/:id` | Create, update or remove a saved credential |
| `POST/DELETE /api/credentials/requests/:id` | Fulfill or cancel the requested credential |
| `GET /api/skills`, `GET /api/skills/:name` | List metadata or read managed instructions and text files |
| `POST /api/skills`, `PATCH/DELETE /api/skills/:name` | Save, edit, toggle or remove a managed skill |

All routes use the existing local Controller and VM authentication boundary. An acknowledged write is not automatically repeated if the following metadata refresh fails.

## Verification boundary

Real VM acceptance used a synthetic credential through request, storage and retrieval, then removed it. A real model created a skill, ran its Python helper and delivered checked stdout; the temporary skill was then removed. A real model also used the reaction tool on the test user message. The original conversation identity, 27 existing messages and legacy state hash were preserved. UI form behavior has separate simulated DOM tests; this is not a claim that every real account, secret type or supporting script has been tested. See [verification records](verification.md).
