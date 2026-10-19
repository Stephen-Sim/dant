import { errorCode } from '../../src/contracts/json.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { exportSkillZip } from '../../src/skills/skill-export.mts';
import { SkillLibrary } from '../../src/skills/skill-library.mts';
import { SkillImporter } from '../../src/skills/skill-import.mts';
import {
  SKILL_SUPPORT_FILE_LIMIT,
  SKILL_TREE_ENTRY_LIMIT,
  SKILL_FILE_BYTES,
  SKILL_TOTAL_BYTES,
  SKILL_ARCHIVE_BYTES,
  SKILL_RELATIVE_PATH_CHARACTERS,
} from '../../src/skills/skill-limits.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const sample = {
  name: 'inspect-desktop',
  description: 'Review "the VM" safely. 中文说明。',
  instructions: 'Read scripts/check.py before use.\n先观察，再执行。',
  enabled: false,
  files: {
    'scripts/check.py': 'raise RuntimeError("Do not execute during export")\n',
    'references/流程.md': 'Review the visible desktop first.\n',
    'assets/schema.json': '{"safe":true}\n',
    'LICENSE.txt': 'MIT fixture license\n',
    NOTICE: 'Copyright fixture\n',
    'README.md': 'Read before use.\n',
  },
};
function fixture(
  t: NodeTestContext,
  options: Omit<ConstructorParameters<typeof SkillLibrary>[0], 'workspace'> = {},
) {
  const directory = fs.mkdtempSync(path.join(base, 'skill-export-')),
    workspace = path.join(directory, 'source'),
    target = path.join(directory, 'destination');
  fs.mkdirSync(workspace);
  fs.mkdirSync(target);
  const skills = new SkillLibrary({ workspace, ...options }),
    destination = new SkillLibrary({ workspace: target }),
    importer = new SkillImporter({ skills: destination });
  t.after(() => {
    importer.close();
    const relative = path.relative(base, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, workspace, skills, destination, importer };
}
function storedEntries(data: Buffer) {
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  assert.equal(data.readUInt16LE(end + 4), 0);
  assert.equal(data.readUInt16LE(end + 6), 0);
  assert.equal(data.readUInt16LE(end + 20), 0);
  const count = data.readUInt16LE(end + 10),
    centralOffset = data.readUInt32LE(end + 16),
    centralSize = data.readUInt32LE(end + 12);
  assert.equal(data.readUInt16LE(end + 8), count);
  assert.equal(centralOffset + centralSize, end);
  const entries = new Map();
  let cursor = centralOffset,
    localEnd = 0;
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50);
    assert.equal(data.readUInt16LE(cursor + 8), 0x800);
    assert.equal(data.readUInt16LE(cursor + 10), 0);
    assert.equal(data.readUInt16LE(cursor + 14), 0x21);
    const size = data.readUInt32LE(cursor + 24),
      nameSize = data.readUInt16LE(cursor + 28),
      offset = data.readUInt32LE(cursor + 42),
      name = data.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    assert.equal(data.readUInt32LE(cursor + 20), size);
    assert.equal(data.readUInt16LE(cursor + 30), 0);
    assert.equal(data.readUInt16LE(cursor + 32), 0);
    assert.equal(data.readUInt32LE(cursor + 38) >>> 16, 0o100600);
    assert.equal(offset, localEnd);
    assert.equal(data.readUInt32LE(offset), 0x04034b50);
    assert.equal(data.readUInt16LE(offset + 6), 0x800);
    assert.equal(data.readUInt16LE(offset + 8), 0);
    assert.equal(data.readUInt16LE(offset + 12), 0x21);
    assert.equal(data.readUInt32LE(offset + 18), size);
    assert.equal(data.readUInt32LE(offset + 22), size);
    assert.equal(data.readUInt16LE(offset + 26), nameSize);
    assert.equal(data.readUInt16LE(offset + 28), 0);
    assert.equal(data.subarray(offset + 30, offset + 30 + nameSize).toString('utf8'), name);
    const content = data.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size);
    assert.equal(content.length, size);
    assert.equal(crc32(content), data.readUInt32LE(cursor + 16));
    assert.equal(data.readUInt32LE(offset + 14), data.readUInt32LE(cursor + 16));
    assert.equal(entries.has(name), false);
    entries.set(name, content);
    localEnd = offset + 30 + nameSize + size;
    cursor += 46 + nameSize;
  }
  assert.equal(localEnd, centralOffset);
  assert.equal(cursor, end);
  return entries;
}

