# A companion with its own computer

English · [简体中文](zh-CN/companion.md)

dant is a digital companion with a pet-like sense of presence: its own computer, a continuing relationship with the human, shared memories, a recognizable personality, and things it is working on. The human can talk with it, watch its desktop, help when it gets stuck, and entrust it with tasks. Its judgment, ideas and reusable skills should develop through actual experience. Human requests take priority over its own projects.

## Current behavior

Text, subscription calls and optional API calls share one identity definition. dant introduces itself as the companion; the human is a separate person. Shared memory and the existing Codex conversation preserve continuity across those interfaces.

The current **Memory & personality** page exposes those fixed identity instructions and the actual saved reference notes. There is no separate evolving personality profile or automatic extraction of durable memories from conversation. dant must explicitly save useful facts and preferences through `memory_write`; the conversation thread continues independently. See [durable memory](context.md#durable-memory-and-personality).

Chat shows time between message groups. Hover over a message or call bubble to see its full local date and time.

For every accepted real task, including simply sending a link or file, dant is instructed to register a concrete title and checklist through `task_plan` and wait for its saved acknowledgement. If the request needs clarification, it first records `status: waiting_user` with at least one pending step and no step in progress, then asks for the missing information. The same workflow applies to text and call tasks; ordinary conversation and questions only asking for progress create no new work entry. dant identifies related work from its actual saved `workId` rather than guessing the most recent task, including across execution turns; unrelated work gets a separate plan. A spoken response or progress report does not finish the task: unfinished steps remain **In progress**, an actual blocker shows **Waiting for your reply**, and a verified complete plan enters review. Registration never starts another executor or inserts a user message.

Human-requested revisions to a result awaiting review can continue the same task. An automatic public plan recorded first in the new turn does not force a separate recovery task; explicit registration can attach that temporary record to the original work ID. Accepted completed work stays closed. When an execution turn ends with unfinished work, the VM supervisor checks it every 30 seconds and about 5 seconds after a state change, including turn completion. Once the shared executor is free, it can continue the same task in the same conversation and work ID without inserting a human message or restarting call media. The current execution card still shows whether an executor is actually running; an ongoing entry alone does not claim active execution.

Accepted work belongs to the task executor. Normal hangup ends media while confirmed work continues; minimizing or navigating the interface also leaves it running. Progress text or a quiet period does not complete a task. The executor's terminal event settles the turn, and verified results await the human's review. Explicit Stop work remains separate from Hang up.

Automatic follow-ups continue actual remaining actions in the same task. Routine narration, interim screenshots and heartbeat acknowledgements do not create chat messages or completion notifications. A verified final result, execution failure or genuine request for human input can be delivered; ordinary human-origin conversation remains responsive.

After hangup, results and problems go to the existing chat. Credential requests retain their secure form. When a running task explicitly asks for an answer, the next text answer can steer that exact task instead of waiting behind it. Unread indicators and notifications help the human notice the result or question. Unconfirmed actions are never blindly submitted again.

**Work progress** opens from the chat header, where a small mark highlights results awaiting review. Task status and details appear in its panel. It shows confirmed chat and call work, including speech-only requests without a user text bubble. Running, continuing in the background, waiting for a reply, stopping and unconfirmed states are separate from call status. The current card shows the task title, execution stage, elapsed time and last update. Explicit public checklists remain available in current and recent work; step counts do not predict remaining time or override the executor's task status.

An optional compact progress card above chat is controlled by **General → Show work progress in chat**, off by default. The saved display preference does not change task execution or call media.

Recent work includes text tasks and final call results. Its **×** control dismisses an inactive entry from Work progress without deleting chat, changing task status or read receipts, or resetting model context. Active work keeps the separate **Stop work** action. Viewing a result follows the same visibility-based unread tracking as chat.

Tasks have **High**, **Normal** and **Low** display priorities, saved across restarts and related follow-ups. Ongoing and recent tasks sort by priority, then completion state and newest update; current execution stays first and the execution queue retains its actual order. Removing an unfinished entry requires a separate confirmation. **Completed tasks → Clear all** clears every eligible completed progress entry, including those beyond the visible list. Work awaiting review, unfinished plans, unconfirmed outcomes and entries still in use are kept; clearing progress does not accept results or erase chat.

If the connection is stale, the interface keeps the last known task and labels its status unconfirmed. It does not decide that a quiet task has finished, cancel it, or replay it. Resuming an uncertain text task still requires an explicit human decision.

The shared instructions encourage initiative through useful ideas, reactions, and creating or improving relevant skills. This build runs work from messages, call requests and existing scheduled tasks. It does not yet run a separate idle-life scheduler for self-selected projects. Persistent personal projects and proactive idle activities are a further product capability, distinct from keeping an already accepted task alive.

## What we borrow from OpenClaw

OpenClaw's [agent loop](https://docs.openclaw.ai/concepts/agent-loop) separates waiting from execution: a wait timeout does not cancel the agent, and native Codex owns the exact turn completion. Its [background execution](https://docs.openclaw.ai/gateway/background-process) returns results to their owning session. dant follows these lifecycle principles through its existing Codex turn rather than starting a replacement task after hangup.

A [heartbeat](https://docs.openclaw.ai/gateway/heartbeat) is a separate proactive check. dant uses its own supervisor for already entrusted unfinished work, rather than claiming OpenClaw's [Goal continuation](https://docs.openclaw.ai/tools/goal) interface as an integrated capability. Checks do not restart work while the executor is busy, waiting for the user, paused or cancelled, or when a submission or call handoff is unconfirmed. An uncertain submission is never automatically replayed. Rounds without qualifying execution evidence or changed checklist progress use increasing delays; after three such automatic follow-ups, the task pauses with an explanation so the human can inspect it or provide more instructions. Fresh successful execution output allows a bounded extension even if the checklist has not advanced; failed actions and repeated unchanged checks do not.
