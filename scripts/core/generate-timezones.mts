import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { GO_VERSION, resolveGoToolchain } from './go.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_SHA256 = 'fdabcbf35b6e9613c7e12bc44a10701cabf08c1760aef7be07f58609dfb89ead';
const SOURCE_PATH = 'src/time/zoneinfo_abbrs_windows.go';
const SOURCE_LIMIT = 64 * 1024;
const OUTPUT_DIRECTORY = 'core/internal/platform/timezones';

const compiler = resolveGoToolchain(ROOT);
const result = spawnSync(compiler.go, ['env', 'GOROOT'], {
  cwd: ROOT,
  env: compiler.env,
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 8_192,
  windowsHide: true,
  shell: false,
});
const goRoot = result.stdout?.trim();
if (result.error || result.status !== 0 || !goRoot || !path.isAbsolute(goRoot))
  throw Error('The pinned Go source root is unavailable.');
const sourceRoot = goRoot;

function readSource(relative: string): string {
  const file = path.join(sourceRoot, relative);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SOURCE_LIMIT)
    throw Error('The pinned Go source is invalid.');
  return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
}

const source = readSource(SOURCE_PATH);
if (createHash('sha256').update(source).digest('hex') !== SOURCE_SHA256)
  throw Error('The pinned Go timezone source has changed.');

const zones: Record<string, string> = {};
for (const match of source.matchAll(
  /^\s*"([^"\n]+)":\s*\{"[^"\n]*",\s*"[^"\n]*"\},\s*\/\/ ([A-Za-z0-9_+./-]+)\s*$/gm,
)) {
  const key = match[1];
  const zone = match[2];
  if (!key || !zone || Object.hasOwn(zones, key)) throw Error('Invalid Windows timezone mapping.');
  zones[key] = zone;
}
if (Object.keys(zones).length !== 139) throw Error('The pinned timezone mapping is incomplete.');

const mapping = {
  schemaVersion: 1,
  goVersion: GO_VERSION,
  source: `https://github.com/golang/go/blob/go${GO_VERSION}/${SOURCE_PATH}`,
  sourceSha256: SOURCE_SHA256,
  license: 'BSD-3-Clause',
  copyright: 'Copyright 2013 The Go Authors. All rights reserved.',
  zones: Object.fromEntries(
    Object.entries(zones).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ),
};
const outputs = new Map([
  ['windows-timezones.json', await format(JSON.stringify(mapping), { parser: 'json' })],
  ['GO-LICENSE.txt', readSource('LICENSE')],
]);
const check = process.argv.slice(2);
if (check.length > 1 || (check.length === 1 && check[0] !== '--check'))
  throw Error('Usage: node scripts/core/generate-timezones.mts [--check]');

for (const [name, content] of outputs) {
  const target = path.join(ROOT, OUTPUT_DIRECTORY, name);
  if (check.length) {
    if (fs.readFileSync(target, 'utf8') !== content)
      throw Error('Generated timezone data has drifted.');
  } else {
    fs.writeFileSync(target, content);
  }
}
