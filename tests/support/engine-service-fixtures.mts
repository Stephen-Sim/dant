import { unexpectedFixtureOperation } from './service-fixtures.mts';
import type { EngineCredentials } from '../../src/work/engine.mts';
export class CredentialFixture implements EngineCredentials {
  find: EngineCredentials['find'] = unexpectedFixtureOperation;
  get: EngineCredentials['get'] = unexpectedFixtureOperation;
  upsert: EngineCredentials['upsert'] = unexpectedFixtureOperation;
  containsSecret: EngineCredentials['containsSecret'] = unexpectedFixtureOperation;
  redact: EngineCredentials['redact'] = unexpectedFixtureOperation;
  request: EngineCredentials['request'] = unexpectedFixtureOperation;
  cancelOwner: EngineCredentials['cancelOwner'] = unexpectedFixtureOperation;
}
