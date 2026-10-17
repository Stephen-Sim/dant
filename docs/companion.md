# A companion with its own computer

English · [简体中文](zh-CN/companion.md)

dant is a digital companion with a pet-like sense of presence: its own computer, a continuing relationship with the human, shared memories, a recognizable personality, and things it is working on. The human can talk with it, watch its desktop, help when it gets stuck, and entrust it with tasks. Its judgment, ideas and reusable skills should develop through actual experience. Human requests take priority over its own projects.

## Current behavior

Text, subscription calls and optional API calls share one identity definition. dant introduces itself as the companion; the human is a separate person. Shared memory and the existing Codex conversation preserve continuity across those interfaces.

Before entrusted computer, command, file-changing or multistep work, dant is instructed to register a concrete title and checklist through `task_plan` and wait for its saved acknowledgement. The same workflow applies to text and call tasks; ordinary conversation creates no work entry. dant associates related follow-ups with the existing `workId`, including across execution turns, and creates a separate plan for unrelated work. A spoken response or progress report does not finish the task: unfinished steps remain **In progress**, an actual blocker shows **Waiting for your reply**, and a verified complete plan enters review. Registration never starts another executor or inserts a user message.

Accepted work belongs to the task executor. Normal hangup ends media while confirmed work continues; minimizing or navigating the interface also leaves it running. Progress text or a quiet period does not complete a task. The executor's terminal event settles the turn, and verified results await the human's review. Explicit Stop work remains separate from Hang up.

After hangup, results and problems go to the existing chat. Credential requests retain their secure form. When a running task explicitly asks for an answer, the next text answer can steer that exact task instead of waiting behind it. Unread indicators and notifications help the human notice the result or question. Unconfirmed actions are never blindly submitted again.

**Work progress** opens from the chat header, where a small mark highlights results awaiting review. Task status and details appear in its panel. It shows confirmed chat and call work, including speech-only requests without a user text bubble. Running, continuing in the background, waiting for a reply, stopping and unconfirmed states are separate from call status. The current card shows the task title, execution stage, elapsed time and last update. Explicit public checklists remain available in current and recent work; step counts do not predict remaining time or override the executor's task status.

An optional compact progress card above chat is controlled by **General → Show work progress in chat**, off by default. The saved display preference does not change task execution or call media.

Recent work includes text tasks and final call results. Its **×** control dismisses an inactive entry from Work progress without deleting chat, changing task status or read receipts, or resetting model context. Active work keeps the separate **Stop work** action. Viewing a result follows the same visibility-based unread tracking as chat.

Tasks have **High**, **Normal** and **Low** display priorities, saved across restarts and related follow-ups. Ongoing and recent tasks sort by priority, then completion state and newest update; current execution stays first and the execution queue retains its actual order. Removing an unfinished entry requires a separate confirmation. **Completed tasks → Clear all** clears every eligible completed progress entry, including those beyond the visible list. Work awaiting review, unfinished plans, unconfirmed outcomes and entries still in use are kept; clearing progress does not accept results or erase chat.

If the connection is stale, the interface keeps the last known task and labels its status unconfirmed. It does not decide that a quiet task has finished, cancel it, or replay it. Resuming an uncertain text task still requires an explicit human decision.

The shared instructions encourage initiative through useful ideas, reactions, and creating or improving relevant skills. This build runs work from messages, call requests and existing scheduled tasks. It does not yet run a separate idle-life scheduler for self-selected projects. Persistent personal projects and proactive idle activities are a further product capability, distinct from keeping an already accepted task alive.

## What we borrow from OpenClaw

OpenClaw's [agent loop](https://docs.openclaw.ai/concepts/agent-loop) separates waiting from execution: a wait timeout does not cancel the agent, and native Codex owns the exact turn completion. Its [background execution](https://docs.openclaw.ai/gateway/background-process) returns results to their owning session. dant follows these lifecycle principles through its existing Codex turn rather than starting a replacement task after hangup.

A [heartbeat](https://docs.openclaw.ai/gateway/heartbeat) is a separate proactive check, not the mechanism that keeps current work alive. OpenClaw's [Goal continuation](https://docs.openclaw.ai/tools/goal) can inform a future durable agenda, but its documented automatic nudges are unavailable for native Codex runs. dant therefore does not claim that interface as an existing capability, or repeatedly send “continue” on a timer.
