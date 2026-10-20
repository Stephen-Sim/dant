import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

test('generated timezone data matches its pinned Go source and license without rewriting files', () => {
  const outputs = ['windows-timezones.json', 'GO-LICENSE.txt'].map(
    (name) => `core/internal/platform/timezones/${name}`,
  );
  const before = outputs.map((file) => fs.readFileSync(file));
  const result = spawnSync(process.execPath, ['scripts/core/generate-timezones.mts', '--check'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  for (const [index, file] of outputs.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
});

test('the timezone generator rejects an unsupported CLI operation without changing data', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/core/generate-timezones.mts', '--unexpected'],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 },
  );

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: node scripts\/core\/generate-timezones\.mts/);
});
