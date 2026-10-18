# Settings

English · [简体中文](zh-CN/settings.md)

Settings is organized into a category menu: General, Appearance, Voice, Work computer, ChatGPT, Usage, Credentials, Chat & data, Telegram, and About. On narrow windows, the menu uses a compact layout.

**Connect my computer** in the welcome screen or disconnected Computer panel opens **Settings → Work computer** directly and focuses the connection card. Any settings search is cleared, while connection form drafts are preserved. Opening this category does not save a configuration or start a connection.

Use **Search settings** to find a setting across all categories. English and Chinese names and keywords work in either interface language. Selecting a result opens its category and focuses the matching control, including controls inside advanced sections.

Search uses a fixed catalog of setting names and help keywords. It does not search chat history, credential values or account details. Chat history search is a separate chat action.

**Chat & data → Memory & personality** shows dant's actual shared identity and durable reference notes from the work computer. These are the same references used by chat and both voice providers, with credential values omitted. The view is read-only and can be refreshed; a previously loaded copy is labelled when the computer is offline. Scheduled tasks remain in the sidebar.

**Shared personality** currently displays the fixed shared identity instructions, not a separate evolving personality file. **Current memory** displays the full safe contents of `identity.md` and `working-memory.md`. A heading with no notes can be the file's actual saved content, rather than a loading or display limit. Durable notes change only when explicitly saved, such as through dant's `memory_write` tool; chat and call history are separate, and there is no automatic memory consolidation. See [shared context and durable memory](context.md#durable-memory-and-personality).

Switching categories preserves local form drafts and an ongoing call. Some settings require a connected work computer; appearance, application version and update checks are handled locally. See [updates](updates.md).

## Token usage

**Settings → Usage** shows the provider-reported input, cached input, output, reasoning output and total tokens received by dant. ChatGPT work and optional API voice are counted separately, with recorded totals and the latest model response. Cached input is already included in input; reasoning output is already included in output. Missing fields remain unavailable, rather than appearing as zero. These statistics do not represent account quota or a bill.

Usage receipts are saved on the work computer and deduplicated across reconnects and restarts. ChatGPT figures come from cumulative Codex thread usage; API voice figures come from completed response receipts. Native voice media without a usage receipt is not estimated. Old API calls with no saved receipt cannot be reconstructed. Offline statistics are labelled as saved data.

## Chat and call controls

Chat shows a time divider at the start of the conversation, on a new day, and after gaps longer than 30 minutes. Each message's original sent time remains saved and does not change when edited. Completed dant replies show **Read** or **Unread**. The sidebar badge counts unread replies, and the **unread messages** button scrolls to the first one.

Your message shows one check after it is saved, and two after the executor acknowledges its delivery. This confirms receipt, not comprehension or task completion. New chat messages go to the current task when it can accept followups; otherwise they wait in the queue. Explicitly resumed and scheduled tasks keep their separate queue behavior. A background task left by a subscription call accepts text followups; its attachments wait for a separate task.

While a call is connected, typed text goes to that same call and dant responds aloud. Quoted replies carry the original message and speaker; both voice providers share the same conversation memory. Work progress remains available from its header button, and task checklist expansion survives status refreshes and reopening the panel.

The full call view shows dant's current spoken response as live captions below the avatar, for subscription and API calls. Captions use existing speech transcript events, are credential-redacted and stay separate from chat history. They clear when interrupted, replaced or hung up, and eight seconds after a finalized utterance. The compact call bar keeps its existing layout.

You can start a call while a confirmed task is running, including work continuing after an earlier call. The existing task and secure input requests keep their identity and progress. Connection failure or ordinary hangup does not pause that work; uncertain call or execution ownership still needs confirmation before another connection.

Opening, closing or resizing the Computer panel keeps the chat at the message you are viewing. A chat already at the bottom stays there; reading older messages does not force a jump to the newest message. Delayed image loading also preserves the current view. Search, unread-message and task-result navigation still move to the selected message.

Use the **×** or **Cancel current work** control in Work progress to cancel selected work, with confirmation. A confirmed cancellation moves it to Recent tasks as **Cancelled**, retaining its steps, results and files. Unconfirmed stops remain visible; unrelated queued tasks and the current call are preserved. Cancelled tasks do not resume automatically or count toward Clear completed. You can also ask dant to find a task through `task_list` and cancel it through `task_cancel`.

**Pause** stops only the selected current or ongoing task, retaining its identity, checklist and partial results. It stays **Paused** until you choose **Resume**; the automatic supervisor skips paused work. Resume keeps the same work ID and waits for the shared executor to become available. The call and unrelated queue entries remain intact. An unconfirmed stop or stale task identity cannot be reported as a successful pause or silently resumed.

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

In **General → Text editor**, keep Windows Notepad or choose an installed supported editor executable, such as VS Code, Notepad++, Sublime Text, Zed or Cursor. **Open in editor** opens a local copy of a text attachment, up to 10 MiB, without changing the chat attachment. The app launches the selected editor directly rather than using script file associations. Unchanged cached copies expire after three days; edits to a previously opened copy are preserved.

Reusable skills use their own sidebar page rather than a settings category. It includes **Import skill** with a preview and **Download ZIP** on each managed card. See [credentials and skills](credentials-and-skills.md).

## Background operation on Windows

Closing the main window with **X** hides dant to the Windows system tray. The app, call and accepted tasks keep running; closing the window does not pause or cancel work. Click the tray icon or choose **Open dant** to restore the same window. Launching dant again also restores the existing instance.

The tray shows a brief online/work/waiting status and queue count. **Work progress** opens the task panel directly. Tray text never contains messages, task titles, file names or credentials. Cached or disconnected active work is labelled unconfirmed rather than assumed complete.

Choose **Show call window** in the tray menu to restore a hidden desktop call bar. This action is unavailable without a current call.

Choose **Exit dant** in the tray menu to end the application through its normal shutdown path. Use this before manually installing an update; the in-app updater handles its own restart. If the operating system cannot create the tray icon, closing the main window exits normally so there is no inaccessible hidden app. The tray does not start dant automatically after Windows restarts.

## Scheduled tasks

The clock beside Skills in the left sidebar opens **Scheduled tasks**. Search or filter upcoming, paused and past entries; create or edit a task, pause it, or remove it. New tasks use your computer's time zone; editing preserves the task's saved zone, shown beside its date/time field. Entries display the saved execution time and zone. These are one-time tasks; creating or editing a schedule saves it without immediately running its instructions.

You can also ask dant in chat or a call to arrange work. The shared `schedule_list`, `schedule_save` and `schedule_delete` tools manage the same entries. dant must use the intended time zone and confirm the saved result before claiming a task is scheduled. Due jobs wait while the work computer is unavailable, in a call or under human control. Closing the window to the tray keeps the service available; removing a schedule does not stop work already dispatched.
