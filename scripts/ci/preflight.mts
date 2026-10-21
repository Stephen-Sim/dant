import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './version.mts';
import { assertNodeRuntime } from './node-runtime.mts';
import { resolveHostTools } from '../config/host-tools.mts';

assertNodeRuntime();
const CI_TOOL_TIMEOUT_MS = 5_000;
const hostTools = resolveHostTools();

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${path.basename(command)} failed with exit code ${result.status}.`);
}

// Tests intentionally skip unavailable tools locally. CI must exercise these tests.
if (hostTools.openSshDirectory !== null) {
  const openSsh = hostTools.openSshDirectory;
  if (!fs.existsSync(path.join(openSsh, 'ssh-keygen.exe')))
    throw new Error('Windows OpenSSH client is required by the VM key tests.');
  process.env.PATH = `${openSsh}${path.delimiter}${process.env.PATH}`;
  if (process.env.GITHUB_PATH) fs.appendFileSync(process.env.GITHUB_PATH, `${openSsh}\n`);
}
for (const tool of ['ssh', 'ssh-keygen']) {
  const result = spawnSync(tool, ['-V'], { stdio: 'ignore', shell: false });
  if (result.error) throw new Error(`${tool} is required by CI: ${result.error.message}`);
}
if (process.platform === 'linux') {
  const result = spawnSync('flock', ['--version'], {
    stdio: 'ignore',
    shell: false,
    timeout: CI_TOOL_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0)
    throw new Error('util-linux flock is required by the offline Worker restore tests.');
}
run('python', [
  '-c',
  "import importlib.metadata, pycdlib; assert importlib.metadata.version('pycdlib') == '1.14.0'; print('pycdlib 1.14.0 and OpenSSH available')",
]);

for (const name of fs
  .readdirSync(path.join(projectRoot, 'vm'))
  .filter((name) => name.endsWith('.sh'))
  .sort()) {
  run(hostTools.bash, ['-n', `vm/${name}`]);
  console.log(`Bash syntax verified: vm/${name}`);
}
