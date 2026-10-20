import test from 'node:test';
import assert from 'node:assert/strict';
import canonical from '../../../resources/config/protocol.json' with { type: 'json' };
import {
  parseProtocolJSON,
  PROTOCOL,
  validateProtocol,
} from '../../../scripts/config/protocol.mts';

test('the canonical protocol validates once and exposes immutable values to every tool', () => {
  const protocol = validateProtocol(canonical);
  assert.deepEqual(protocol, canonical);
  assert.deepEqual(parseProtocolJSON(JSON.stringify(canonical)), protocol);
  assert.deepEqual(PROTOCOL, protocol);
  assert.equal(Object.isFrozen(protocol), true);
  assert.equal(Object.isFrozen(protocol.paths), true);
  assert.equal(Object.isFrozen(protocol.loopbackHosts), true);
  assert.deepEqual(
    validateProtocol({
      ...canonical,
      apiPort: 5217,
      devPort: 5218,
      bootstrapGuestPort: 5219,
      guestPort: 5220,
    }).apiPort,
    5217,
  );
});

test('malformed, ambiguous and remote protocol values never become defaults', () => {
  const invalid: unknown[] = [null, [], {}, { ...canonical, extra: true }];
  for (const loopbackHost of ['localhost', '0.0.0.0', 'remote.invalid', null])
    invalid.push({ ...canonical, loopbackHost });
  for (const loopbackHosts of [
    null,
    [],
    ['127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['127.0.0.1', 'remote.invalid'],
    [1, 'localhost'],
  ])
    invalid.push({ ...canonical, loopbackHosts });
  for (const key of ['apiPort', 'devPort', 'guestPort', 'bootstrapGuestPort'])
    for (const value of [0, 65536, 1.5, '4317', true, null, Number.NaN, undefined])
      invalid.push({ ...canonical, [key]: value });
  const portKeys = ['apiPort', 'devPort', 'guestPort', 'bootstrapGuestPort'] as const;
  for (const [index, key] of portKeys.entries())
    for (const other of portKeys.slice(index + 1))
      invalid.push({ ...canonical, [key]: canonical[other] });
  const { bootstrapGuestPort: _omitted, ...missingBootstrapPort } = canonical;
  invalid.push(missingBootstrapPort);
  for (const paths of [
    null,
    {},
    { ...canonical.paths, extra: '/extra' },
    { ...canonical.paths, screen: canonical.paths.health },
    { ...canonical.paths, session: '/session' },
    { ...canonical.paths, version: '/version' },
    { ...canonical.paths, state: '/state' },
  ])
    invalid.push({ ...canonical, paths });
  for (const value of [
    '/',
    '/api//screen',
    '/api/../screen',
    'https://remote.invalid',
    '/screen?x',
    '/屏幕',
    '/' + 'a'.repeat(128),
    5,
  ])
    invalid.push({ ...canonical, paths: { ...canonical.paths, screen: value } });
  for (const value of invalid)
    assert.throws(() => validateProtocol(value), /canonical network protocol/);
});

test('JSON text rejects duplicate and escaped duplicate fields before their earlier values disappear', () => {
  const raw = JSON.stringify(canonical);
  for (const value of [
    raw.replace('"apiPort":', '"apiPort":9999,"apiPort":'),
    raw.replace('"bootstrapGuestPort":', '"bootstrapGuestPort":9999,"bootstrapGuestPort":'),
    raw.replace('"apiPort":', String.raw`"\u0061piPort":9999,"apiPort":`),
    raw.replace('"state":', '"state":"/api/other","state":'),
    'x'.repeat(64 * 1024 + 1),
    '{',
    'null',
  ])
    assert.throws(() => parseProtocolJSON(value));
  assert.deepEqual(
    parseProtocolJSON(raw.replace('"apiPort"', String.raw`"\u0061piPort"`)),
    PROTOCOL,
  );
});

test('bootstrap and user Worker endpoints retain distinct independently selected ports', () => {
  const source = {
    ...canonical,
    apiPort: 5217,
    devPort: 5218,
    bootstrapGuestPort: 5219,
    guestPort: 5220,
  };
  const protocol = parseProtocolJSON(JSON.stringify(source));
  assert.equal(protocol.bootstrapGuestPort, 5219);
  assert.equal(protocol.guestPort, 5220);
  assert.equal(
    new Set([protocol.apiPort, protocol.devPort, protocol.bootstrapGuestPort, protocol.guestPort])
      .size,
    4,
  );
});
