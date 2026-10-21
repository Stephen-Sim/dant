import fs from 'node:fs';
import path from 'node:path';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const TEST_ROOT = 'tests/go';
const LAYOUT_ERROR = 'The Go test layout is incomplete or invalid.';

export interface CoreGoTestFile {
  source: string;
  target: string;
  packageName: string;
}
export interface CoreGoTestLayout {
  files: readonly CoreGoTestFile[];
  replacements: Readonly<Record<string, string>>;
}
export interface CoreGoTestOverlay {
  file: string;
  layout: CoreGoTestLayout;
  close(): void;
}

function requireLayout(condition: unknown): asserts condition {
  if (!condition) throw Error(LAYOUT_ERROR);
}

function ordinary(root: string, relative: string): fs.Stats {
  let current = root;
  const initial = fs.lstatSync(current);
  requireLayout(initial.isDirectory() && !initial.isSymbolicLink());
  const segments = relative.split('/');
  for (const [index, segment] of segments.entries()) {
    requireLayout(segment !== '' && segment !== '.' && segment !== '..');
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    requireLayout(!stat.isSymbolicLink());
    if (index < segments.length - 1) requireLayout(stat.isDirectory());
  }
  return fs.lstatSync(current);
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function packageName(root: string, relative: string): string {
  const before = ordinary(root, relative);
  requireLayout(before.isFile() && before.nlink === 1 && before.size <= MAX_SOURCE_BYTES);
  const descriptor = fs.openSync(path.join(root, relative), 'r');
  try {
    requireLayout(sameFile(before, fs.fstatSync(descriptor)));
    const source = fs.readFileSync(descriptor, 'utf8');
    requireLayout(
      sameFile(before, fs.fstatSync(descriptor)) && sameFile(before, ordinary(root, relative)),
    );
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
    const name = /^\s*package\s+([A-Za-z_][A-Za-z_0-9]*)\s*(?:\r?\n|;|$)/.exec(
      withoutComments,
    )?.[1];
    requireLayout(name);
    return name;
  } finally {
    fs.closeSync(descriptor);
  }
}

function collectGoFiles(root: string, relative: string, output: string[]): void {
  const before = ordinary(root, relative);
  requireLayout(before.isDirectory());
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative + '/' + entry.name;
    const stat = ordinary(root, child);
    if (stat.isDirectory()) collectGoFiles(root, child, output);
    else {
      requireLayout(stat.isFile());
      if (entry.name.endsWith('.go')) output.push(child);
    }
  }
  requireLayout(sameFile(before, ordinary(root, relative)));
}

/** Physical test sources remain centralized; Go still compiles each original package. */
export function discoverCoreGoTests(root: string): CoreGoTestLayout {
  try {
    requireLayout(path.isAbsolute(root));
    const resolved = path.resolve(root);
    const production: string[] = [],
      sources: string[] = [];
    collectGoFiles(resolved, 'core', production);
    collectGoFiles(resolved, TEST_ROOT, sources);
    requireLayout(!production.some((file) => file.endsWith('_test.go')) && sources.length > 0);

    const packages = new Map<string, Set<string>>();
    for (const file of production) {
      const directory = path.posix.dirname(file);
      const names = packages.get(directory) ?? new Set<string>();
      names.add(packageName(resolved, file));
      packages.set(directory, names);
    }

    const files: CoreGoTestFile[] = [],
      replacements: Record<string, string> = {},
      targets = new Set<string>();
    for (const source of sources.sort()) {
      const relative = source.slice(TEST_ROOT.length + 1);
      requireLayout(
        source.endsWith('_test.go') &&
          /^(?:internal|cmd)\//.test(relative) &&
          !/^[_.]/.test(path.posix.basename(source)),
      );
      const target = 'core/' + relative;
      const names = packages.get(path.posix.dirname(target));
      requireLayout(names?.size === 1 && !targets.has(target.toLowerCase()));
      const expected = [...names][0];
      const actual = packageName(resolved, source);
      requireLayout(actual === expected || actual === expected + '_test');
      targets.add(target.toLowerCase());
      replacements[path.join(resolved, target)] = path.join(resolved, source);
      files.push({ source, target, packageName: actual });
    }
    return { files, replacements };
  } catch {
    throw Error(LAYOUT_ERROR);
  }
}

/** Explicit temporary compiler input; never changes production files or global GOFLAGS. */
export function createCoreGoTestOverlay(root: string): CoreGoTestOverlay {
  try {
    return createOverlay(root);
  } catch {
    throw Error(LAYOUT_ERROR);
  }
}

function createOverlay(root: string): CoreGoTestOverlay {
  const layout = discoverCoreGoTests(root);
  const resolved = path.resolve(root);
  for (const relative of ['.cache', '.cache/core']) {
    const directory = path.join(resolved, relative);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    requireLayout(ordinary(resolved, relative).isDirectory());
  }

  const directory = fs.mkdtempSync(path.join(resolved, '.cache/core/test-overlay-'));
  const file = path.join(directory, 'overlay.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ Replace: layout.replacements }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    const before = fs.lstatSync(directory),
      fileBefore = fs.lstatSync(file);
    let closed = false;
    return {
      file,
      layout,
      close() {
        if (closed) return;
        try {
          requireLayout(
            sameFile(before, fs.lstatSync(directory)) && sameFile(fileBefore, fs.lstatSync(file)),
          );
          fs.unlinkSync(file);
          fs.rmdirSync(directory);
          closed = true;
        } catch {
          throw Error(LAYOUT_ERROR);
        }
      },
    };
  } catch {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
    throw Error(LAYOUT_ERROR);
  }
}
