import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../../src/contracts/json.mts';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function validateVersions(
  versions: Readonly<Record<string, unknown>>,
  tag?: string,
): string {
  const version = versions.package;
  if (
    typeof version !== 'string' ||
    version.trim() !== version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error('package.json must contain a release version such as 0.1.0.');
  }
  for (const [source, value] of Object.entries(versions)) {
    if (value !== version)
      throw new Error(
        `Version mismatch: package.json=${version}, ${source}=${value ?? '(missing)'}.`,
      );
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag must be v${version}; received ${tag}.`);
  }
  return version;
}

export function readVersion(root = projectRoot, env = process.env) {
  const json = (name: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    if (!isRecord(value)) throw Error('Invalid project manifest: ' + name);
    return value;
  };
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const packageSection = cargo.match(/^\[package\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const versions = {
    package: json('package.json').version,
    'tauri.conf.json': json('src-tauri/tauri.conf.json').version,
    'Cargo.toml': packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1],
  };
  const releaseTag =
    env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME?.startsWith('v')
      ? env.GITHUB_REF_NAME
      : undefined;
  return validateVersions(versions, releaseTag);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = readVersion();
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Version verified: ${version}`);
}
