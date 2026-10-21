import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

for (const mode of ['ordinary', 'DEBUG'] as const)
  test(`${mode} Bash entrypoints preserve readiness, failure and isolated fake commands`, () => {
    const bash =
      process.platform === 'win32'
        ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')
        : 'bash';
    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        'tests/bash/run.test.sh',
        ...(mode === 'DEBUG' ? ['--debug-trace'] : []),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, BASH_ENV: '', ENV: '' },
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Bash runtime fixtures passed/);
    if (mode === 'ordinary') return;
    const measured = new Map(
      [...result.stdout.matchAll(/^TRACE_SOURCE\t([\w-]+\.sh)\t([1-9]\d*)$/gm)].map(
        ([, file, hits]) => {
          assert.ok(file && hits);
          return [file, Number(hits)] as const;
        },
      ),
    );
    const expected = fs
      .readdirSync('vm', { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith('.sh'))
      .map((file) => file.name)
      .sort();
    assert.deepEqual([...measured.keys()].sort(), expected);
    for (const hits of measured.values()) assert.ok(Number.isSafeInteger(hits) && hits > 0);
  });
