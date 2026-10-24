# Settings

English · [Chinese](zh-CN/settings.md)

Settings is organized into a category menu: General, Appearance, Voice, Work computer, ChatGPT, Usage, Credentials, Chat & data, Telegram, and About. On narrow windows, the menu uses a compact layout.

**General → Language** uses a keyboard-accessible dropdown with 16 interface languages: English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português, Русский, العربية, हिन्दी, Bahasa Indonesia, Bahasa Melayu, Italiano and Türkçe. Dates and numbers follow the selected locale; Arabic uses right-to-left layout. The preference is saved locally and synchronized to a compatible work computer. Changing the interface never translates your chat history, task titles, files or memory. Local speech requires a matching installed Windows voice or recognizer.

**Connect my computer** in the welcome screen or disconnected Computer panel opens **Settings → Work computer** directly and focuses the connection card. Any settings search is cleared, while connection form drafts are preserved. Opening this category does not save a configuration or start a connection.

If the VM is reachable but its executor is offline, Computer keeps the desktop preview and shows one status row with **Reconnect**. While the request is pending, it shows **Connecting** and disables duplicate clicks. Reconnection keeps existing task identities and unknown outcomes; it does not resume paused work automatically. Online agent control, human control and desktop refresh retain their separate meanings.

Use **Search settings** to find a setting across all categories. English and Chinese names and keywords work in either interface language. Selecting a result opens its category and focuses the matching control, including controls inside advanced sections.

Search uses a fixed catalog of setting names and help keywords. It does not search chat history, credential values or account details. Chat history search is a separate chat action.

**General → Message notifications** controls desktop banners and their Windows system notification sound together. Notifications wait briefly for an unread result or request for your input; streaming text and quiet automatic task checks do not create extra alerts. Reading a message during that brief wait prevents the alert. Windows notification permissions, sound settings and **Do not disturb** still apply; dant does not play separate audio to override them.

**Chat & data → Memory & personality** manages the work computer's SQLite-backed shared documents, facts and past experiences. Search and paged lists retain source and project references. **Shared personality** displays the fixed shared identity instructions as read-only text. Memory management requires a connected, compatible work computer; an offline copy is labelled and cannot be edited.

