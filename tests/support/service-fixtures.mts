import assert from 'node:assert/strict';
import { isRecord } from '../../ui/shared/json.mts';

export function unexpectedFixtureOperation(): never {
  throw Error('Unexpected fixture operation. Configure this operation explicitly in the test.');
}

export function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

export function observedRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), 'Expected a fixture object.');
  return value;
}

export function observedRecords(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), 'Expected a fixture array.');
  return value.map(observedRecord);
}

export function observedArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'Expected a fixture array.');
  return value;
}

export function observedString(value: unknown): string {
  assert.ok(typeof value === 'string', 'Expected a fixture string.');
  return value;
}
