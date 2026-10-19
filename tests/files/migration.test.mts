import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
const setup = (t: NodeTestContext) => {
  const dir = fs.mkdtempSync(path.join(root, 'migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'migration'),
    target = path.join(dir, 'vm-data');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(source, 'files'));
  fs.writeFileSync(
    path.join(source, 'manifest.json'),
    JSON.stringify({ id: 'one-import', messages: 1 }),
  );
  return { source, target };
};
const run = (source: string, target: string) =>
  spawnSync(process.execPath, ['vm/migrate-state.mts', source, target], {
    encoding: 'utf8',
    shell: false,
  });

test('legacy migration archives files into VM attachment storage, rewrites IDs and is idempotent', (t) => {
  const { source, target } = setup(t),
    legacy = {
      messages: [
        {
          id: 'message',
          role: 'user',
          attachments: [{ id: 'legacy-upload', name: 'report.txt', type: 'text/plain' }],
        },
      ],
      settings: { vm: { keyPath: 'HOST PRIVATE KEY PATH' } },
    };
  fs.writeFileSync(path.join(source, 'state.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(source, 'files', 'legacy-upload'), 'report');
  const result = run(source, target);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(target, 'state.json'), 'utf8')),
    attachment = state.messages[0].attachments[0];
  assert.match(attachment.id, /^[0-9a-f-]{36}$/);
  assert.equal(fs.readFileSync(attachment.guestPath, 'utf8'), 'report');
  assert.equal(state.settings.vm.keyPath, '');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, 'state.json'), 'utf8')), legacy);
  assert.equal(run(source, target).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'state.json'), 'utf8')), state);
});

test('migration refuses to overwrite an existing authoritative VM conversation', (t) => {
  const { source, target } = setup(t);
  fs.writeFileSync(path.join(source, 'state.json'), JSON.stringify({ messages: [], settings: {} }));
  const original = '{"messages":[{"id":"existing-vm-work"}]}';
  fs.writeFileSync(path.join(target, 'state.json'), original);
  const result = run(source, target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already has authoritative data/);
  assert.equal(fs.readFileSync(path.join(target, 'state.json'), 'utf8'), original);
});
