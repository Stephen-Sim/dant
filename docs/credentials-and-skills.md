# Credentials and reusable skills

English · [简体中文](zh-CN/credentials-and-skills.md)

Connect the work computer, then open **Settings → Credential vault** or the **Skills** puzzle icon below the dant logo in the left sidebar. Both are owned by the Ubuntu Worker, alongside its conversation. They do not install skills into the Windows host or the Codex desktop app.

## Credential workflow

Add a name, service or hostname, optional username, and a password, token or API key in the dedicated password field. The list shows metadata only. Editing never fetches the existing secret: leave the password field blank to retain it, or enter a replacement. Removal requires confirmation.

When dant needs a credential, its model tools can find matching saved metadata and retrieve the value for the login operation. A missing credential produces a request with its service and purpose. The app opens a separate secure form and keeps a request entry available in chat and settings. **Save and continue** stores the value and resumes the waiting tool; **Cancel request** declines it. Never put the value in the ordinary chat composer.

The VM vault uses AES-256-GCM encryption. Its master key is a separate file restricted to the ordinary VM user with mode `0600`; this protects stored files, not against that same VM user or an administrator. This vault does not use Windows DPAPI. Windows settings, state events, lists and the offline cache contain credential metadata, not secret values. Typed secrets stay in the current password control through ordinary UI updates and clear when the form closes or succeeds; they are not saved in localStorage or displayed in toasts.

`credential_get` intentionally supplies the secret to the model's scoped tool context when needed for login. It is not an ordinary chat response. Secrets must not be echoed into chat, command output, repositories or skill files. The optional paid voice API key remains a separate configuration described in [voice configuration](VOICE-KEY.md).

## Skill workflow

Skills have their own plugin-style library page. Search the name or description, create a skill, or use a card's controls to edit, enable, disable or remove it. The page retains cached cards while offline and disables changes until the work computer reconnects. Opening this page does not start a task or run a skill.

Choose **Import skill** to preview a public GitHub skill-directory or `SKILL.md` link, or a local `SKILL.md`/ZIP file. The preview shows instructions and the supporting file list before saving. Change the name if it already exists, select whether to enable it, then import. Existing skills are never overwritten by import. A preview expires after ten minutes; an unconfirmed save is not automatically repeated.

GitHub files are fetched from one resolved commit through the public API; private repositories and arbitrary download URLs are not supported. A local ZIP may be at most 1 MiB; a `SKILL.md` file may be at most 64 KiB. A ZIP must contain one skill root, and imported contents must fit the same text-file limits as manually created skills. Binary files, unsafe paths, links, unsupported behavioral frontmatter and oversized contents fail explicitly. Original root `README.md`, `LICENSE` and `NOTICE` documents (including `.txt`/`.md` license/notice variants) are preserved. Import only saves the reviewed files into the VM library; helpers run later through normal authorized tasks.

Choose **Download ZIP** on a managed skill card to save `<name>.zip`. The archive contains one `<name>/` directory with `SKILL.md` and the current supported text files in that managed directory, including helpers added later and license documents. Known generated cache directories are excluded; unsupported files, links, invalid text or oversized contents cause an explicit export error. Both enabled and disabled skills can be exported while the work computer is connected. Desktop **Save As** or the browser download saves it without leaving the skills page. You can import this ZIP into another dant library, preview it, and rename it if needed. Export reads and packages the skill; it does not run helpers or change its enabled state.

Create or edit a lowercase skill name, description and instructions. Expand **Supporting text files (JSON)** for a mapping such as `{"scripts/check.py":"print('check')"}`. Relative `scripts/`, `references/` and `assets/` paths and the root documentation names above are accepted. Instructions are limited to 48 KiB, the description to 1,000 UTF-8 bytes, and supporting files to 128 text files of 64 KiB each. Instructions and supporting files together have a 256 KiB limit.

Keep a reusable skill self-contained: put required helpers, supported text assets and dependency manifests inside its accepted paths, and reference them relative to the skill. For example, `scripts/package.json` and a lockfile can describe dependencies to install on another computer. A path such as `../../../tools` refers to a separate workspace folder and is not included in the ZIP. Export packages the supported skill directory, not arbitrary workspace files, binary assets or `node_modules`.

When updating a skill through the API, omitting `files` preserves its current supporting files; providing a `files` mapping replaces them. Enabling or disabling moves the existing directory and retains its contents.

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
| `POST /api/skills/import/preview`, `POST /api/skills/import` | Preview a GitHub/file source, then save the selected skill without overwriting |
| `DELETE /api/skills/import/previews/:id` | Discard an unused preview; expiry also releases it |
| `POST /api/skills/:name/export` | Package a managed skill as a ZIP attachment; download the returned attachment through the normal file route |

All routes use the existing local Controller and VM authentication boundary. An acknowledged write is not automatically repeated if the following metadata refresh fails.

## Verification boundary

Real VM acceptance used a synthetic credential through request, storage and retrieval, then removed it. A real model created a skill, ran its Python helper and delivered checked stdout; the temporary skill was then removed. A real model also used the reaction tool on the test user message. The original conversation identity, 27 existing messages and legacy state hash were preserved. UI form behavior has separate simulated DOM tests; this is not a claim that every real account, secret type or supporting script has been tested. See [verification records](verification.md).
