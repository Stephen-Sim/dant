import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  COMPUTER_RESOURCES,
  parseComputerResources,
  validateComputerResources,
} from '../../../ui/computer/resource-config.mts';

const canonical = fs.readFileSync(
  new URL('../../../resources/config/computer.json', import.meta.url),
  'utf8',
);

test('provisioning resource values remain frozen and follow the exact canonical policy', () => {
  assert.deepEqual(COMPUTER_RESOURCES, JSON.parse(canonical));
  assert.ok(Object.isFrozen(COMPUTER_RESOURCES));
  for (const range of Object.values(COMPUTER_RESOURCES)) assert.ok(Object.isFrozen(range));
  const changed = {
    cpu: { default: 7, min: 3, max: 11 },
    memoryGB: { default: 19, min: 5, max: 29 },
    diskGB: { default: 137, min: 73, max: 257 },
  };
  assert.deepEqual(parseComputerResources(JSON.stringify(changed)), changed);
  changed.cpu.default = 9;
  assert.equal(COMPUTER_RESOURCES.cpu.default, 4);
  assert.equal(validateComputerResources(changed).cpu.default, 9);
});

test('resource configuration rejects unknown, missing, duplicate and unsafe numeric fields', () => {
  for (const field of ['cpu', 'memoryGB', 'diskGB'])
    for (const member of ['default', 'min', 'max'])
      for (const invalid of [
        undefined,
        null,
        true,
        '8',
        0,
        -1,
        1.5,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const value: unknown = JSON.parse(canonical);
        assert.ok(value && typeof value === 'object');
        const range: unknown = Reflect.get(value, field);
        assert.ok(range && typeof range === 'object');
        Reflect.set(range, member, invalid);
        assert.throws(() => validateComputerResources(value));
      }
  for (const text of [
    '',
    '{}',
    'null',
    '[]',
    canonical + '{}',
    ' '.repeat(4096) + canonical,
    canonical.replace('"cpu":', '"other":'),
    canonical.replace('"default":', '"other":'),
    canonical.replace('"cpu":', '"cpu":{},"cpu":'),
    canonical.replace('"default":', '"default":4,"default":'),
    canonical.replace('"default": 4', '"default": 65'),
    canonical.replace('"min": 1', '"min": 65'),
  ])
    assert.throws(() => parseComputerResources(text));
  const equal = { default: 1, min: 1, max: 1 };
  assert.deepEqual(
    validateComputerResources({ cpu: equal, memoryGB: equal, diskGB: equal }).cpu,
    equal,
  );
});

test('resource values preserve the exact common provider Int32 maximum and reject its successor', () => {
  const range = { default: 2_147_483_647, min: 1, max: 2_147_483_647 };
  const source = { cpu: range, memoryGB: range, diskGB: range };
  assert.deepEqual(validateComputerResources(source), source);
  for (const literal of ['2147483647.0', '2147483647e0'])
    assert.equal(
      parseComputerResources(JSON.stringify(source).replaceAll('2147483647', literal)).cpu.default,
      2_147_483_647,
    );
  for (const invalid of [
    { default: 2_147_483_648, min: 1, max: 2_147_483_648 },
    { default: 4, min: 1, max: 2_147_483_648 },
    { default: 2_147_483_648, min: 2_147_483_648, max: 2_147_483_648 },
  ]) {
    assert.throws(() => validateComputerResources({ ...source, cpu: invalid }));
  }
});
