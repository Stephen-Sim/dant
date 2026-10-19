import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyWorkerInstall, workerInstallFixture } from '../support/worker-install-fixtures.mts';

test('the Go bundle verifies exact build resources before executing its runtime or changing live state', (t) => {
  const bundle = workerInstallFixture(t);
  const saved = {
    'dant/data/state.json': '{"workTasks":[{"id":"saved","status":"paused"}]}',
    'dant/deployed-source.json': 'previous-source',
    'dant/app': 'previous-app',
    '.config/systemd/user/dant-worker.service': 'previous-worker-service',
  };
  for (const [name, bytes] of Object.entries(saved)) {
    const file = path.join(bundle.home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }

  // Verification authenticates this deliberately non-executable resource. The
  // compiled role owns the ordinary-user, Linux VM, health and PNG probes.
  const verified = verifyWorkerInstall(bundle.source, bundle.home);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(
    verified.stdout.trim(),
    `127.0.0.1\t4320\t4317\t${bundle.version}\t${bundle.digest}`,
  );
  const binary = path.join(bundle.source, 'resources/core/dant-core-linux-amd64');
  fs.writeFileSync(binary, 'PRIVATE_INCOMPATIBLE_RUNTIME');
  const rejected = verifyWorkerInstall(bundle.source, bundle.home);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /^DANT_UPDATE_FAILED:bundle-changed:cutover$/m);
  assert.doesNotMatch(rejected.stderr, /PRIVATE_INCOMPATIBLE_RUNTIME|Traceback/);

  for (const [name, bytes] of Object.entries(saved)) {
    assert.equal(fs.readFileSync(path.join(bundle.home, name), 'utf8'), bytes);
  }
  assert.equal(fs.existsSync(path.join(bundle.home, 'dant/install-attempt.json')), false);
  assert.equal(fs.existsSync(path.join(bundle.home, 'dant/installation-backups')), false);
});

test('readiness rejects a legacy runtime or wrong Go role, protocol, source and version', () => {
  const harness = String.raw`
import importlib.util, io, json
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('worker_install', 'vm/worker-install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
target = {'version':'0.4.7-beta.12','commit':'a'*40,'port':4317}
session = {'product':'dant','mode':'worker','runtime':'go','protocol':1,
           'version':target['version'],'source':target['commit'],'token':'isolated-token'}
variants = [session, {'product':'dant','mode':'worker','token':'isolated-token'}]
variants += [dict(session, **changed) for changed in [
    {'mode':'controller'}, {'runtime':'node'}, {'protocol':True}, {'protocol':2},
    {'source':'b'*40}, {'version':'0.0.0'}]]
results = []
for current in variants:
    calls = []
    def opened(request, timeout):
        calls.append('session' if isinstance(request, str) else 'version')
        value = current if isinstance(request, str) else {'version':target['version']}
        return io.BytesIO(json.dumps(value).encode())
    class Opener:
        open = staticmethod(opened)
    with patch.object(installer, 'local_opener', return_value=Opener()):
        results.append({'ready':installer.ready(target),'calls':calls})
print(json.dumps(results))
`;
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', harness], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { ready: true, calls: ['session', 'version'] },
    ...Array.from({ length: 7 }, () => ({ ready: false, calls: ['session'] })),
  ]);
});
