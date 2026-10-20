import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isRecord } from '../../../scripts/core/manifest-json.mts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const PROJECT_PROBE_TIMEOUT_MS = 15_000;
const PROJECT_CONFIG_LIMIT = 256 * 1024;

function project(cwd: string, directory: string, config?: string) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--showConfig',
      ...(config ? ['--project', config] : []),
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: PROJECT_PROBE_TIMEOUT_MS,
      maxBuffer: PROJECT_CONFIG_LIMIT,
      windowsHide: true,
      shell: false,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);

  const value: unknown = JSON.parse(result.stdout);
  assert.ok(isRecord(value) && isRecord(value.compilerOptions));
  assert.ok(Array.isArray(value.files));
  const files = value.files.map((name: unknown) => {
    assert.ok(typeof name === 'string');
    return path.resolve(directory, name);
  });
  return { options: value.compilerOptions, files: files.sort() };
}

test('nested tests discover the same strict Node-aware project as npm typecheck', () => {
  const discovered = project(path.join(root, 'tests/tooling/build'), path.join(root, 'tests'));
  const explicit = project(root, root, path.join(root, 'tsconfig.tests.json'));

  assert.deepEqual(discovered, explicit);
  assert.ok(discovered.files.includes(path.join(root, 'tests/tooling/build/coverage.test.mts')));
  assert.ok(discovered.files.includes(path.join(root, 'tests/types/linkedom.d.ts')));
  assert.deepEqual(discovered.options.types, ['node']);
  assert.equal(discovered.options.strict, true);
  assert.equal(discovered.options.noUncheckedIndexedAccess, true);
  assert.equal(discovered.options.exactOptionalPropertyTypes, true);
  assert.equal(discovered.options.skipLibCheck, false);
});
