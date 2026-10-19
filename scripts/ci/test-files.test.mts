import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverTests } from './test-files.mts';

test('nested feature tests are included once while helpers, fixtures and other languages stay out', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-test-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    'tests/work/task.test.mts',
    'tests/ui/chat/history.test.mts',
    'tests/app/server.test.mts',
    'tests/support/service-fixtures.mts',
    'tests/types/work-contracts.ts',
    'tests/vm/test_guest.py',
    'tests/work/task.test.mts.backup',
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'fixture only');
  }
  assert.deepEqual(discoverTests(root), [
    'tests/app/server.test.mts',
    'tests/ui/chat/history.test.mts',
    'tests/work/task.test.mts',
  ]);
});
