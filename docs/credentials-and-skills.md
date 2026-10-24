# Credentials and reusable skills

English · [Chinese](zh-CN/credentials-and-skills.md)

Connect the work computer, then open **Settings → Credential vault** or the **Skills** puzzle icon below the dant logo in the left sidebar. Both are owned by the Ubuntu Worker, alongside its conversation. They do not install skills into the Windows host or the Codex desktop app.

## Credential workflow

Add a name, service or hostname, optional username, and a password, token or API key in the dedicated password field. The list shows metadata only. Editing keeps the saved secret hidden until you explicitly choose **Show saved value**. This fetches it into a separate read-only field; **Hide saved value**, closing the editor, or changing its conversation or work computer clears it and discards late responses. Leave the replacement password field blank to retain the saved value, or enter a replacement. **Show input / Hide input** only changes the visibility of what you typed. Removal requires confirmation.

When dant needs a credential, its model tools can find matching saved metadata and retrieve the value for the login operation. A missing credential produces a request with its service and purpose. The app opens a separate secure form and keeps a request entry available in chat and settings. **Save and continue** stores the value and resumes the waiting tool; **Cancel request** declines it. Never put the value in the ordinary chat composer.

The VM vault uses AES-256-GCM encryption. Its master key is a separate file restricted to the ordinary VM user with mode `0600`; this protects stored files, not against that same VM user or an administrator. This vault does not use Windows DPAPI. Windows settings, state events, lists, diagnostics and the offline cache contain credential metadata, not secret values. An authenticated reveal returns a `Cache-Control: no-store` response only to the requesting editor. Typed secrets stay in the current password control through ordinary UI updates and clear when the form closes or succeeds; neither typed nor revealed values are saved in localStorage or displayed in toasts.

`credential_get` intentionally supplies the secret to the model's scoped tool context when needed for login. It is not an ordinary chat response. Secrets must not be echoed into chat, command output, repositories or skill files. The optional paid voice API key remains a separate configuration described in [voice configuration](VOICE-KEY.md).

## Skill workflow

Skills have their own plugin-style library page. Search the name or description, create a skill, or use a card's controls to edit, enable, disable or remove it. The page retains cached cards while offline and disables changes until the work computer reconnects. Opening this page does not start a task or run a skill.

Choose **Import skill** to preview a public GitHub skill-directory or `SKILL.md` link, or a local `SKILL.md`/ZIP file. The preview shows instructions and the supporting file list before saving. Change the name if it already exists, select whether to enable it, then import. Existing skills are never overwritten by import. A preview expires after ten minutes; an unconfirmed save is not automatically repeated.

GitHub files are fetched from one resolved commit through the public API; private repositories and arbitrary download URLs are not supported. A local ZIP may be at most 10 MiB; each supporting file may be at most 8 MiB, with 9 MiB of instructions and supporting contents in total. A ZIP must contain one skill root and fit the same limits as manually created skills. Supporting files may use any format, including images, PDFs, archives and executables; their bytes are preserved without opening or executing them. `SKILL.md` must remain valid UTF-8 text with supported frontmatter. Unsafe paths, links, credential values and oversized contents fail explicitly. Original root `README.md`, `LICENSE` and `NOTICE` documents (including `.txt`/`.md` license/notice variants) are preserved. Import only saves the reviewed files into the VM library; helpers run later through normal authorized tasks.

Choose **Download ZIP** on a managed skill card to save `<name>.zip`. The archive contains one `<name>/` directory with `SKILL.md` and the current supporting files in that managed directory, including helpers added later, binary assets and license documents. Every file format is accepted within the declared limits; export preserves supporting bytes exactly. Known generated cache directories are excluded; unsafe paths, links, invalid instructions, credential values or oversized contents cause an explicit export error. Both enabled and disabled skills can be exported while the work computer is connected. Desktop **Save As** or the browser download saves it without leaving the skills page. You can import this ZIP into another dant library, preview it, and rename it if needed. Export reads and packages the skill; it does not run helpers or change its enabled state.

