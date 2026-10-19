import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SkillLibrary } from '../../src/skills/skill-library.mts';
import { SkillImporter } from '../../src/skills/skill-import.mts';
import { exportSkillZip } from '../../src/skills/skill-export.mts';
import {
  skillFileFromValue,
  skillExportFailureReason,
  SkillExportFailure,
} from '../../src/skills/skill-files.mts';
import {
  SKILL_FILE_BYTES,
  SKILL_EDITOR_FILE_BYTES,
  SKILL_EDITOR_TOTAL_BYTES,
  SKILL_EDITOR_JSON_BYTES,
} from '../../src/skills/skill-limits.mts';
import { errorCode } from '../../src/contracts/json.mts';
import type { SkillBinaryFile } from '../../src/skills/skill-types.ts';

const base = path.resolve('.cache/tests'),
  sample = {
    name: 'portable-project',
    description: 'A portable project with preserved data.',
    instructions: 'Review the provided helpers; management must never execute them.',
  },
  digest = (data: Buffer) => createHash('sha256').update(data).digest('hex'),
  encoded = (data: Buffer): SkillBinaryFile => ({
    encoding: 'base64',
    mediaType: 'application/octet-stream',
    data: data.toString('base64'),
  });
fs.mkdirSync(base, { recursive: true });
function fixture(t: TestContext, containsSecret = (_value: string) => false) {
  const root = fs.mkdtempSync(path.join(base, 'large-skill-')),
    workspace = path.join(root, 'source'),
    target = path.join(root, 'target');
  fs.mkdirSync(workspace);
  fs.mkdirSync(target);
  const skills = new SkillLibrary({ workspace, containsSecret }),
    destination = new SkillLibrary({ workspace: target, containsSecret }),
    importer = new SkillImporter({ skills: destination });
  t.after(() => {
    importer.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { skills, destination, importer };
}
function writeFiles(folder: string, files: ReadonlyMap<string, Buffer>) {
  for (const [relative, data] of files) {
    const file = path.join(folder, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
}
function checkBytes(folder: string, expected: ReadonlyMap<string, string>) {
  for (const [relative, hash] of expected)
    assert.equal(digest(fs.readFileSync(path.join(folder, relative))), hash, relative);
}

test('an independently grown 81-file 3.8 MB project keeps large PNG and UTF-8 bytes through bounded editing, toggles and portable import', async (t) => {
  const { skills, destination, importer } = fixture(t),
    saved = skills.save(sample),
    files = new Map<string, Buffer>([
      [
        'assets/large.png',
        Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          Buffer.alloc(1557774 - 8, 255),
        ]),
      ],
      ['assets/second.png', Buffer.alloc(500000, 255)],
      ['references/large-utf8.txt', Buffer.from('\uFEFF' + '原文保持\r\n'.repeat(50000))],
      ...Array.from({ length: 78 }, (_, index): [string, Buffer] => [
        'scripts/source-' + index + '.py',
        Buffer.from('# Never execute during management\r\n' + 'x'.repeat(13265)),
      ]),
    ]),
    expected = new Map([...files].map(([relative, data]) => [relative, digest(data)]));
  assert.equal(files.size, 81);
  const bytes = [...files.values()].reduce((sum, data) => sum + data.length, 0);
  assert.ok(bytes > 3700000 && bytes < 3900000);
  writeFiles(path.dirname(saved.path), files);
  const marker = fs.readFileSync(path.join(path.dirname(saved.path), '.dant-managed.json')),
    view = skills.get(saved.name);
  assert.equal(Object.keys(view.files).length, 78);
  assert.equal(view.assets?.length, 3);
  assert.equal(view.assets?.find((item) => item.path === 'assets/large.png')?.size, 1557774);
  assert.equal(view.files['references/large-utf8.txt'], undefined);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ instructions: view.instructions, files: view.files })) <=
      SKILL_EDITOR_JSON_BYTES,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(path.dirname(saved.path), '.dant-managed.json')),
    marker,
  );
  const edited = skills.save({
    ...sample,
    description: 'Explicit metadata and small-file edit',
    files: { ...view.files, 'scripts/source-0.py': '# Changed only this helper\r\n' },
    preserveBinaryFiles: true,
  });
  expected.set('scripts/source-0.py', digest(Buffer.from('# Changed only this helper\r\n')));
  checkBytes(path.dirname(edited.path), expected);
  assert.throws(() =>
    skills.save({
      ...sample,
      files: { ...view.files, 'references/large-utf8.txt': 'Do not overwrite a read-only asset' },
      preserveBinaryFiles: true,
    }),
  );
  checkBytes(path.dirname(edited.path), expected);
  const disabled = skills.setEnabled(saved.name, false);
  checkBytes(path.dirname(disabled.path), expected);
  const enabled = skills.setEnabled(saved.name, true);
  checkBytes(path.dirname(enabled.path), expected);
  const archive = exportSkillZip(skills, saved.name),
    preview = await importer.preview({ name: archive.name, data: archive.data });
  assert.equal(preview.files.length, 82);
  const imported = importer.commit({ id: preview.id });
  checkBytes(path.dirname(imported.path), expected);
  assert.equal(
    destination.exportSnapshot(imported.name).files['references/large-utf8.txt'] ===
      files.get('references/large-utf8.txt')?.toString('utf8'),
    true,
  );
  assert.equal(skills.save({ ...sample, files: {}, preserveBinaryFiles: false }).assets, undefined);
  assert.equal(
    fs.existsSync(path.join(path.dirname(enabled.path), 'references/large-utf8.txt')),
    false,
  );
});

