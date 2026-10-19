import assert from 'node:assert/strict';
import type { EngineCredentials } from '../../src/work/engine.mts';
import { unexpectedFixtureOperation, observedRecord } from './service-fixtures.mts';

export class CredentialFixture implements EngineCredentials {
  find: EngineCredentials['find'] = unexpectedFixtureOperation;
  get: EngineCredentials['get'] = unexpectedFixtureOperation;
  upsert: EngineCredentials['upsert'] = unexpectedFixtureOperation;
  containsSecret: EngineCredentials['containsSecret'] = unexpectedFixtureOperation;
  redact: EngineCredentials['redact'] = unexpectedFixtureOperation;
  request: EngineCredentials['request'] = unexpectedFixtureOperation;
  cancelOwner: EngineCredentials['cancelOwner'] = unexpectedFixtureOperation;
}

export function fixtureString(value: unknown): string {
  assert.ok(typeof value === 'string', 'Expected fixture text.');
  return value;
}

export function inputText(value: unknown): string {
  const input = observedRecord(value);
  assert.equal(input.type, 'text');
  return fixtureString(input.text);
}
