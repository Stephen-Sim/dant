import type { TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PROTOCOL } from '../../scripts/config/protocol.mts';

const fixtureResources = [
  'resources/core/dant-core-linux-amd64',
  'vm/install-worker.sh',
  'vm/worker-install.py',
  'vm/guest.py',
  'vm/guest_service.py',
  'vm/control.py',
  'vm/desktop.py',
  'vm/desktop_mcp.py',
  'vm/start-codex.sh',
  'vm/transcribe_audio.py',
  'vm/voice_message.py',
  'resources/config/protocol.json',
] as const;

export function workerInstallFixture(t: TestContext) {
  const parent = path.resolve('.cache/tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'go-worker-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const source = path.join(home, 'dant/releases/source.fixture');
  const version = '0.4.7-beta.12';
  const commit = 'a'.repeat(40);
  const files = fixtureResources.map((name) => {
    const data =
      name === 'resources/config/protocol.json' || name === 'vm/worker-install.py'
        ? fs.readFileSync(name)
        : Buffer.from('isolated resource ' + name);
    const target = path.join(source, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return {
      path: name,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  });
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = { schemaVersion: 1, version, sourceCommit: commit, files };
  const manifestRaw = JSON.stringify(manifest);
  const digest = createHash('sha256').update(manifestRaw).digest('hex');
  fs.writeFileSync(path.join(source, 'resources/core/bundle-manifest.json'), manifestRaw);

  function writeDeployment(environment: unknown, include = true) {
    fs.writeFileSync(
      path.join(source, 'deploy-manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        sha256: digest,
        ...(include ? { publicEnvironment: environment } : {}),
      }),
    );
  }
  writeDeployment({
    DANT_GUEST_HOST: PROTOCOL.loopbackHost,
    DANT_GUEST_PORT: String(PROTOCOL.guestPort),
  });

  return { root, home, source, version, commit, digest, writeDeployment };
}

export function verifyWorkerInstall(source: string, home: string) {
  const result = spawnSync(
    process.env.PYTHON || 'python',
    ['vm/worker-install.py', 'verify', source, home],
    { encoding: 'utf8', shell: false, timeout: 30_000 },
  );
  if (result.error) throw result.error;
  return result;
}
