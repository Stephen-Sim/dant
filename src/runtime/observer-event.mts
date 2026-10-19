import { isRecord } from '../contracts/json.mts';
import type { RpcEvent, RpcItem } from './protocol.ts';
interface ObserverMetadata {
  itemType?: string;
  itemStatus?: string;
  itemId?: string;
}
type ProjectionKind = 'image' | 'payload';
import { inheritTaskExecutionEvent } from '../work/task-progress.mts';
import { inheritContinuationExecutionEvidence } from '../work/continuation-execution.mts';

const ITEM_BYTES = 64 * 1024,
  AGENT_TEXT_CHARS = 120000;
const itemTypes = new Set([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
]);
const itemStatuses = new Set([
  'inProgress',
  'completed',
  'failed',
  'declined',
  'interrupted',
  'cancelled',
]);
const deliveryTools = new Set(['send_chat_message', 'create_voice_message', 'react_message']);
const projections = new WeakMap<object, ProjectionKind>();
const identity = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(value);
const diagnosticId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) &&
  !/(?:^|[.:/])(?:sk[-_]|gh[pousr]_|xox[baprs]-|Bearer|eyJ[A-Za-z0-9_-]{10,}\.)/i.test(value);

/** Fixed schema metadata only: never tool names, arguments, output or speech. */
export function observerEventMetadata(event: unknown) {
  const params = isRecord(event) && isRecord(event.params) ? event.params : {};
  const item = isRecord(params.item) ? params.item : undefined,
    metadata: ObserverMetadata = {};
  if (item) {
    metadata.itemType =
      typeof item.type === 'string' && itemTypes.has(item.type) ? item.type : 'other';
    if (typeof item.status === 'string' && itemStatuses.has(item.status))
      metadata.itemStatus = item.status;
  }
  const id = item?.id ?? params.itemId;
  if (diagnosticId(id)) metadata.itemId = id;
  return metadata;
}

/** Projection bookkeeping stays outside the protocol object. */
export function getObserverProjectionKind(event: unknown) {
  return event && typeof event === 'object' ? projections.get(event) || null : null;
}
type ObserverItem = Record<string, unknown> & { id: string; type: string };
function projected(event: RpcEvent, item: Record<string, unknown>, kind: ProjectionKind): RpcEvent {
  const result = { ...event, params: { ...event.params, item } };
  projections.set(result, kind);
  return inheritContinuationExecutionEvidence(event, inheritTaskExecutionEvent(event, result));
}
function itemMetadata(item: ObserverItem): RpcItem {
  const result: RpcItem = { id: item.id, type: item.type };
  if (typeof item.status === 'string' && itemStatuses.has(item.status)) result.status = item.status;
  if (typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode))
    result.exitCode = item.exitCode;
  if (
    typeof item.durationMs === 'number' &&
    Number.isFinite(item.durationMs) &&
    item.durationMs >= 0
  )
    result.durationMs = item.durationMs;
  return result;
}

/**
 * Codex has already consumed these notification payloads. Retain only what the
 * native voice observer uses, while leaving the original model result intact.
 * Requests, unknown shapes and control events keep the existing safety budget.
 */
function observerEvent(value: unknown): value is RpcEvent {
  return (
    isRecord(value) &&
    typeof value.method === 'string' &&
    isRecord(value.params) &&
    (value.id === undefined ||
      value.id === null ||
      typeof value.id === 'string' ||
      typeof value.id === 'number')
  );
}
export function prepareObserverEvent(event: RpcEvent): RpcEvent;
export function prepareObserverEvent(event: unknown): unknown;
export function prepareObserverEvent(event: unknown): unknown {
  if (!observerEvent(event)) return event;
  if (!event || event.id !== undefined || projections.has(event)) return event;
  if (event.method === 'item/agentMessage/delta') {
    const p = event.params;
    if (!identity(p?.itemId) || typeof p.delta !== 'string' || p.delta.length <= AGENT_TEXT_CHARS)
      return event;
    const result = { ...event, params: { ...p, delta: p.delta.slice(0, AGENT_TEXT_CHARS) } };
    projections.set(result, 'payload');
    return result;
  }
  if (!['item/started', 'item/completed'].includes(event.method)) return event;
  const inputItem = event.params?.item;
  if (
    !isRecord(inputItem) ||
    typeof inputItem.type !== 'string' ||
    !itemTypes.has(inputItem.type) ||
    !identity(inputItem.id)
  )
    return event;
  let item: ObserverItem = { ...inputItem, id: inputItem.id, type: inputItem.type };
  let observed = event;
  const toolResult = isRecord(item.result) ? item.result : {};
  if (item.type === 'mcpToolCall' && Array.isArray(toolResult.content)) {
    let changed = false;
    const content = toolResult.content.map((block: unknown) => {
      if (!isRecord(block) || block.type !== 'image' || typeof block.data !== 'string')
        return block;
      changed = true;
      const { data, ...metadata } = block;
      return metadata;
    });
    if (changed) {
      item = { ...item, result: { ...toolResult, content } };
      observed = projected(event, item, 'image');
    }
  }
  if (Buffer.byteLength(JSON.stringify(item)) <= ITEM_BYTES) return observed;
  if (item.type === 'agentMessage') {
    if (typeof item.text !== 'string') return observed;
    return projected(
      observed,
      { ...itemMetadata(item), text: item.text.slice(0, AGENT_TEXT_CHARS) },
      'payload',
    );
  }
  // These three tools deliver visible chat effects. Preserve their exact matching
  // arguments, structured markers and status for Engine.acceptMcpResult validation.
  if (
    item.type === 'mcpToolCall' &&
    event.method === 'item/completed' &&
    item.server === 'dant_desktop' &&
    typeof item.tool === 'string' &&
    deliveryTools.has(item.tool) &&
    item.status === 'completed' &&
    !item.error &&
    !toolResult.isError
  )
    return observed;
  return projected(observed, itemMetadata(item), 'payload');
}
