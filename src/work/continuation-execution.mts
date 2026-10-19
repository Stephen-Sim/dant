import { isRecord, includesValue } from '../contracts/json.mts';
interface ExecutionEvidence {
  kind: 'strong' | 'bounded';
  hash: string;
}
interface WorkEvidence {
  checkpoint: string;
  hashes: Set<string>;
  boundedAttempts: Set<string>;
  boundedRounds: number;
}
import { createHash } from 'node:crypto';

export const CONTINUATION_EXECUTION_EXTENSION_LIMIT = 20;
const MAX_HASHES = 128,
  MAX_WORKS = 300,
  MAX_TEXT = 65536;
const mutations = new Set(['click', 'drag', 'key', 'type_text', 'scroll']);
const readActions = new Set(['read', 'listFiles', 'search']);
const projectedEvidence = new WeakMap<object, ExecutionEvidence>();
const identity = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x20\x7f]/.test(value);
const fingerprint = (type: string, values: readonly string[]) => {
  const hash = createHash('sha256');
  hash.update(type);
  for (const value of values) {
    hash.update('\0' + value.length + '\0');
    if (value.length <= MAX_TEXT) hash.update(value);
    else {
      hash.update(value.slice(0, MAX_TEXT / 2));
      hash.update(value.slice(-MAX_TEXT / 2));
    }
  }
  return hash.digest('hex');
};

function evidence(event: unknown): ExecutionEvidence | null {
  if (!isRecord(event)) return null;
  if (projectedEvidence.has(event)) return projectedEvidence.get(event) ?? null;
  if (event.method !== 'item/completed') return null;
  const params = isRecord(event.params) ? event.params : {};
  const item = isRecord(params.item) ? params.item : {};
  if (!identity(item?.id, 256) || item.status !== 'completed' || item.error) return null;
  if (item.type === 'fileChange') {
    if (!Array.isArray(item.changes) || !item.changes.length || item.changes.length > 128)
      return null;
    const values: string[] = [];
    for (const change of item.changes) {
      if (!isRecord(change)) return null;
      const kind =
        typeof change.kind === 'string'
          ? change.kind
          : isRecord(change.kind)
            ? change.kind.type
            : undefined;
      if (
        typeof change?.path !== 'string' ||
        !change.path ||
        change.path.length > 4096 ||
        !includesValue(['add', 'delete', 'update'], kind) ||
        typeof change.diff !== 'string'
      )
        return null;
      if (change.diff.trim()) values.push(change.path, kind, change.diff);
    }
    return values.length ? { kind: 'strong', hash: fingerprint('fileChange', values) } : null;
  }
  if (item.type === 'commandExecution') {
    if (
      item.exitCode !== 0 ||
      typeof item.aggregatedOutput !== 'string' ||
      !item.aggregatedOutput.trim()
    )
      return null;
    // Protocol-classified reads cannot extend execution. Unknown shell commands
    // are never semantically guessed: changed output only earns a finite grace.
    if (
      Array.isArray(item.commandActions) &&
      item.commandActions.length &&
      item.commandActions.every(
        (action) =>
          isRecord(action) && typeof action.type === 'string' && readActions.has(action.type),
      )
    )
      return null;
    return {
      kind: 'bounded',
      hash: fingerprint('commandExecution', [item.aggregatedOutput.trim()]),
    };
  }
  if (
    item.type === 'mcpToolCall' &&
    item.server === 'dant_desktop' &&
    typeof item.tool === 'string' &&
    mutations.has(item.tool) &&
    (!isRecord(item.result) || item.result.isError !== true)
  ) {
    const toolResult = isRecord(item.result) ? item.result : {};
    let result: unknown = toolResult.structuredContent;
    if (!result) {
      const content = toolResult.content;
      if (
        Array.isArray(content) &&
        content.length === 1 &&
        content[0]?.type === 'text' &&
        typeof content[0].text === 'string' &&
        content[0].text.length <= 4096
      ) {
        try {
          result = JSON.parse(content[0].text);
        } catch {}
      }
    }
    if (isRecord(result) && result.ok === true)
      return { kind: 'bounded', hash: fingerprint('desktop', [item.tool, item.id]) };
  }
  return null;
}

/** Carry only a classification and digest across native observer projection. */
export function inheritContinuationExecutionEvidence<Projected>(
  original: unknown,
  projected: Projected,
): Projected {
  if (projected && typeof projected === 'object') {
    const value = evidence(original);
    if (value) projectedEvidence.set(projected, value);
  }
  return projected;
}

/** Private RAM evidence; it neither authorizes work nor proves task completion. */
export function createContinuationExecutionTracker({
  maxWorks = MAX_WORKS,
}: { maxWorks?: number } = {}) {
  if (!Number.isSafeInteger(maxWorks) || maxWorks < 1 || maxWorks > MAX_WORKS)
    throw Error('Invalid continuation evidence bound.');
  const works = new Map<string, WorkEvidence>();
  return {
    observe(
      {
        workId,
        attemptId,
        checkpoint,
      }: { workId?: unknown; attemptId?: unknown; checkpoint?: unknown } = {},
      event?: unknown,
    ) {
      if (
        !identity(workId, 128) ||
        !identity(attemptId, 128) ||
        typeof checkpoint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(checkpoint)
      )
        return false;
      const value = evidence(event);
      if (!value) return false;
      let work = works.get(workId);
      if (!work || work.checkpoint !== checkpoint) {
        work = { checkpoint, hashes: new Set(), boundedAttempts: new Set(), boundedRounds: 0 };
        works.delete(workId);
        works.set(workId, work);
        while (works.size > maxWorks) {
          const first = works.keys().next();
          if (!first.done) works.delete(first.value);
        }
      }
      if (work.hashes.has(value.hash)) return false;
      work.hashes.add(value.hash);
      while (work.hashes.size > MAX_HASHES) {
        const first = work.hashes.values().next();
        if (!first.done) work.hashes.delete(first.value);
      }
      if (value.kind === 'strong') {
        work.boundedRounds = 0;
        work.boundedAttempts.clear();
        return true;
      }
      if (work.boundedAttempts.has(attemptId)) return true;
      if (work.boundedRounds >= CONTINUATION_EXECUTION_EXTENSION_LIMIT) return false;
      work.boundedRounds++;
      work.boundedAttempts.add(attemptId);
      return true;
    },
    forget(workId: string) {
      works.delete(workId);
    },
    clear() {
      works.clear();
    },
  };
}