test('ZIP headers, UTF-8 paths, stored bytes and CRCs preserve scripts, license, notice and docs without running helpers', (t) => {
  const { skills } = fixture(t);
  const saved = skills.save(sample),
    exported = exportSkillZip(skills, sample.name),
    entries = storedEntries(exported.data);
  assert.equal(exported.name, 'inspect-desktop.zip');
  assert.ok(exported.data.length < 1024 * 1024);
  assert.equal(entries.size, 7);
  assert.equal(entries.has('inspect-desktop/.dant-managed.json'), false);
  assert.match(
    entries.get('inspect-desktop/SKILL.md').toString('utf8'),
    /^---\nname: "inspect-desktop"\ndescription: "Review \\"the VM\\" safely\. 中文说明。"\n---\n\n/,
  );
  for (const [name, text] of Object.entries(sample.files))
    assert.equal(entries.get('inspect-desktop/' + name).toString('utf8'), text);
  assert.deepEqual(skills.get(sample.name), saved);
  assert.equal(saved.enabled, false);
});

test('a managed skill exports and imports repeatedly without synthetic source footers or changing its disabled source', async (t) => {
  const { skills, destination, importer } = fixture(t),
    saved = skills.save(sample),
    exported = exportSkillZip(skills, saved.name),
    preview = await importer.preview({ name: exported.name, data: exported.data });
  assert.equal(preview.source, exported.name);
  assert.equal(preview.instructions, saved.instructions);
  assert.deepEqual(
    preview.files.map((file) => file.path).sort(),
    ['SKILL.md', ...Object.keys(sample.files)].sort(),
  );
  const imported = importer.commit({ id: preview.id, enabled: false });
  assert.equal(imported.enabled, false);
  assert.equal(imported.instructions, saved.instructions);
  assert.deepEqual({ ...imported.files }, sample.files);
  assert.deepEqual(skills.get(sample.name), saved);
  const second = exportSkillZip(destination, imported.name),
    again = await importer.preview({ name: second.name, data: second.data });
  assert.equal(again.instructions, saved.instructions);
  assert.throws(
    () => importer.commit({ id: again.id }),
    (error) => errorCode(error) === 'name_exists',
  );
  assert.deepEqual(destination.get(imported.name), imported);
  const copy = importer.commit({ id: again.id, name: 'renamed-copy', enabled: true });
  assert.equal(copy.enabled, true);
  assert.equal(copy.instructions, saved.instructions);
  assert.deepEqual({ ...copy.files }, sample.files);
});

test('maximum managed instruction and aggregate byte budgets roundtrip at their named limits', async (t) => {
  const { skills, importer, destination } = fixture(t),
    input = {
      name: 'maximum-skill',
      description: 'A boundary fixture.',
      instructions: 'i'.repeat(49152),
      files: {
        'assets/one.txt': 'a'.repeat(SKILL_FILE_BYTES),
        'assets/two.txt': 'b'.repeat(SKILL_TOTAL_BYTES - 49152 - SKILL_FILE_BYTES),
      },
    };
  assert.equal(
    Buffer.byteLength(input.instructions) +
      Object.values(input.files).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    SKILL_TOTAL_BYTES,
  );
  skills.save(input);
  const exported = exportSkillZip(skills, input.name),
    preview = await importer.preview({ name: exported.name, data: exported.data }),
    saved = importer.commit({ id: preview.id });
  assert.ok(exported.data.length > SKILL_TOTAL_BYTES);
  assert.ok(exported.data.length < SKILL_ARCHIVE_BYTES, 'the full payload remains downloadable');
  assert.equal(saved.instructions, input.instructions);
  assert.deepEqual(saved.files, {}, 'large text stays out of the bounded JSON editor');
  assert.equal(saved.assets?.length, 2);
  const restoredFiles = destination.exportSnapshot(saved.name).files;
  for (const [relative, text] of Object.entries(input.files)) {
    assert.equal(
      fs.readFileSync(path.join(path.dirname(saved.path), relative)).equals(Buffer.from(text)),
      true,
      relative,
    );
    assert.equal(restoredFiles[relative] === text, true, relative);
  }
  assert.equal(storedEntries(exported.data).size, 3);
});

