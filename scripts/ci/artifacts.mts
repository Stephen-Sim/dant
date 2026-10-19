import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readVersion, projectRoot } from './version.mts';
import { resolveBuildPaths, assertStagingPath } from './build-paths.mts';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Windows x64 artifacts must be packaged on Windows x64.');
const version = readVersion();
const { release, output, resources, target, stagingPrefix } = resolveBuildPaths(projectRoot);
const prefix = `dant_${version}_windows_x64`;

function requireFile(file: string): void {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile())
    throw new Error(`Missing required build file: ${path.relative(projectRoot, file)}`);
}

function requirePe(file: string, x64 = true): void {
  requireFile(file);
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    fs.readSync(descriptor, header, 0, header.length, 0);
    if (header.toString('ascii', 0, 2) !== 'MZ')
      throw new Error(`${path.basename(file)} is not a Windows executable.`);
    const signature = Buffer.alloc(6);
    fs.readSync(descriptor, signature, 0, signature.length, header.readUInt32LE(60));
    if (signature.readUInt32LE(0) !== 0x4550 || (x64 && signature.readUInt16LE(4) !== 0x8664))
      throw new Error(`${path.basename(file)} must be a Windows${x64 ? ' x64' : ''} executable.`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${path.basename(command)} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function describe(name: string): Promise<{ name: string; bytes: number; sha256: string }> {
  const file = path.join(output, name);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { name, bytes: fs.statSync(file).size, sha256: hash.digest('hex') };
}

// The resource directory is built from this checkout on Windows. Never include data,
// keys, local caches, or an executable copied from a different operating system.
const requiredFiles = [
  'LICENSE',
  'package.json',
  'src/server.mts',
  'src/computer/hypervisors.mts',
  'dist/index.html',
  'scripts/prepare-vm.ps1',
  'scripts/create-vm.ps1',
  'scripts/check-vm.ps1',
  'scripts/prepare-vmware.ps1',
  'scripts/create-vmware.ps1',
  'scripts/vmware.py',
  'scripts/seed.py',
  'scripts/patch-image.py',
  'scripts/vm-key.py',
  'vm/bootstrap.sh',
  'vm/guest.py',
  'vm/desktop.py',
  'node_modules/express/package.json',
];
for (const name of requiredFiles) {
  requireFile(path.join(resources, name));
}
for (const name of ['data', '.cache', '.tools', '.env']) {
  if (fs.existsSync(path.join(resources, name)))
    throw new Error(`Local-only directory or file unexpectedly included in backend: ${name}`);
}
requirePe(path.join(release, 'dant.exe'));
requirePe(path.join(resources, 'node.exe'));
const nsis = path.join(release, 'bundle/nsis');
const installer = `dant_${version}_x64-setup.exe`;
// NSIS uses a 32-bit installer stub even when the installed application is x64.
requirePe(path.join(nsis, installer), false);
fs.mkdirSync(output, { recursive: true });
const setupName = `${prefix}_setup.exe`;
const zipName = `${prefix}_portable.zip`;
const metadataName = `${prefix}_build.json`;
fs.copyFileSync(path.join(nsis, installer), path.join(output, setupName));

const staging = fs.mkdtempSync(stagingPrefix);
try {
  fs.copyFileSync(path.join(release, 'dant.exe'), path.join(staging, 'dant.exe'));
  fs.cpSync(resources, path.join(staging, 'backend'), { recursive: true });
  const tar = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe');
  run(tar, ['-a', '-c', '-f', path.join(output, zipName), '-C', staging, 'dant.exe', 'backend']);
  const entries = new Set(
    run(tar, ['-t', '-f', path.join(output, zipName)])
      .split(/\r?\n/)
      .map((name) => name.replaceAll('\\', '/')),
  );
  for (const name of [
    'dant.exe',
    'backend/node.exe',
    ...requiredFiles.map((name) => `backend/${name}`),
  ]) {
    if (!entries.has(name)) throw new Error(`Portable ZIP is missing ${name}.`);
  }
} finally {
  assertStagingPath(target, staging);
  fs.rmSync(staging, { recursive: true, force: true });
}

const files = await Promise.all([describe(setupName), describe(zipName)]);
const metadata = {
  schemaVersion: 1,
  product: 'dant',
  version,
  commit: process.env.GITHUB_SHA ?? run('git', ['rev-parse', 'HEAD']),
  ref: process.env.GITHUB_REF ?? null,
  build: {
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    url:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
  },
  platform: 'win32',
  arch: 'x64',
  node: process.version,
  rust: run('rustc', ['--version']),
  unsigned: true,
  files,
};
fs.writeFileSync(path.join(output, metadataName), `${JSON.stringify(metadata, null, 2)}\n`);
const checksums = [...files, await describe(metadataName)];
fs.writeFileSync(
  path.join(output, 'SHA256SUMS'),
  checksums.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
);
console.log(`Windows artifacts ready in ${path.relative(projectRoot, output)}`);
