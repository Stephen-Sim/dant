import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computerResourceOutputs } from '../../../scripts/core/generate-contracts.mts';

test('computer resources generate exact source bytes and reject ambiguity before producing output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-computer-resource-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'resources/config/computer.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw =
    '{"cpu":{"default":7,"min":3,"max":11},"memoryGB":{"default":19,"min":5,"max":29},"diskGB":{"default":137,"min":73,"max":257}}\n';
  fs.writeFileSync(file, raw);
  assert.deepEqual(await computerResourceOutputs(root), [
    ['core/internal/config/assets/computer.json', raw],
  ]);
  fs.writeFileSync(file, raw.replace('"cpu":', '"cpu":{},"cpu":'));
  await assert.rejects(computerResourceOutputs(root));
  fs.writeFileSync(file, raw.replace('"default":7', '"default":12'));
  await assert.rejects(computerResourceOutputs(root));
});

test('maintained Go computer resource embedding matches canonical bytes', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  for (const [relative, contents] of await computerResourceOutputs(root))
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), contents);
});