test('maximum Unicode path headers and metadata leave room for the entire skill within its downloadable ZIP cap', (t) => {
  const { skills } = fixture(t),
    name = 'm'.repeat(64),
    instructions = 'i'.repeat(49152),
    files = Object.fromEntries(
      Array.from({ length: SKILL_SUPPORT_FILE_LIMIT }, (_, index) => {
        const suffix = '-' + String(index).padStart(3, '0') + '.bin';
        return [
          'assets/' + '界'.repeat(SKILL_RELATIVE_PATH_CHARACTERS - 7 - suffix.length) + suffix,
          '',
        ];
      }),
    ),
    exported = exportSkillZip(
      {
        exportSnapshot: () => ({ name, description: 'd'.repeat(1000), instructions, files }),
        fileName: (relative) => skills.fileName(relative),
      },
      name,
    ),
    framingBytes = exported.data.length - Buffer.byteLength(instructions);
  assert.equal(storedEntries(exported.data).size, SKILL_SUPPORT_FILE_LIMIT + 1);
  assert.ok(
    SKILL_TOTAL_BYTES + framingBytes < SKILL_ARCHIVE_BYTES,
    'even all longest UTF-8 paths and full metadata fit beside the maximum decoded contents',
  );
});

test('all 128 supporting files are exported and remain importable', async (t) => {
  const { skills, importer } = fixture(t),
    input = {
      name: 'many-files',
      description: 'Maximum supporting file count.',
      instructions: 'Read references before acting.',
      files: Object.fromEntries(
        Array.from({ length: SKILL_SUPPORT_FILE_LIMIT }, (_, index) => [
          'references/' + index + '.md',
          'Reference ' + index,
        ]),
      ),
    };
  skills.save(input);
  const exported = exportSkillZip(skills, input.name);
  assert.equal(storedEntries(exported.data).size, 129);
  const preview = await importer.preview({ name: exported.name, data: exported.data });
  assert.equal(preview.files.length, 129);
  assert.deepEqual({ ...importer.commit({ id: preview.id }).files }, input.files);
});

test('a shell-grown 30-file skill keeps every helper through edit, toggles, export and import', async (t) => {
  const { skills, importer } = fixture(t),
    initial = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        'scripts/helper-' + index + '.mjs',
        'export const value=' + index + ';\n',
      ]),
    ),
    saved = skills.save({ ...sample, files: initial }),
    directory = path.dirname(saved.path),
    files = { ...initial };
  for (let index = 20; index < 30; index++) {
    const relative = 'scripts/helper-' + index + '.mjs',
      text = '// 中文 helper ' + index + '\nexport const value=' + index + ';\n';
    files[relative] = text;
    fs.writeFileSync(path.join(directory, relative), text);
  }
  assert.deepEqual(skills.get(saved.name).files, files);
  const edited = skills.save({
    name: saved.name,
    description: 'Updated complete skill',
    instructions: 'Use the included 30 helpers.',
  });
  assert.deepEqual(edited.files, files);
  skills.setEnabled(saved.name, true);
  skills.setEnabled(saved.name, false);
  assert.deepEqual(skills.get(saved.name).files, files);
  const exported = exportSkillZip(skills, saved.name),
    entries = storedEntries(exported.data);
  assert.equal(entries.size, 31);
  for (const [relative, text] of Object.entries(files))
    assert.deepEqual(entries.get(saved.name + '/' + relative), Buffer.from(text));
  const preview = await importer.preview({ name: exported.name, data: exported.data }),
    restored = importer.commit({ id: preview.id });
  assert.deepEqual(restored.files, files);
  assert.equal(restored.instructions, edited.instructions);
  assert.deepEqual(skills.get(saved.name).files, files);
});