Create or edit a lowercase skill name, description and instructions. Expand **Supporting text files (JSON)** for a mapping such as `{"scripts/check.py":"print('check')"}`. The editor exposes text files up to 256 KiB each, with at most 1 MiB of instructions and editable text and a 2 MiB encoded JSON budget. Larger text and binary assets appear separately as read-only path and size metadata; editing the text map preserves their complete original bytes. Export and import include those preserved files. Relative `scripts/`, `references/` and `assets/` paths and the root documentation names above are accepted. Instructions are limited to 48 KiB, the description to 1,000 UTF-8 bytes, and supporting files to 128 files of 8 MiB each. Instructions and supporting files together have a 9 MiB storage limit.

Keep a reusable skill self-contained: put required helpers, assets and dependency manifests inside its accepted paths, and reference them relative to the skill. For example, `scripts/package.json` and a lockfile can describe dependencies to install on another computer. A path such as `../../../tools` refers to a separate workspace folder and is not included in the ZIP. Export packages the supported skill directory, including binary assets, and excludes arbitrary workspace files and generated `node_modules`.

When saving a skill through the library API, omitting `files` preserves its current supporting files; a complete replacement supplies the text `files` map and optional canonical base64 `binaryFiles` map. The compatibility flag `preserveBinaryFiles: true` keeps all read-only assets returned by the editor, including text outside its budget, during a text-map edit. Attempts to overwrite a preserved path fail. The desktop editor and HTTP PATCH use this preservation behavior by default; explicit `false` keeps the complete-replacement option. `GET /api/skills/:name` returns the bounded editable text map and read-only `assets` metadata, without large or binary payloads. Enabling or disabling moves the existing directory and retains its contents.

Enabled skills live in the managed workspace's `.agents/skills/<name>/SKILL.md`; disabled skills move to `.dant-disabled-skills/` outside discovery. The list shows the actual VM path. You can edit, enable, disable or remove managed skills. Unrelated system or user skill folders are not managed by this page.

The model may discover and create a skill when a procedure is reusable. Saving creates real `SKILL.md` and support files and requests refreshed skill discovery; it does **not** run helpers. Discovery and script validation are separate: a listed or freshly saved skill is not evidence that its scripts passed a test. Helpers must be explicitly exercised and their results checked in the VM.

## API boundaries

| Routes                                                       | Purpose                                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/credentials`                                       | Metadata and pending requests only                                                                               |
| `POST /api/credentials`, `PATCH/DELETE /api/credentials/:id` | Create, update or remove a saved credential                                                                      |
| `POST/DELETE /api/credentials/requests/:id`                  | Fulfill or cancel the requested credential                                                                       |
| `POST /api/credentials/reveal/:id`                           | Explicitly show one saved value in its current editor; requires `conversationId` and returns a no-store response |
| `GET /api/skills`, `GET /api/skills/:name`                   | List metadata or read managed instructions, text files and read-only binary asset metadata                       |
| `POST /api/skills`, `PATCH/DELETE /api/skills/:name`         | Save, edit, toggle or remove a managed skill                                                                     |
| `POST /api/skills/import/preview`, `POST /api/skills/import` | Preview a GitHub/file source, then save the selected skill without overwriting                                   |
| `DELETE /api/skills/import/previews/:id`                     | Discard an unused preview; expiry also releases it                                                               |
| `POST /api/skills/:name/export`                              | Package a managed skill as a ZIP attachment; download the returned attachment through the normal file route      |

All routes use the existing local Controller and VM authentication boundary. An acknowledged write is not automatically repeated if the following metadata refresh fails.

## Verification boundary

Real VM acceptance used a synthetic credential through request, storage and retrieval, then removed it. A real model created a skill, ran its Python helper and delivered checked stdout; the temporary skill was then removed. A real model also used the reaction tool on the test user message. The original conversation identity, 27 existing messages and legacy state hash were preserved. UI form behavior has separate simulated DOM tests; this is not a claim that every real account, secret type or supporting script has been tested. See [verification records](verification.md).
