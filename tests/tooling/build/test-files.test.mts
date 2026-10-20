import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTests } from '../../../scripts/ci/test-files.mts';

test('nested feature tests are included once while helpers, fixtures and other languages stay out', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-test-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    'tests/tooling/core/nested/tool.test.mts',
    'tests/ui/chat/history.test.mts',
    'tests/native/host.test.mts',
    'tests/support/service-fixtures.mts',
    'tests/types/work-contracts.ts',
    'tests/vm/test_guest.py',
    'tests/tooling/core/nested/tool.test.mts.backup',
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'fixture only');
  }
  assert.deepEqual(discoverTests(root), [
    'tests/native/host.test.mts',
    'tests/tooling/core/nested/tool.test.mts',
    'tests/ui/chat/history.test.mts',
  ]);
});

test('maintained Node tests stay in UI, tooling or native ownership without disappearing from discovery', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const files = discoverTests(root);
  for (const file of files) assert.match(file, /^tests\/(?:ui|tooling|native)\//);
  for (const category of ['ui', 'tooling', 'native'])
    assert.ok(
      files.some((file) => file.startsWith(`tests/${category}/`)),
      category,
    );
});
