export const TASK_LIST_SCHEMA = Object.freeze({});
export const TASK_LIST_DESCRIPTION =
  'List saved tasks in this conversation with their actual workId, title, status and completed/total step counts. Use this read-only list to identify the matching task before cancellation; never guess IDs. Listing never executes, restarts, cancels or completes work.';
export const TASK_CANCEL_SCHEMA = Object.freeze({
  workId: { type: 'string', minLength: 1, maxLength: 128 },
});
export const TASK_CANCEL_DESCRIPTION =
  'Cancel an existing task in this conversation by its exact workId when the human requests cancellation or the task is explicitly abandoned or superseded. Supports current acknowledged running/waiting work and saved continuing/waiting_user tasks; the application verifies execution ownership. Paused, failed, review, completed and unconfirmed records require Work progress review. Preserves cancelled history without completing, deleting or starting work. cancelRequested means stopping awaits confirmation; only cancelled:true confirms cancellation.';
export const TASK_CANCEL_INSTRUCTIONS =
  "Use read-only task_list (also available through dant_desktop MCP) to see the actual saved tasks in this conversation, their workIds and current status before choosing a task to cancel. Match the human's request to the actual task; never guess an ID. Listing is reference only and never starts or resumes work. Use task_cancel with that exact workId when the human asks to cancel the task, or when that task has explicitly been abandoned or superseded. Cancellation supports current acknowledged running/waiting execution and saved continuing/waiting_user tasks, subject to application ownership and stop checks. Do not use it for paused, failed, review, completed or unconfirmed records; review those in Work progress instead. A paused state alone does not prove execution has stopped. Use the tool instead of merely saying that work was cancelled or marking unfinished steps completed. Do not infer cancellation from silence, waiting for a reply, ending a response, hanging up, closing a window, or an ordinary follow-up. Cancellation keeps the task history and does not complete, delete, restart, or replace the task. Report cancellation as confirmed only when the result contains cancelled:true. A cancelRequested:true result acknowledges a stop request while the executor is still stopping; do not claim it has already stopped or retry automatically if the result is unconfirmed.";

export function taskListInput(args) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
    Object.keys(args).length
  )
    throw Error('A task list requires empty arguments.');
  return {};
}

export function taskCancelInput(args) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
    Object.keys(args).length !== 1 ||
    Object.keys(args)[0] !== 'workId' ||
    typeof args.workId !== 'string' ||
    !args.workId ||
    args.workId.length > 128 ||
    /[\x00-\x20\x7f]/.test(args.workId)
  )
    throw Error('A task cancellation requires one existing workId.');
  return args.workId;
}
