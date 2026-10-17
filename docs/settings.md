# Settings

English · [简体中文](zh-CN/settings.md)

Settings is organized into a category menu: General, Appearance, Voice, Work computer, ChatGPT, Credentials, Chat & data, Telegram, and About. On narrow windows, the menu uses a compact layout.

Use **Search settings** to find a setting across all categories. English and Chinese names and keywords work in either interface language. Selecting a result opens its category and focuses the matching control, including controls inside advanced sections.

Search uses a fixed catalog of setting names and help keywords. It does not search chat history, credential values or account details. Chat history search is a separate chat action.

Switching categories preserves local form drafts and an ongoing call. Some settings require a connected work computer; appearance, application version and update checks are handled locally. See [updates](updates.md).

## Chat and call controls

Each ordinary chat message shows its original sent time. Day and long-gap separators remain separate from those labels; editing a message does not change its original time. Completed dant replies also show **Read** or **Unread**. The sidebar badge counts unread replies, and the **unread messages** button scrolls to the first one.

An actual bubble must remain in view for 450 ms in the focused foreground text chat before it is marked read. Minimizing the app, showing the full call view, switching pages or opening a modal stops that tracking. Restoring the window or receiving a notification does not mark unseen replies read. Receipts are saved in the VM conversation; native notification delivery is a separate record.

Enable **Message notifications** in General to receive alerts for unread results or requests for input. A notification means dant has a message for you; it does not necessarily mean the task has finished. Native alerts require the Windows app to remain running and notification permission to be granted.

**Minimize to chat** displays a draggable horizontal call bar with the avatar on the left. Minimizing the Windows app or closing its main window to the system tray during an active call displays a separate desktop bar, initially above the taskbar at the bottom right. Drag its background to move it; its expand control restores the main window. It hides when the main window returns or the call ends. Both bars control the existing call, microphone and timer, without creating another audio session. Browser mode uses the in-app bar.

**Take control** remains available during a confirmed connected call and keeps its audio connected. Input waits until the exact running work has stopped and the VM confirms your control lease; queued work pauses. **Return to dant** does not replay tasks. Give a new instruction in the call when ready to continue. Connecting, stopping or unconfirmed call states still block new takeover; returning an existing lease remains available.

Attachment download buttons keep chat and image previews open. Desktop **Save As** uses the original file name and extension by default; browser mode starts a file download. Cancelling leaves the current view intact.

Attachments in one message use consistent spacing. File cards keep the filename, **View** and download button inside the same border. Images reserve space while loading and show a stable error message if loading fails; this changes the presentation, not transfer speed.

Text and code attachments have **View** and a separate download control. Click the filename in chat or conversation details to open a closable plain-text preview. JSON is formatted without changing number values; deeply nested or oversized formatting falls back to the complete original text. Previews accept UTF-8 text up to 1 MiB. Larger files remain available through download or the desktop editor. HTML and SVG source stays inert text; links, markup and scripts do not execute.

In **General → Text editor**, keep Windows Notepad or choose an installed supported editor executable, such as VS Code, Notepad++, Sublime Text, Zed or Cursor. **Open in editor** opens a local copy of a text attachment, up to 10 MiB, without changing the chat attachment. The app launches the selected editor directly rather than using script file associations. Unchanged cached copies expire after three days; edits to a previously opened copy are preserved.

Reusable skills use their own sidebar page rather than a settings category. It includes **Import skill** with a preview and **Download ZIP** on each managed card. See [credentials and skills](credentials-and-skills.md).

## Background operation on Windows

Closing the main window with **X** hides dant to the Windows system tray. The app, call and accepted tasks keep running; closing the window does not pause or cancel work. Click the tray icon or choose **Open dant** to restore the same window. Launching dant again also restores the existing instance.

The tray shows a brief online/work/waiting status and queue count. **Work progress** opens the task panel directly. Tray text never contains messages, task titles, file names or credentials. Cached or disconnected active work is labelled unconfirmed rather than assumed complete.

Choose **Exit dant** in the tray menu to end the application through its normal shutdown path. Use this before installing an update. If the operating system cannot create the tray icon, closing the main window exits normally so there is no inaccessible hidden app. The tray does not start dant automatically after Windows restarts.
