import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  archivePath,
  validateWorkerBackup,
  WORKER_ARCHIVE_MAGIC,
} from '../../src/backups/archive-stream.mts';
import {
  BACKUP_MAX_FILE_BYTES,
  BACKUP_MAX_FILES,
  BACKUP_CHUNK_BYTES,
} from '../../src/backups/backup-constants.mts';

function temporary(t: TestContext) {
  const parent = path.resolve('.cache/tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'backup-frames-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function archive(frames: readonly unknown[], { files = 1, bytes = 2 } = {}) {
  return (
    WORKER_ARCHIVE_MAGIC +
    '\n' +
    JSON.stringify({
      type: 'header',
      schemaVersion: 1,
      createdAt: 1,
      appVersion: '0.4.7-beta.8',
      sourceId: 'fixture',
      files,
      bytes,
    }) +
    '\n' +
    frames.map((value) => JSON.stringify(value) + '\n').join('')
  );
}
const state = { type: 'file', domain: 'data', path: 'state.json', size: 2, executable: false };
const chunk = { type: 'chunk', data: Buffer.from('{}').toString('base64') };
const end = { type: 'end', sha256: createHash('sha256').update('{}').digest('hex') };
const footer = { type: 'footer', files: 1, bytes: 2 };
test('archive decoding handles arbitrary transport chunk boundaries without buffering a file', async (t) => {
  const dir = temporary(t),
    encoded = Buffer.from(archive([state, chunk, end, footer]));
  async function* transport() {
    for (let offset = 0; offset < encoded.length; offset += 7)
      yield encoded.subarray(offset, offset + 7);
  }
  const decoded = await validateWorkerBackup({ input: transport(), stagingDir: dir });
  assert.equal(decoded.manifest.files, 1);
  assert.equal(decoded.manifest.bytes, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'), '{}');
});
test('archive paths cannot choose absolute, traversing, alternate-stream or reserved-device destinations', () => {
  for (const value of [
    '../state.json',
    '/tmp/x',
    'C:/x',
    'a\\b',
    'a//b',
    './a',
    'a/../b',
    'a\0b',
    'a:stream',
    'CON',
    'a/NUL.txt',
    'a/trailing.',
    'a/trailing ',
  ])
    assert.equal(archivePath(value), false, value);
  assert.equal(archivePath('conversation/.agents/skills/中文/SKILL.md'), true);
});
test('malformed archive frames fail closed before anything reaches a live root', async (t) => {
  const corruptions: unknown[][] = [
    [{ ...state, path: '../../escaped' }, chunk, end, footer],
    [{ ...state, domain: 'runtime' }, chunk, end, footer],
    [{ ...state, type: 'symlink' }, chunk, end, footer],
    [{ ...state, size: BACKUP_MAX_FILE_BYTES + 1 }, chunk, end, footer],
    [state, { type: 'chunk', data: '***' }, end, footer],
    [
      state,
      { type: 'chunk', data: Buffer.alloc(BACKUP_CHUNK_BYTES + 1).toString('base64') },
      end,
      footer,
    ],
    [state, chunk, { ...end, sha256: '0'.repeat(64) }, footer],
    [state, end, footer],
    [state, chunk, end, { ...footer, bytes: 3 }],
    [state, chunk, end],
    [state, chunk, end, footer, footer],
    [state, chunk, end, state, chunk, end, footer],
    [
      { type: 'directory', domain: 'data', path: 'a', size: 0, executable: false },
      { ...state, path: 'a' },
      chunk,
      end,
      footer,
    ],
    [{ ...state, path: 'a' }, chunk, end, { ...state, path: 'a/child' }, chunk, end, footer],
  ];
  for (const frames of corruptions) {
    const dir = temporary(t);
    await assert.rejects(
      validateWorkerBackup({ input: Readable.from([archive(frames)]), stagingDir: dir }),
      { code: 'invalid_backup' },
    );
    assert.equal(fs.existsSync(path.join(path.dirname(dir), 'escaped')), false);
  }
  await assert.rejects(
    validateWorkerBackup({
      input: Readable.from([archive([state, chunk, end, footer], { files: BACKUP_MAX_FILES + 1 })]),
      stagingDir: temporary(t),
    }),
    { code: 'invalid_backup' },
  );
  await assert.rejects(
    validateWorkerBackup({ input: Readable.from(['not-an-archive\n']), stagingDir: temporary(t) }),
    { code: 'invalid_backup' },
  );
});
test('unterminated, invalid UTF-8 and oversized lines cannot bypass frame bounds', async (t) => {
  for (const input of [
    Readable.from([archive([state, chunk, end, footer]).trimEnd()]),
    Readable.from([Buffer.from([0xff, 10])]),
    Readable.from(['x'.repeat(1024 * 1024 + 1)]),
  ]) {
    await assert.rejects(validateWorkerBackup({ input, stagingDir: temporary(t) }), {
      code: 'invalid_backup',
    });
  }
});
