import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { discoverTests } from './test-files.mts';
import { TEST_CONCURRENCY } from './test-constants.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tests = discoverTests(root);
if (!tests.length) throw Error('No maintained Node tests were found.');
const result = spawnSync(
  process.execPath,
  ['--test', `--test-concurrency=${TEST_CONCURRENCY}`, ...process.argv.slice(2), ...tests],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
