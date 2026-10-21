import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import canonical from '../../../resources/config/protocol.json' with { type: 'json' };
import { apiPath } from '../../../ui/platform/native-protocol.mts';
import { validateProtocol } from '../../../ui/shared/network-protocol.mts';
import { sourceDeclaration } from '../../support/source-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import type { ApiOptions } from '../../../ui/shared/contracts.mts';

test('real main JSON and multipart API calls share canonical paths without changing authentication or replaying invalid routes', async () => {
  const paths = validateProtocol({
      ...canonical,
      paths: {
        ...canonical.paths,
        api: '/local',
        session: '/local/session',
        state: '/local/current',
        version: '/local/about',
      },
    }).paths,
    requests: { route: string; method: string; token?: unknown }[] = [],
    context = uiEntrypointFixture({
      apiPath: (route: string) => apiPath(route, paths),
      FormData,
      base: '',
      token: 'fixture-session',
      transport: {
        json: async (route: string, options: ApiOptions) => {
          requests.push({ route, method: options.method ?? 'GET' });
          return { source: 'json' };
        },
      },
      fetch: async (route: string, options: RequestInit) => {
        requests.push({
          route,
          method: options.method ?? 'GET',
          token: new Headers(options.headers).get('X-Dant-Token'),
        });
        return { ok: true, json: async () => ({ source: 'multipart' }) };
      },
      decodeApiResult: (_route: string, value: unknown) => value,
    });
  vm.createContext(context);
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
  vm.runInContext(stripTypeScriptTypes(sourceDeclaration(source, 'async function api(')), context);
  assert.deepEqual(await context.api('/state'), { source: 'json' });
  assert.deepEqual(await context.api('/upload', { method: 'POST', body: new FormData() }), {
    source: 'multipart',
  });
  assert.deepEqual(requests, [
    { route: '/local/current', method: 'GET' },
    { route: '/local/upload', method: 'POST', token: 'fixture-session' },
  ]);
  for (const route of ['https://external.invalid', '/../outside', '//external.invalid'])
    await assert.rejects(context.api(route), /Invalid local API route/);
  assert.equal(requests.length, 2);
});
