import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './version.mjs';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit code ${result.status}.`);
}

// Tests intentionally skip unavailable tools locally. CI must exercise these tests.
if (process.platform === 'win32') {
  const openSsh = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/OpenSSH');
  if (!fs.existsSync(path.join(openSsh, 'ssh-keygen.exe'))) throw new Error('Windows OpenSSH client is required by the VM key tests.');
  process.env.PATH = `${openSsh}${path.delimiter}${process.env.PATH}`;
  if (process.env.GITHUB_PATH) fs.appendFileSync(process.env.GITHUB_PATH, `${openSsh}\n`);
}
for (const tool of ['ssh', 'ssh-keygen']) {
  const result = spawnSync(tool, ['-V'], { stdio: 'ignore', shell: false });
  if (result.error) throw new Error(`${tool} is required by CI: ${result.error.message}`);
}
run('python', ['-c', "import importlib.metadata, pycdlib; assert importlib.metadata.version('pycdlib') == '1.14.0'; print('pycdlib 1.14.0 and OpenSSH available')"]);

const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')
  : 'bash';
for (const name of fs.readdirSync(path.join(projectRoot, 'vm')).filter(name => name.endsWith('.sh')).sort()) {
  run(bash, ['-n', `vm/${name}`]);
  console.log(`Bash syntax verified: vm/${name}`);
}
