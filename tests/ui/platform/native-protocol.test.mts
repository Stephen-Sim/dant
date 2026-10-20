import test from 'node:test';
import assert from 'node:assert/strict';
import canonical from '../../../resources/config/protocol.json' with { type: 'json' };
import { apiPath, MAX_PORT, NATIVE_PROTOCOL } from '../../../ui/platform/native-protocol.mts';
import { parseProtocolJSON, validateProtocol } from '../../../ui/shared/network-protocol.mts';

test('browser transport consumes the same frozen validated protocol and canonical API aliases', () => {
  assert.equal(NATIVE_PROTOCOL.host, canonical.loopbackHost);
  assert.equal(NATIVE_PROTOCOL.port, canonical.apiPort);
  assert.equal(NATIVE_PROTOCOL.devPort, canonical.devPort);
  assert.equal(MAX_PORT, 65_535);
  assert.deepEqual(NATIVE_PROTOCOL.paths, canonical.paths);
  assert.ok(Object.isFrozen(NATIVE_PROTOCOL));
  assert.ok(Object.isFrozen(NATIVE_PROTOCOL.paths));
  for (const key of ['session', 'state', 'version'] as const)
    assert.equal(apiPath(`/${key}?read=1`), canonical.paths[key] + '?read=1');
  assert.equal(
    apiPath('/files/fixture?download=1'),
    canonical.paths.api + '/files/fixture?download=1',
  );
});

test('valid canonical path changes propagate through API construction without a second prefix default', () => {
  const changed = validateProtocol({
    ...canonical,
    paths: {
      ...canonical.paths,
      api: '/local-api',
      session: '/local-api/current-session',
      state: '/local-api/current-state',
      version: '/local-api/current-version',
    },
  });
  assert.equal(apiPath('/state', changed.paths), '/local-api/current-state');
  assert.equal(apiPath('/session?fresh=1', changed.paths), '/local-api/current-session?fresh=1');
  assert.equal(apiPath('/version', changed.paths), '/local-api/current-version');
  assert.equal(apiPath('/settings', changed.paths), '/local-api/settings');
  for (const route of [
    'settings',
    '//external.invalid/api',
    '/https://external.invalid',
    '/a/../b',
    '/a\\b',
    '/a#fragment',
    '/a\nheader',
    '/a b',
  ])
    assert.throws(() => apiPath(route), /Invalid local API route/);
});

test('the browser-safe canonical parser rejects duplicates, invalid schemas and unsafe protocol changes', () => {
  assert.deepEqual(parseProtocolJSON(JSON.stringify(canonical)), validateProtocol(canonical));
  const raw = JSON.stringify(canonical);
  assert.throws(() => parseProtocolJSON(raw.replace('"apiPort":', '"apiPort":4317,"apiPort":')));
  assert.throws(() => parseProtocolJSON(raw.replace('"state":', '"state":"/api/state","state":')));
  assert.throws(() => parseProtocolJSON(' '.repeat(64 * 1024) + raw));
  for (const value of [
    { ...canonical, apiPort: MAX_PORT + 1 },
    { ...canonical, devPort: canonical.apiPort },
    { ...canonical, loopbackHost: '0.0.0.0' },
    { ...canonical, loopbackHosts: ['127.0.0.1', 'localhost', 'localhost'] },
    { ...canonical, extra: true },
    { ...canonical, paths: { ...canonical.paths, state: '/outside-api/state' } },
    { ...canonical, paths: { ...canonical.paths, health: '/health/../private' } },
    { ...canonical, paths: { ...canonical.paths, health: canonical.paths.screen } },
  ])
    assert.throws(() => validateProtocol(value), /Invalid canonical network protocol/);
});
