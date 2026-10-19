import { isRecord } from '../contracts/json.mts';
import type {
  RpcResult,
  RpcThread,
  RpcTurn,
  RpcItem,
  RpcEvent,
  RpcContentBlock,
  RpcToolResult,
} from './protocol.ts';

const ITEM_STRING_FIELDS = [
  'status',
  'text',
  'role',
  'server',
  'tool',
  'callId',
  'handoff_id',
  'item_id',
  'itemId',
  'sourcePath',
  'cwd',
  'input_transcript',
  'realtimeSessionId',
  'realtime_session_id',
];
const RESULT_STRING_FIELDS = ['status', 'authUrl', 'loginId'];
function optionalStrings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => value[field] === undefined || typeof value[field] === 'string');
}
function rpcContent(value: unknown): value is RpcContentBlock {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    optionalStrings(value, ['text', 'data', 'mimeType'])
  );
}
function rpcToolResult(value: unknown): value is RpcToolResult {
  return (
    isRecord(value) &&
    (value.isError === undefined || typeof value.isError === 'boolean') &&
    (value.content === undefined || Array.isArray(value.content))
  );
}
export function isRpcItem(value: unknown): value is RpcItem {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    !optionalStrings(value, ITEM_STRING_FIELDS)
  )
    return false;
  if (
    !['phase', 'aggregatedOutput'].every(
      (field) =>
        value[field] === undefined || value[field] === null || typeof value[field] === 'string',
    )
  )
    return false;
  if (value.exitCode !== undefined && value.exitCode !== null && typeof value.exitCode !== 'number')
    return false;
  if (
    value.durationMs !== undefined &&
    value.durationMs !== null &&
    typeof value.durationMs !== 'number'
  )
    return false;
  if (
    value.error !== undefined &&
    value.error !== null &&
    typeof value.error !== 'string' &&
    (!isRecord(value.error) || !optionalStrings(value.error, ['message']))
  )
    return false;
  if (value.result !== undefined && value.result !== null && !rpcToolResult(value.result))
    return false;
  if (
    value.content !== undefined &&
    (!Array.isArray(value.content) ||
      !(value.type === 'reasoning'
        ? value.content.every((part: unknown) => typeof part === 'string')
        : value.content.every(rpcContent)))
  )
    return false;
  if (
    value.changes !== undefined &&
    (!Array.isArray(value.changes) ||
      !value.changes.every(
        (change: unknown) =>
          isRecord(change) &&
          optionalStrings(change, ['path', 'diff']) &&
          (change.kind === undefined ||
            typeof change.kind === 'string' ||
            (isRecord(change.kind) && optionalStrings(change.kind, ['type']))),
      ))
  )
    return false;
  if (
    value.commandActions !== undefined &&
    (!Array.isArray(value.commandActions) ||
      !value.commandActions.every(
        (action: unknown) => isRecord(action) && optionalStrings(action, ['type']),
      ))
  )
    return false;
  if (
    value.active_transcript !== undefined &&
    (!Array.isArray(value.active_transcript) ||
      !value.active_transcript.every(
        (part: unknown) =>
          isRecord(part) && typeof part.role === 'string' && typeof part.text === 'string',
      ))
  )
    return false;
  return true;
}
function rpcTurn(value: unknown): value is RpcTurn {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    optionalStrings(value, ['status']) &&
    (value.items === undefined || (Array.isArray(value.items) && value.items.every(isRpcItem))) &&
    (value.startedAt === undefined ||
      value.startedAt === null ||
      typeof value.startedAt === 'number') &&
    (value.error === undefined ||
      value.error === null ||
      (isRecord(value.error) && optionalStrings(value.error, ['message'])))
  );
}
function rpcThread(value: unknown): value is RpcThread {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.turns === undefined || (Array.isArray(value.turns) && value.turns.every(rpcTurn))) &&
    (value.status === undefined ||
      typeof value.status === 'string' ||
      (isRecord(value.status) && typeof value.status.type === 'string'))
  );
}
/** Validate the known response fields before handing protocol data to task code. */
export function readRpcResult(value: unknown): RpcResult {
  if (
    !isRecord(value) ||
    !optionalStrings(value, RESULT_STRING_FIELDS) ||
    (value.thread !== undefined && !rpcThread(value.thread)) ||
    (value.turn !== undefined && !rpcTurn(value.turn)) ||
    (value.account !== undefined &&
      value.account !== null &&
      (!isRecord(value.account) ||
        !optionalStrings(value.account, ['type', 'email', 'planType']))) ||
    (value.authMode !== undefined &&
      value.authMode !== null &&
      typeof value.authMode !== 'string') ||
    (value.requiresOpenaiAuth !== undefined && typeof value.requiresOpenaiAuth !== 'boolean') ||
    (value.voices !== undefined &&
      (!isRecord(value.voices) ||
        (value.voices.v3 !== undefined &&
          (!Array.isArray(value.voices.v3) ||
            !value.voices.v3.every((voice: unknown) => typeof voice === 'string')))))
  )
    throw Error('The VM executor returned an invalid response.');
  // Properties are narrowed individually; unrecognized provider fields remain opaque.
  return {
    ...value,
    ...(rpcThread(value.thread) ? { thread: value.thread } : {}),
    ...(rpcTurn(value.turn) ? { turn: value.turn } : {}),
  };
}

/** Provider notifications are untrusted until their known protocol fields validate. */
export function readRpcEvent(value: unknown): RpcEvent | null {
  if (
    !isRecord(value) ||
    typeof value.method !== 'string' ||
    (value.id !== undefined &&
      value.id !== null &&
      typeof value.id !== 'string' &&
      typeof value.id !== 'number')
  )
    return null;
  const params = value.params === undefined ? {} : value.params;
  if (!isRecord(params)) return null;
  return { method: value.method, params, ...(value.id !== undefined ? { id: value.id } : {}) };
}