test('aggregate editor limits preserve individually small files and JSON escaping cannot inflate a projected map past its transport budget', async (t) => {
  const { skills, destination, importer } = fixture(t),
    files = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        'references/file-' + index + '.txt',
        '\\'.repeat(220 * 1024),
      ]),
    ),
    view = skills.save({ ...sample, files });
  assert.ok(
    Object.values(view.files).every((value) => Buffer.byteLength(value) <= SKILL_EDITOR_FILE_BYTES),
  );
  assert.ok(
    Buffer.byteLength(view.instructions) +
      Object.values(view.files).reduce((sum, value) => sum + Buffer.byteLength(value), 0) <=
      SKILL_EDITOR_TOTAL_BYTES,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify({ instructions: view.instructions, files: view.files })) <=
      SKILL_EDITOR_JSON_BYTES,
  );
  assert.ok(view.assets?.length);
  const readonly = new Map(
    (view.assets ?? []).map((asset) => [asset.path, digest(Buffer.from(files[asset.path] ?? ''))]),
  );
  const edited = skills.save({ ...sample, files: {}, preserveBinaryFiles: true });
  checkBytes(path.dirname(edited.path), readonly);
  for (const relative of Object.keys(view.files))
    assert.equal(fs.existsSync(path.join(path.dirname(edited.path), relative)), false, relative);
  const nearLimit = skills.save({
    ...sample,
    instructions: 'i',
    files: Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        'references/escaped-' + index + '.txt',
        '\\'.repeat(SKILL_EDITOR_FILE_BYTES - (index === 3 ? 1 : 0)),
      ]),
    ),
  });
  assert.equal(
    Object.keys(nearLimit.files).length,
    3,
    'JSON property and escaping overhead must count before exposing editor text',
  );
  assert.equal(nearLimit.assets?.length, 1);
  const escapedSnapshot = skills.exportSnapshot(nearLimit.name),
    expected = new Map(
      Object.entries(escapedSnapshot.files).map(([relative, value]) => [
        relative,
        digest(Buffer.from(value)),
      ]),
    ),
    reread = skills.get(nearLimit.name),
    preserved = skills.save({
      ...sample,
      instructions: reread.instructions,
      files: reread.files,
      preserveBinaryFiles: true,
    });
  checkBytes(path.dirname(preserved.path), expected);
  const archive = exportSkillZip(skills, nearLimit.name),
    preview = await importer.preview({ name: archive.name, data: archive.data }),
    imported = importer.commit({ id: preview.id });
  checkBytes(path.dirname(imported.path), expected);
  assert.equal(destination.get(imported.name).assets?.length, 1);
});

test('eight-megabyte opaque payloads remain canonical and over-limit data fails before replacing a skill', (t) => {
  const { skills } = fixture(t),
    original = skills.save(sample),
    data = Buffer.alloc(8 * 1024 * 1024, 255),
    value = encoded(data);
  assert.equal(data.length, SKILL_FILE_BYTES);
  assert.equal(skillFileFromValue('assets/full.arbitrary', value).data.equals(data), true);
  const saved = skills.save({ ...sample, binaryFiles: { 'assets/full.arbitrary': value } });
  assert.equal(saved.assets?.[0]?.size, data.length);
  assert.equal(
    digest(fs.readFileSync(path.join(path.dirname(saved.path), 'assets/full.arbitrary'))),
    digest(data),
  );
  assert.throws(
    () =>
      skills.save({
        ...sample,
        files: { 'assets/too-large.data': 'x'.repeat(SKILL_FILE_BYTES + 1) },
      }),
    (error) => errorCode(error) === 'size_limit',
  );
  assert.equal(
    digest(fs.readFileSync(path.join(path.dirname(saved.path), 'assets/full.arbitrary'))),
    digest(data),
  );
  assert.equal(original.instructions, saved.instructions);
});

test('credential checks cover the end of large UTF-8 and opaque assets even when the editor omits their bytes', async (t) => {
  const secret = 'isolated-vault-value-at-end',
    { skills, importer, destination } = fixture(t, (value) => value.includes(secret)),
    saved = skills.save(sample),
    folder = path.dirname(saved.path),
    samples = [
      Buffer.from('x'.repeat(700000) + secret),
      Buffer.concat([Buffer.alloc(1557774, 255), Buffer.from(secret)]),
    ];
  for (const data of samples) {
    const relative = 'assets/private.resource',
      file = path.join(folder, relative);
    writeFiles(folder, new Map([[relative, data]]));
    for (const read of [() => skills.get(saved.name), () => exportSkillZip(skills, saved.name)])
      assert.throws(
        read,
        (error) => skillExportFailureReason(error) === SkillExportFailure.Credentials,
      );
    assert.equal(digest(fs.readFileSync(file)), digest(data));
    fs.unlinkSync(file);
    const zip = exportSkillZip(
      {
        exportSnapshot: () => ({
          ...sample,
          files: {},
          binaryFiles: { [relative]: encoded(data) },
        }),
        fileName: (name) => skills.fileName(name),
      },
      sample.name,
    );
    await assert.rejects(
      importer.preview({ name: zip.name, data: zip.data }),
      (error) => errorCode(error) === 'invalid_skill',
    );
    assert.deepEqual(destination.list(), []);
  }
});
