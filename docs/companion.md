# A companion with its own computer

English · [简体中文](zh-CN/companion.md)

dant is a digital companion with a pet-like sense of presence: its own computer, a continuing relationship with the human, shared memories, a recognizable personality, and things it is working on. The human can talk with it, watch its desktop, help when it gets stuck, and entrust it with tasks. Its judgment, ideas and reusable skills should develop through actual experience. Human requests take priority over its own projects.

## Current behavior

Text, subscription calls and optional API calls share one identity definition. dant introduces itself as the companion; the human is a separate person. Shared memory and the existing Codex conversation preserve continuity across those interfaces.

Accepted work belongs to the task executor. Normal hangup ends media while confirmed work continues; minimizing or navigating the interface also leaves it running. Progress text or a quiet period does not complete a task. The executor's terminal event settles the turn, and verified results await the human's review. Explicit Stop work remains separate from Hang up.

After hangup, results and problems go to the existing chat. Credential requests retain their secure form. When a running task explicitly asks for an answer, the next text answer can steer that exact task instead of waiting behind it. Unread indicators and notifications help the human notice the result or question. Unconfirmed actions are never blindly submitted again.

**Work progress** has its own header entry. A chat summary appears while work is active or queued; results awaiting review use a small mark on the header entry instead of a label beside each chat message. It shows confirmed chat and call work, including speech-only requests without a user text bubble. Running, continuing in the background, waiting for a reply, stopping and unconfirmed states are separate from call status. The current card shows the execution stage, elapsed time and last update. Step counts appear only when the executor publishes an explicit plan; they do not predict remaining time.

Recent work includes text tasks and final call results. Its **×** control dismisses an inactive entry from Work progress without deleting chat, changing task status or read receipts, or resetting model context. Active work keeps the separate **Stop work** action. Viewing a result follows the same visibility-based unread tracking as chat.

If the connection is stale, the interface keeps the last known task and labels its status unconfirmed. It does not decide that a quiet task has finished, cancel it, or replay it. Resuming an uncertain text task still requires an explicit human decision.

The shared instructions encourage initiative through useful ideas, reactions, and creating or improving relevant skills. This build runs work from messages, call requests and existing scheduled tasks. It does not yet run a separate idle-life scheduler for self-selected projects. Persistent personal projects and proactive idle activities are a further product capability, distinct from keeping an already accepted task alive.

## What we borrow from OpenClaw

OpenClaw's [agent loop](https://docs.openclaw.ai/concepts/agent-loop) separates waiting from execution: a wait timeout does not cancel the agent, and native Codex owns the exact turn completion. Its [background execution](https://docs.openclaw.ai/gateway/background-process) returns results to their owning session. dant follows these lifecycle principles through its existing Codex turn rather than starting a replacement task after hangup.

A [heartbeat](https://docs.openclaw.ai/gateway/heartbeat) is a separate proactive check, not the mechanism that keeps current work alive. OpenClaw's [Goal continuation](https://docs.openclaw.ai/tools/goal) can inform a future durable agenda, but its documented automatic nudges are unavailable for native Codex runs. dant therefore does not claim that interface as an existing capability, or repeatedly send “continue” on a timer.
