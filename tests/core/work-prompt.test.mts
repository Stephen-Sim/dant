import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isRecord } from '../../scripts/core/manifest-json.mts';

function reference() {
  const value: unknown = JSON.parse(
    fs.readFileSync(new URL('./testdata/work-prompt-node22.json', import.meta.url), 'utf8'),
  );
  assert.ok(isRecord(value));
  assert.equal(value.node, '22.23.3');
  assert.equal(value.sourceCommit, 'd058bdc7509efce90bd9d96cc367b04e11c98bae');
  assert.equal(value.oracleSource, 'src/work/engine.mts');
  assert.ok(typeof value.oracleSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.oracleSha256));
  assert.ok(Array.isArray(value.dynamicTools) && value.dynamicTools.length === 19);
  assert.equal(typeof value.instructions, 'string');
  return value;
}

test('Go tool declarations preserve the independent Node 22 permission-specific schema golden', () => {
  const declarations: unknown = JSON.parse(
    fs.readFileSync(
      new URL('../../core/internal/work/assets/dynamic-tools.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(declarations, reference().dynamicTools);
});

test('Go instructions preserve the full independent Node 22 template golden', () => {
  assert.equal(
    fs.readFileSync(
      new URL('../../core/internal/work/assets/instructions.txt', import.meta.url),
      'utf8',
    ),
    reference().instructions,
  );
});