test('export rejects missing, invalid, unmanaged and redirected sources without reading outside managed storage', (t) => {
  const { skills, workspace, directory } = fixture(t);
  assert.throws(() => exportSkillZip(skills, 'missing'), /not found/);
  for (const name of ['../outside', 'UPPER', 'a/b', ''])
    assert.throws(() => exportSkillZip(skills, name), /Invalid/);
  const userSkill = path.join(workspace, '.agents', 'skills', 'user-owned');
  fs.mkdirSync(userSkill, { recursive: true });
  fs.writeFileSync(path.join(userSkill, 'SKILL.md'), 'User-owned instructions.');
  assert.throws(() => exportSkillZip(skills, 'user-owned'));
  assert.equal(
    fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8'),
    'User-owned instructions.',
  );
  const saved = skills.save(sample),
    outside = path.join(directory, 'outside-reference');
  fs.writeFileSync(outside, 'outside content');
  const helper = path.join(path.dirname(saved.path), 'scripts/check.py');
  fs.unlinkSync(helper);
  fs.symlinkSync(outside, helper);
  assert.throws(() => exportSkillZip(skills, sample.name), /Invalid managed/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside content');
});

test('export revalidates aggregate limits, metadata, paths and secrets even after managed files change on disk', (t) => {
  const { skills } = fixture(t, {
    containsSecret: (value: string) => value.includes('vault-fixture-value'),
  });
  let saved = skills.save(sample),
    directory = path.dirname(saved.path),
    marker = path.join(directory, '.dant-managed.json');
  const alter = (operation: () => void) => {
    saved = skills.save(sample);
    directory = path.dirname(saved.path);
    marker = path.join(directory, '.dant-managed.json');
    operation();
    assert.throws(() => exportSkillZip(skills, sample.name));
  };
  alter(() => fs.appendFileSync(saved.path, 'x'.repeat(49152)));
  alter(() =>
    fs.writeFileSync(path.join(directory, 'scripts/check.py'), 'x'.repeat(SKILL_FILE_BYTES + 1)),
  );
  alter(() => {
    const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
    meta.files = ['references/one', 'references/two', 'references/three', 'references/four'];
    for (const name of meta.files)
      fs.writeFileSync(path.join(directory, name), 'x'.repeat(SKILL_FILE_BYTES));
    fs.writeFileSync(marker, JSON.stringify(meta));
  });
  alter(() => {
    const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
    meta.description = '';
    fs.writeFileSync(marker, JSON.stringify(meta));
  });
  alter(() => {
    const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
    meta.description = 'x'.repeat(1001);
    fs.writeFileSync(marker, JSON.stringify(meta));
  });
  alter(() =>
    fs.writeFileSync(
      path.join(directory, 'unsupported-root.py'),
      'must not silently omit this source',
    ),
  );
  alter(() => fs.writeFileSync(path.join(directory, 'scripts/check.py'), 'vault-fixture-value'));
  alter(() => {
    const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
    meta.description = 'vault-fixture-value';
    fs.writeFileSync(marker, JSON.stringify(meta));
  });
  alter(() => fs.appendFileSync(saved.path, 'vault-fixture-value'));
});

test('editing and export discover shell-added helpers and license docs using actual current files without changing the marker', async (t) => {
  const { skills, importer } = fixture(t),
    saved = skills.save(sample),
    directory = path.dirname(saved.path),
    marker = path.join(directory, '.dant-managed.json'),
    originalMarker = fs.readFileSync(marker),
    added = {
      'scripts/shell-added.py': 'print("not executed by export")\n',
      'LICENSE.md': 'Additional license document.\n',
      'references/notes.md': 'Added during development.\n',
    };
  for (const [relative, text] of Object.entries(added))
    fs.writeFileSync(path.join(directory, relative), text);
  for (const name of ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']) {
    const cache = path.join(directory, 'scripts', name);
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, 'generated.bin'), Buffer.from([0, 255]));
  }
  assert.deepEqual(skills.get(sample.name).files, { ...sample.files, ...added });
  const exported = exportSkillZip(skills, sample.name),
    entries = storedEntries(exported.data);
  assert.equal(entries.size, 10);
  assert.equal(
    [...entries.keys()].some(
      (relative) => relative.includes('cache') || relative.endsWith('.dant-managed.json'),
    ),
    false,
  );
  for (const [relative, text] of Object.entries(added))
    assert.equal(entries.get(sample.name + '/' + relative).toString('utf8'), text);
  const preview = await importer.preview({ name: exported.name, data: exported.data }),
    imported = importer.commit({ id: preview.id, enabled: false });
  assert.deepEqual({ ...imported.files }, { ...sample.files, ...added });
  assert.equal(skills.get(sample.name).enabled, false);
  assert.deepEqual(fs.readFileSync(marker), originalMarker);
});

