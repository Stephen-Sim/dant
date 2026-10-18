# Version and updates

English · [简体中文](zh-CN/updates.md)

Open **Settings → About dant** to see the current application version. The version remains visible when the VM is disconnected.

Choose **Stable** or **Beta**, then select **Check for updates**. Stable checks published formal releases; Beta also includes published prereleases and selects the newest version. The choice is saved on this computer. Switching channels does not install or downgrade anything.

Checks query public releases of [Stephen-Sim/dant](https://github.com/Stephen-Sim/dant/releases) on Windows and do not require VM access, ChatGPT sign-in or an API key. GitHub receives ordinary release requests; dant does not send conversation content or credentials. Checks run when requested, with separate short-lived caches for each channel.

For a supported installed Windows application, **Download update** downloads the official installer in the background and verifies its published size and SHA-256 digest. Chat, calls and work continue while downloading, including when you leave Settings. **Install and restart** is a separate action available after verification. It closes the local application and its owned Controller, installs the update and starts dant again after confirming success. The VM Worker and its running tasks are left running. A live call, recording, dictation, human computer control, provisioning or uncertain connection state prevents installation until it is safe to restart. A download remains available while these activities continue. If installation fails after the local app exits, a fixed error notice explains that you need to reopen dant; it does not automatically launch a partially updated application.

Before an update restart, dant saves the current unsent chat text, reply and uploaded attachment references in a bounded, short-lived local draft scoped to the same work computer and conversation. Recorded audio drafts must be sent or discarded first. Secure input values are not saved in this draft.

**View update** opens the release page for its notes and manual installer or portable downloads. Manual installation still requires exiting dant through the tray menu. If an installer cannot be verified or the current application layout does not support automatic installation, use the release page instead.

A failed or rate-limited request shows a retry message rather than claiming the application is current. A failed or incomplete download cannot be installed.
