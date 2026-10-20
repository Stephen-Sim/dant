import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { format } from 'prettier';
import {
  stateSchema,
  renderTypeScriptStates,
  renderGoStates,
  renderGoProtocol,
} from '../../scripts/core/generate-contracts.mts';
import * as states from '../../ui/shared/states.mts';

test('every TypeScript state domain exactly matches the shared schema and remains frozen', async () => {
  const schema = stateSchema(
    JSON.parse(
      fs.readFileSync(
        new URL('../../resources/contracts/state-domains.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  for (const [name, values] of Object.entries(schema.domains)) {
    const exported: unknown = Reflect.get(states, name);
    assert.deepEqual(exported, { ...values });
    assert(Object.isFrozen(exported));
  }
  const generated = await format(renderTypeScriptStates(schema), {
    parser: 'typescript',
    singleQuote: true,
    printWidth: 100,
    trailingComma: 'all',
  });
  assert.equal(
    fs.readFileSync(new URL('../../ui/shared/states.mts', import.meta.url), 'utf8'),
    generated,
  );
  assert.equal(
    Object.keys(schema.domains).length,
    Object.values(states).filter((value) => typeof value === 'object').length,
  );
});

test('schema rejects ambiguous names, unsupported versions and duplicate wire values', () => {
  for (const value of [
    null,
    [],
    {},
    { version: 2, domains: {} },
    { version: 1, domains: {} },
    { version: 1, domains: { Status: { Good: 'ok', Also: 'ok' } } },
    { version: 1, domains: { Status: { Good: null } } },
    { version: 1, domains: { Status: { 'bad-key': 'ok' } } },
    { version: 1, domains: { Status: { Good: 'ok' } }, ignored: true },
    { version: 1, domains: { Status: { Good: 'ok' }, StatusGood: { Next: 'next' } } },
  ])
    assert.throws(() => stateSchema(value));
});

test('Go validators reject unknown external states without changing the previous value', () => {
  const output = renderGoStates(
    stateSchema({ version: 1, domains: { TaskState: { Paused: 'paused', Unknown: 'unknown' } } }),
  );
  assert(output.includes('type TaskState string'));
  assert(output.includes('TaskStatePaused TaskState = "paused"'));
  assert(output.indexOf('!TaskState(wire).Valid()') < output.indexOf('*value = TaskState(wire)'));
  assert(output.includes('if !value.Valid()'));
  assert(!output.includes('omitempty'));
});

test('cross-runtime transport limits have one complete positive-integer schema', () => {
  const protocol: unknown = JSON.parse(
    fs.readFileSync(
      new URL('../../resources/contracts/core-protocol.json', import.meta.url),
      'utf8',
    ),
  );
  const output = renderGoProtocol(protocol);
  assert(output.includes('CoreRequestMaxBytes = 262144'));
  assert(output.includes('CoreMaxSessionRequests = 4096'));
  assert(output.includes('CoreSnapshotMaxBytes = 268435456'));
  assert(protocol !== null && typeof protocol === 'object');
  for (const patch of [
    { workers: 0 },
    { queueCapacity: 1.5 },
    { version: 2 },
    { secret: 'not-a-contract' },
  ])
    assert.throws(() => renderGoProtocol({ ...protocol, ...patch }));
});
