import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { dynamicTools, Engine } from '../../src/work/engine.mts';

test('Go tool declarations preserve every original permission-specific JSON schema', () => {
  const declarations: unknown = JSON.parse(
    fs.readFileSync(
      new URL('../../core/internal/work/assets/dynamic-tools.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(declarations, dynamicTools);
});

test('the Go instruction template retains the complete current Engine instructions', () => {
  const record = {
    id: 'instruction-work-id',
    title: 'instruction-title',
    status: 'paused',
    plan: null,
  };
  const owner = {
    store: { state: { workTasks: [record], settings: { language: 'en' } } },
    workspace: '{{workspace}}',
    outputDir: '{{outputDir}}',
    desktopPath: '{{desktopPath}}',
    memory: { dir: '{{memoryDir}}', context: () => '{{durableMemory}}' },
    redact: (text: string) => text,
  };
  // The prior builder reads this narrow fixture only; no Engine, model,
  // SQLite store, subprocess or VM connection is constructed by this oracle.
  const instructions = Reflect.apply(Engine.prototype.instructions, owner, []);
  assert.equal(typeof instructions, 'string');
  const refs = JSON.stringify([
    { workId: record.id, title: record.title, status: record.status, plan: record.plan },
  ]);
  const expected = String(instructions)
    .replace(refs, '{{workReferences}}')
    .replace('use English.', 'use {{languageName}}.');
  assert.equal(
    fs.readFileSync(
      new URL('../../core/internal/work/assets/instructions.txt', import.meta.url),
      'utf8',
    ),
    expected + '\n',
  );
});
