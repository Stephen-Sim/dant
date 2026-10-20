import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const scenario of [
  'navigation',
  'settings-information',
  'invalid-state',
  'call-controls',
  'chat-actions',
  'voice-message',
  'settings-operations',
  'telegram-settings',
  'voice-settings',
  'computer-controls',
  'onboarding',
  'computer-resources',
  'work-progress',
  'send-errors',
  'speech',
  'vm-settings',
])
  test(`the entire UI entrypoint boots against an isolated API: ${scenario}`, () => {
    const result = spawnSync(
      process.execPath,
      ['tests/ui/app/support/entrypoint-harness.mts', scenario],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 20_000,
        maxBuffer: 128 * 1024,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"booted":true/);
  });
