import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL } from '../../../scripts/config/protocol.mts';
import {
  verifyWorkerInstall,
  workerInstallFixture,
} from '../../support/worker-install-fixtures.mts';
function parseManifest(t: NodeTestContext, value: unknown, withField = true) {
  const bundle = workerInstallFixture(t);
  bundle.writeDeployment(value, withField);
  return { ...verifyWorkerInstall(bundle.source, bundle.home), bundle };
}

test('the installer consumes the public allowlist with matching defaults and no shell interpretation', (t) => {
  const defaults = parseManifest(t, {
    DANT_GUEST_HOST: PROTOCOL.loopbackHost,
    DANT_GUEST_PORT: String(PROTOCOL.guestPort),
  });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(
    defaults.stdout.trim(),
    `127.0.0.1\t${PROTOCOL.guestPort}\t4317\t${defaults.bundle.version}\t${defaults.bundle.digest}`,
  );
  const custom = parseManifest(t, { DANT_GUEST_HOST: 'localhost', DANT_GUEST_PORT: '5540' });
  assert.equal(custom.status, 0, custom.stderr);
  assert.equal(
    custom.stdout.trim(),
    `localhost\t5540\t4317\t${custom.bundle.version}\t${custom.bundle.digest}`,
  );
  const legacy = parseManifest(t, { DANT_GUEST_HOST: '127.0.0.1', DANT_GUEST_PORT: '4320' });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(
    legacy.stdout.trim(),
    `127.0.0.1\t4320\t4317\t${legacy.bundle.version}\t${legacy.bundle.digest}`,
  );
});

test('the installer rejects unknown keys, remote addresses and malformed ports without exposing their values', (t) => {
  const valid = { DANT_GUEST_HOST: 'localhost', DANT_GUEST_PORT: '5540' };
  for (const value of [
    null,
    [],
    {},
    { DANT_GUEST_PORT: '5540' },
    { ...valid, OPENAI_API_KEY: 'PRIVATE_CONFIG_FIXTURE' },
    { ...valid, DANT_GUEST_HOST: '0.0.0.0' },
    { ...valid, DANT_GUEST_HOST: 'localhost\nExecStart=PRIVATE_CONFIG_FIXTURE' },
    { ...valid, DANT_GUEST_PORT: '5540;PRIVATE_CONFIG_FIXTURE' },
    { ...valid, DANT_GUEST_PORT: '65536' },
    { ...valid, DANT_GUEST_PORT: '05540' },
    { ...valid, DANT_GUEST_PORT: 5540 },
  ]) {
    const result = parseManifest(t, value);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^DANT_UPDATE_FAILED:network-invalid:cutover$/m);
    assert.doesNotMatch(result.stderr, /PRIVATE_CONFIG_FIXTURE|Traceback/);
  }
  const omitted = parseManifest(t, null, false);
  assert.equal(omitted.status, 1);
  assert.match(omitted.stderr, /^DANT_UPDATE_FAILED:manifest-invalid:cutover$/m);
});