test('stale marker entries do not omit current files or make export read missing and outside paths', (t) => {
  const { skills } = fixture(t),
    saved = skills.save(sample),
    directory = path.dirname(saved.path),
    marker = path.join(directory, '.dant-managed.json'),
    meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
  meta.files.push('scripts/missing.py', 'scripts/../../outside');
  fs.writeFileSync(marker, JSON.stringify(meta));
  fs.unlinkSync(path.join(directory, 'scripts/check.py'));
  fs.writeFileSync(path.join(directory, 'scripts/replacement.py'), 'Current implementation.');
  assert.equal(skills.get(sample.name).files['scripts/replacement.py'], 'Current implementation.');
  assert.equal(skills.get(sample.name).files['scripts/missing.py'], undefined);
  const entries = storedEntries(exportSkillZip(skills, sample.name).data);
  assert.equal(entries.has(sample.name + '/scripts/check.py'), false);
  assert.equal(entries.has(sample.name + '/scripts/missing.py'), false);
  assert.equal(
    entries.get(sample.name + '/scripts/replacement.py').toString('utf8'),
    'Current implementation.',
  );
  assert.equal(entries.size, 7);
});

test('shell-created nested project remains complete through toggle, instruction-only update, ZIP export and import', async (t) => {
  const { skills, importer } = fixture(t),
    saved = skills.save({
      name: 'portable-project',
      description: 'Self-contained helpers.',
      instructions: 'Use scripts/project/run.mjs.',
    }),
    directory = path.dirname(saved.path),
    files = {
      'scripts/project/run.mjs': 'import "../lib/helper.mjs";\n',
      'scripts/project/lib/helper.mjs': 'export const value=1;\n',
      'scripts/project/package.json': '{"type":"module","dependencies":{"example":"1.0.0"}}\n',
      'scripts/project/package-lock.json': '{"lockfileVersion":3}\n',
      'scripts/project/LICENSE': 'Fixture dependency license\n',
      'references/setup.md': 'Use npm ci in scripts/project; do not bundle node_modules.\n',
    };
  for (const [relative, text] of Object.entries(files)) {
    const full = path.join(directory, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  skills.setEnabled(saved.name, false);
  skills.setEnabled(saved.name, true);
  skills.save({
    name: saved.name,
    description: 'Updated helper instructions',
    instructions: 'Read references/setup.md, then use scripts/project/run.mjs.',
  });
  const exported = exportSkillZip(skills, saved.name),
    entries = storedEntries(exported.data);
  assert.equal(entries.size, 7);
  for (const [relative, text] of Object.entries(files))
    assert.equal(entries.get(saved.name + '/' + relative).toString('utf8'), text);
  const preview = await importer.preview({ name: exported.name, data: exported.data }),
    restored = importer.commit({ id: preview.id });
  assert.deepEqual(restored.files, files);
  assert.equal(
    restored.instructions,
    'Read references/setup.md, then use scripts/project/run.mjs.',
  );
});

test('npm installed binaries and nested dependencies are excluded while authored source and lockfiles roundtrip unchanged', async (t) => {
  const { skills, importer } = fixture(t),
    input = {
      name: 'npm-helper',
      description: 'Portable dependency fixture.',
      instructions: 'Run npm ci from scripts/project, then use run.mjs.',
      files: {
        'scripts/project/run.mjs': 'import "example";\n',
        'scripts/project/package.json': '{"dependencies":{"example":"1.0.0"}}\n',
        'scripts/project/package-lock.json': '{"lockfileVersion":3}\n',
        'scripts/project/LICENSE': 'Fixture license\n',
      },
    },
    saved = skills.save(input),
    directory = path.dirname(saved.path),
    generated = path.join(
      directory,
      'scripts/project/node_modules/example/node_modules/nested/build/native.node',
    );
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  const binary = Buffer.from([0, 255, 127, 128]);
  fs.writeFileSync(generated, binary);
  fs.writeFileSync(
    path.join(directory, 'scripts/project/node_modules/example/resource.bin'),
    Buffer.alloc(300000),
  );
  const exported = exportSkillZip(skills, input.name),
    entries = storedEntries(exported.data);
  assert.equal(entries.size, 5);
  assert.equal(
    [...entries.keys()].some((name) => name.includes('node_modules')),
    false,
  );
  assert.deepEqual(fs.readFileSync(generated), binary);
  for (const [relative, text] of Object.entries(input.files))
    assert.equal(entries.get(input.name + '/' + relative).toString('utf8'), text);
  const preview = await importer.preview({ name: exported.name, data: exported.data }),
    restored = importer.commit({ id: preview.id });
  assert.deepEqual(restored.files, input.files);
});

test('unsafe links, invalid instruction UTF-8 and explicit walk limits fail rather than produce incomplete ZIPs', (t) => {
  const { skills, directory: fixtureDirectory } = fixture(t);
  let saved = skills.save(sample),
    directory = path.dirname(saved.path);
  const alter = (operation: () => void) => {
    saved = skills.save(sample);
    directory = path.dirname(saved.path);
    operation();
    assert.throws(() => exportSkillZip(skills, sample.name));
  };
  alter(() =>
    fs.writeFileSync(path.join(directory, 'assets/unlisted.txt'), 'x'.repeat(SKILL_FILE_BYTES + 1)),
  );
  alter(() => {
    for (let index = 0; index < SKILL_SUPPORT_FILE_LIMIT; index++)
      fs.writeFileSync(
        path.join(directory, 'references', 'extra-' + index + '.md'),
        'Extra source.',
      );
  });
  alter(() => {
    for (let index = 0; index < SKILL_TREE_ENTRY_LIMIT + 1; index++)
      fs.mkdirSync(path.join(directory, 'scripts', 'empty-' + index));
  });
  alter(() =>
    fs.mkdirSync(
      path.join(directory, 'references', ...Array.from({ length: 17 }, () => 'nested')),
      { recursive: true },
    ),
  );
  alter(() => {
    const outside = path.join(fixtureDirectory, 'outside-directory');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'private.txt'), 'outside fixture');
    fs.symlinkSync(
      outside,
      path.join(directory, 'scripts', '__pycache__'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  });
  alter(() => {
    const outside = path.join(fixtureDirectory, 'outside-hardlink.txt');
    fs.writeFileSync(outside, 'outside fixture');
    fs.linkSync(outside, path.join(directory, 'references/linked.txt'));
  });
  alter(() =>
    fs.writeFileSync(
      saved.path,
      Buffer.concat([
        Buffer.from('---\nname: inspect-desktop\ndescription: valid\n---\n\n'),
        Buffer.from([255]),
      ]),
    ),
  );
});

test('export validates returned managed shape, collision paths and filename secrets before creating any archive', () => {
  const normal = { ...sample, files: { ...sample.files } },
    fileName = (relative: string) => new SkillLibrary({ workspace: base }).fileName(relative),
    fake = (value: unknown) => ({
      exportSnapshot: () => value,
      fileName,
      containsSecret: (value: string) => value.includes('vault-fixture-value'),
    });
  for (const value of [
    { ...normal, name: '../outside' },
    { ...normal, description: null },
    { ...normal, instructions: '' },
    { ...normal, instructions: '\0bad' },
    { ...normal, files: [] },
    { ...normal, files: { 'references/check.md': 3 } },
    { ...normal, files: { 'references/vault-fixture-value.md': 'safe' } },
    { ...normal, files: { 'references/A.md': 'a', 'references/a.md': 'b' } },
    { ...normal, files: { 'references/path': 'file', 'references/path/file.md': 'nested' } },
    {
      ...normal,
      files: Object.fromEntries(
        Array.from({ length: SKILL_SUPPORT_FILE_LIMIT + 1 }, (_, index) => [
          'references/' + index + '.md',
          'small',
        ]),
      ),
    },
  ])
    assert.throws(() => exportSkillZip(fake(value), sample.name));
  assert.equal(
    storedEntries(exportSkillZip(fake({ ...normal, files: null }), sample.name).data).size,
    1,
  );
});