Edit shared documents or clear their contents; edit or delete structured records, and explicitly confirm candidates after reviewing them. Editing a structured fact returns it to candidate review. Sensitive values are hidden, and redacted records cannot be edited over their hidden originals. Writes check the database revision; stale or unconfirmed results require a fresh read before another action. Refreshing does not generate memories or start work. Chat and call history remain separate, and automatic memory consolidation is not implemented. See [shared context and durable memory](context.md#durable-memory-and-personality).

Switching categories preserves local form drafts and an ongoing call. Some settings require a connected work computer; appearance, application version and update checks are handled locally. See [updates](updates.md).

**Chat & data** also holds backup mode, interval, saved copies and portable export. **Work computer → Import backup file** imports an existing companion during setup. Export selects a saved copy and works while its VM is offline; create a backup first if no copies exist. See [backups](backups.md).

Before an admitted request is sent, dant recalls relevant confirmed facts within its conversation/task scope; unrelated projects, candidates and conflicts are excluded. This does not change your message or create another task, and refreshing the memory page does not trigger recall or consolidation. See [memory architecture](architecture.md#memory-storage-cache-and-recall).

## Token usage

**Settings → Usage** shows the provider-reported input, cached input, output, reasoning output and total tokens received by dant. ChatGPT work and optional API voice are counted separately, with recorded totals and the latest model response. Cached input is already included in input; reasoning output is already included in output. Missing fields remain unavailable, rather than appearing as zero. These statistics do not represent account quota or a bill.

Usage receipts are saved on the work computer and deduplicated across reconnects and restarts. ChatGPT figures come from cumulative Codex thread usage; API voice figures come from completed response receipts. Native voice media without a usage receipt is not estimated. Old API calls with no saved receipt cannot be reconstructed. Offline statistics are labelled as saved data.

The **Token activity** chart has **Daily**, **Weekly** and **Cumulative** views, plus lifetime tokens, peak daily tokens and activity streaks. Choose ChatGPT work or API voice; hover over or keyboard-focus a day, week or point for its date and exact count. Detailed input, cache and output figures remain available below the chart.

Charts use dated receipts from the past 365 days; the work computer retains up to 400 calendar days. The calendar keeps the time zone configured when daily history was first created, and displays it beside the chart. Changing the settings time zone does not move earlier receipts between days. A date without a report means unknown usage. Old cumulative ChatGPT totals remain in the lifetime figure without being assigned to today; only a verifiable latest response and subsequent increases create dated history. Old saved API receipts retain their original timestamps. Undated and older usage is excluded from charts and streaks.

## Chat and call controls

Chat shows a time divider at the start of the conversation, on a new day, and after gaps longer than 30 minutes. Each message's saved sent time stays visible below its bubble, beside its status and receipt. Editing does not change the original time; messages without a valid saved time show no timestamp. Saved dant replies show **Read** or **Unread** once streaming stops, including partial replies retained after a pause or failure. Read status describes whether you saw the message; it does not complete or resume a paused task. The sidebar badge counts unread replies, and the **unread messages** button scrolls to the first one.

Task pauses remain visible in Work progress without adding a **Paused** label below the chat bubble. Sent times, delivery checks and **Read / Unread** receipts remain visible independently of task status.

Paused text-chat requests also appear in Work progress with a control to resume that one request. Unconfirmed outcomes require explicit confirmation before another attempt. Voice and registered work retain their existing owner and recovery controls.

After **Return to dant** has finished and the executor has confirmed stopping, a new instruction from desktop chat or the paired Telegram conversation can run without inheriting the previous human-control pause. Returning control alone does not restart earlier paused requests; use their individual Resume action when needed. Explicit task pauses, uncertain stops and unconfirmed submissions keep their existing safeguards.

Paste a clipboard image into the message composer to add it as an attachment, or use the attachment picker. Ordinary text paste keeps its normal behavior, and mixed text/image paste keeps the text while attaching the images. The existing limits of five attachments and 10 MiB per file apply. Uploads remain tied to their original conversation and computer; a late response cannot add files to a different chat or connection.

Each message's **…** menu has **Pin / Unpin** and **Star / Unstar**. Pinned messages appear in a compact summary above chat; select it to jump to the original, or cycle between multiple pins. The top chat **…** menu contains **Starred messages**, **Search** and **Media, docs & links**. These lists can reveal an older message through lazy loading. Pinning and starring save message metadata on the work computer without sending instructions, changing read receipts or reopening tasks; they also work during a confirmed call or active task.

To hear a text reply, open its **…** menu and choose **Read aloud**; while it is playing, the same menu shows **Stop reading**. Opening the menu does not start playback. Read-aloud is unavailable while a reply is streaming or another audio activity blocks it. Audio attachments keep their own playback controls.

Windows read-aloud uses the local computer's playback device. If no output is available, check Windows sound output and connect a playback device before trying again. Speech failures show a short message in the selected language; local native speech diagnostics retain only bounded operation metadata, never the spoken text or dictation transcript.

Your message shows one check after it is saved, and two after the executor acknowledges its delivery. This confirms receipt, not comprehension or task completion. New chat messages go to the current task when it can accept followups; otherwise they wait in the queue. Explicitly resumed and scheduled tasks keep their separate queue behavior. A background task left by a subscription call accepts text followups; its attachments wait for a separate task.

While a call is connected, typed text goes to that same call and dant responds aloud. Quoted replies carry the original message and speaker; both voice providers share the same conversation memory. The header's **Work progress** button opens an independently scrolling pane between chat and Computer on wide windows; narrow windows stack the panes. Selecting that button or the chat's **Working** bar again closes the pane without pausing work. Closing it preserves Computer, the chat draft and scroll position. Task checklist expansion survives refreshes and reopening.

Drag either divider to adjust the adjacent panes: Chat / Work progress and Work progress / Computer. Widths are remembered locally and bounded so each pane remains usable. Focus a divider and use **Left / Right** or **Home / End** to resize with the keyboard. When the panes cannot fit, Computer moves below chat and progress, then all three stack on the narrowest windows; saved widths return when space is available. Resizing does not refresh chat, interrupt a task or change the call.

Automatic continuation performs the remaining entrusted work in the same task. Routine checks and intermediate results stay quiet; dant sends a chat message when the work finishes, fails or actually needs your reply. Ordinary messages you send still receive normal replies. A turn ending does not mean the task is complete.

Live captions below the call avatar show the received text of dant's speech for subscription and API calls. **Voice → Call captions** and the call's caption toggle save the same preference, enabled by default, without changing audio. Captions are credential-redacted and stay in RAM; desktop polling reads the current call's snapshot. The last received segment remains until the next response clears or replaces it, or the call ends or disconnects. Captions do not enter saved chat, diagnostics or backups and do not promise a complete two-sided transcript. Expanding the call covers only the conversation pane; Computer and Work progress remain visible.

You can start a call while a confirmed task is running, including work continuing after an earlier call. The existing task and secure input requests keep their identity and progress. Connection failure or ordinary hangup does not pause that work; uncertain call or execution ownership still needs confirmation before another connection.

Opening, closing or resizing the Computer panel keeps the chat at the message you are viewing. A chat already at the bottom stays there; reading older messages does not force a jump to the newest message. Delayed image loading also preserves the current view. Search, unread-message and task-result navigation still move to the selected message.

Use the **×** or **Cancel current work** control in Work progress to cancel selected work. Confirmation appears inside that task's card and stays bound to its current identity. A confirmed cancellation moves it to Recent tasks as **Cancelled**, retaining its steps, results and files. Unconfirmed stops remain visible; unrelated queued tasks and the current call are preserved. Cancelled tasks do not resume automatically or count toward Clear completed. You can also ask dant to find a task through `task_list` and cancel it through `task_cancel`.

**Pause** stops only the selected current or ongoing task, retaining its identity, checklist and partial results. It stays **Paused** until you choose **Resume**; the automatic supervisor skips paused work. Resume keeps the same work ID and waits for the shared executor to become available. The call and unrelated queue entries remain intact. An unconfirmed stop or stale task identity cannot be reported as a successful pause or silently resumed.

The saved pause reason distinguishes a user action from human control, executor disconnection and uncertain execution. New messages received while work is safely stopped retain that reason instead of being labelled `user-paused`. Reconnect restores a connection, while an unknown task still requires its own state confirmation before another execution.

**Reply to task** opens text chat with that exact task selected above the composer. Existing drafts, files and quoted messages stay in place. Sending uses your new answer or adjustment to continue the same task, without resending its original request. If another task is running, the selected reply waits for its own task. Sent messages retain the task reference. A changed or unavailable task keeps the draft and asks you to select it again; an older work computer service must first be updated.

Current registered work and saved tasks share the same compact card layout: title and status, a collapsible checklist, and one bottom row for **Reply to task**, priority, **View task** and pause where available. Current work keeps its running stage and elapsed time; its **×** cancels that exact task. Reply replaces the separate adjustment form. Completed, cancelled, failed and awaiting-review tasks hide priority controls; sending a new reply can reopen the same task with its saved project context. Selecting Reply alone does not start work. **View task** opens the checklist, original request, your additions, reported results and file references, so you can review the project before continuing it. These saved excerpts are reference records, not independent verification of a result.

**Online** describes the current connection. **Idle** means no task is executing; **Waiting for your reply** means retained work needs your answer. The last activity time is available on hover and is not an offline duration. Genuine information blockers and human verification steps do not resume just because time passes. Complete the requested step, then reply to that task to continue.

In **General → Show work progress in chat**, enable the compact progress card above the conversation. It is off by default and remembers your choice after restart. The card opens the same Work progress panel; its visibility preference does not start, pause or finish work, or change the current call. The header button remains available.

An actual bubble must remain in view for 450 ms in the focused foreground text chat before it is marked read. Minimizing the app, showing the full call view, switching pages or opening a modal stops that tracking. Restoring the window or receiving a notification does not mark unseen replies read. Receipts are saved in the VM conversation; native notification delivery is a separate record.

Enable **Message notifications** in General to receive alerts for unread results or requests for input. A notification means dant has a message for you; it does not necessarily mean the task has finished. Native alerts require the Windows app to remain running and notification permission to be granted.

**Minimize to chat** displays a draggable horizontal call bar with the avatar on the left. Minimizing the Windows app or closing its main window to the system tray during an active call displays a separate desktop bar, initially above the taskbar at the bottom right. Drag its background to move it; its expand control restores the main window. It hides when the main window returns or the call ends. Both bars control the existing call, microphone and timer, without creating another audio session. Browser mode uses the in-app bar.

The desktop bar's **Hide call window** control hides it for the current call while audio and accepted work continue. Status updates do not make it reappear. A new call resets this choice.

**Take control** remains available during a confirmed connected call and keeps its audio connected. Input waits until the exact running work has stopped and the VM confirms your control lease; queued work pauses. **Return to dant** does not replay tasks. Give a new instruction in the call when ready to continue. Connecting, stopping or unconfirmed call states still block new takeover; returning an existing lease remains available.

Attachment download buttons keep chat and image previews open. Desktop **Save As** uses the original file name and extension by default; browser mode starts a file download. Cancelling leaves the current view intact.

Local output links in dant replies open their matching archived attachment. Explicitly referenced files are read directly, so unrelated output files exceeding automatic scan limits do not prevent image delivery. For an old link missing its attachment, clicking it can restore a snapshot of the file currently at that exact output path into the original message. That copy may be newer than the original reply. Recovery never reruns the task; missing, restricted or oversized files remain unavailable.

Attachments in one message use consistent spacing. Compact file cards keep the filename, **View** and download button inside the same border. Long names stay on one line with the full name available on hover; type and size appear below. Images reserve space while loading and show a stable error message if loading fails; this changes the presentation, not transfer speed.

Text and code attachments have **View** and a separate download control. Click the filename in chat or conversation details to open a closable plain-text preview. JSON is formatted without changing number values; deeply nested or oversized formatting falls back to the complete original text. Previews accept UTF-8 text up to 1 MiB. Larger files remain available through download or the desktop editor. HTML and SVG source stays inert text; links, markup and scripts do not execute.

In **General → Open with**, keep Windows Notepad or choose an installed supported editor executable, such as VS Code, Notepad++, Sublime Text, Zed or Cursor. The application menu shows each installed editor's icon and name, with a checkmark beside the current choice. **Choose another editor…** keeps the native executable picker available, and existing custom editor settings are preserved. Choosing an editor only saves the preference; it does not launch the application. **Open in editor** opens a local copy of a text attachment, up to 10 MiB, without changing the chat attachment. The app launches the selected editor directly rather than using script file associations. Unchanged cached copies expire after three days; edits to a previously opened copy are preserved.

Reusable skills use their own sidebar page rather than a settings category. It includes **Import skill** with a preview and **Download ZIP** on each managed card. See [credentials and skills](credentials-and-skills.md).

External editor copies use `dant-text-editor` under the current user's temporary directory, so packaged Windows editors can access them independently of app-cache views. Existing AppData copies are left untouched. dant's cleanup preserves modified copies, but Windows can clear temporary files; use the editor's **Save As** to keep an edited document permanently.

## Telegram forwarding

In **Settings → Telegram → Message forwarding**, choose **Unread replies only (recommended)** or **All replies**. Unread-only avoids forwarding replies already read in dant; All also forwards those read replies. Read/unread status remains independent between dant and Telegram. **Combine consecutive replies**, enabled by default, groups consecutive text replies into fewer Telegram messages; attachments are delivered separately. These controls save automatically without replacing the bot token, changing the pairing or restarting Telegram polling. These controls require the matching work computer service. The service updates automatically when connected and idle; **Settings → Work computer** shows pending, updating, confirmed and failed states.

Desktop and Telegram use the same conversation and task executor on the work computer. If Telegram reception stops, its connection status changes to offline and the paired outbound loop is cancelled and joined. A failed receipt save is reported without resetting the update offset or replaying an uncertain message.

## Background operation on Windows

Closing the main window with **X** hides dant to the Windows system tray. The app, call and accepted tasks keep running; closing the window does not pause or cancel work. Click the tray icon or choose **Open dant** to restore the same window. Launching dant again also restores the existing instance.

The tray shows a brief online/work/waiting status and queue count. **Work progress** opens the task panel directly. Tray text never contains messages, task titles, file names or credentials. Cached or disconnected active work is labelled unconfirmed rather than assumed complete.

Choose **Show call window** in the tray menu to restore a hidden desktop call bar. This action is unavailable without a current call.

Choose **Exit dant** in the tray menu to end the application through its normal shutdown path. Use this before manually installing an update; the in-app updater handles its own restart. If the operating system cannot create the tray icon, closing the main window exits normally so there is no inaccessible hidden app. The tray does not start dant automatically after Windows restarts.

## Scheduled tasks

The clock beside Skills in the left sidebar opens **Scheduled tasks**. Search or filter upcoming, paused and past entries; create or edit a task, pause it, or remove it. New tasks use your computer's time zone; editing preserves the task's saved zone, shown beside its date/time field. Entries display the saved execution time and zone. Creating or editing a schedule saves it without immediately running its instructions.

Scheduling supports **Daily**, **Weekly** and **Custom cron** alongside **Once**, with **High**, **Normal** and **Low** priority. Cron uses five fields: minute, hour, day of month, month, day of week. For example, `0 9 * * 1-5` runs at 09:00 Monday through Friday in the saved time zone. The service calculates the next execution time. Pausing retains the rule; resuming an overdue repeating task advances to its next future time. Priority orders scheduled runs waiting to start without interrupting running work or moving ordinary chat messages out of their queue positions.

An offline repeating schedule catches up once when available, then advances to a future matching time. It does not launch all missed occurrences. A new run waits while the same schedule has unfinished work, including paused tasks, work waiting for your reply and unconfirmed submissions. Update an older work computer service before using repetition or priorities.

The work computer now saves schedules and dispatch receipts in `schedules/schedules.sqlite`; chat messages remain separate. Existing JSON schedules are backed up and imported once. After an interrupted dispatch, recovery can restore the same message as paused, but never sends an uncertain action again. A saved handoff receipt is not proof that the task completed. Removing or editing a schedule cannot resurrect it from an older JSON copy.

You can also ask dant in chat or a call to arrange work. The shared `schedule_list`, `schedule_save` and `schedule_delete` tools manage the same entries. dant must use the intended time zone and confirm the saved result before claiming a task is scheduled. Due jobs wait while the work computer is unavailable, in a call or under human control. Closing the window to the tray keeps the service available; removing a schedule does not stop work already dispatched.
