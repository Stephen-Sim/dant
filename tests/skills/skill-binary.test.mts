import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SkillLibrary } from '../../src/skills/skill-library.mts';
import { SkillImporter } from '../../src/skills/skill-import.mts';
import { exportSkillZip } from '../../src/skills/skill-export.mts';
import {
  SkillExportFailure,
  skillExportFailureReason,
  skillFileFromBytes,
  skillFileFromValue,
  skillInstructionText,
} from '../../src/skills/skill-files.mts';
import {
  SKILL_FILE_BYTES,
  SKILL_SUPPORT_FILE_LIMIT,
  SKILL_TOTAL_BYTES,
} from '../../src/skills/skill-limits.mts';
import { errorCode } from '../../src/contracts/json.mts';
import type { SkillBinaryFile } from '../../src/skills/skill-types.ts';
import { skillPngFixture } from '../support/skill-png-fixtures.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const sample = {
  name: 'binary-workflow',
  description: 'A workflow with inert supporting files.',
  instructions: 'Use scripts/check.py after reviewing its reference files.',
  files: { 'scripts/check.py': 'raise RuntimeError("Never execute during skill management")\n' },
};
const encoded = (data: Buffer): SkillBinaryFile => ({
  encoding: 'base64',
  mediaType: 'application/octet-stream',
  data: data.toString('base64'),
});
function fixture(t: TestContext, containsSecret = (_value: string) => false) {
  const directory = fs.mkdtempSync(path.join(base, 'skill-binary-')),
    workspace = path.join(directory, 'source'),
    target = path.join(directory, 'target');
  fs.mkdirSync(workspace);
  fs.mkdirSync(target);
  const skills = new SkillLibrary({ workspace, containsSecret }),
    destination = new SkillLibrary({ workspace: target, containsSecret }),
    importer = new SkillImporter({ skills: destination });
  t.after(() => {
    importer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, workspace, skills, destination, importer };
}
const utf16 = Buffer.concat([
  Buffer.from([255, 254]),
  Buffer.from('Unicode source\r\n', 'utf16le'),
]);
const assets = new Map([
  ['scripts/rotation.png', skillPngFixture()],
  ['references/桌面.jpg', Buffer.from([255, 216, 255, 0, 128, 255, 217])],
  ['assets/document.pdf', Buffer.from('%PDF-1.7\r\nOpaque PDF fixture\r\n%%EOF')],
  ['scripts/bundle.zip', Buffer.from([80, 75, 3, 4, 0, 255, 128, 0])],
  ['scripts/helper.exe', Buffer.concat([Buffer.from('MZ'), Buffer.from([0, 255, 128])])],
  ['scripts/helper.pyc', Buffer.from([167, 13, 13, 10, 0, 255, 0])],
  ['assets/unknown.format', Buffer.from([255, 254, 253, 128, 0])],
  ['assets/malformed.png', Buffer.from([0, 255, 1])],
  ['assets/source-utf16.txt', utf16],
  ['references/source-utf8.txt', Buffer.from('\uFEFFOriginal\r\nUTF-8 text\r\n')],
]);

test('all supporting formats retain exact bytes across editor changes, toggle, ZIP export and import without execution', async (t) => {
  const { skills, workspace, destination, importer } = fixture(t),
    saved = skills.save(sample),
    folder = path.dirname(saved.path);
  for (const [relative, data] of assets) {
    const file = path.join(folder, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  const marker = fs.readFileSync(path.join(folder, '.dant-managed.json')),
    viewed = skills.get(saved.name);
  assert.equal(Object.hasOwn(viewed, 'binaryFiles'), false);
  assert.equal(viewed.assets?.length, assets.size - 1);
  assert.equal(viewed.files['references/source-utf8.txt'], '\uFEFFOriginal\r\nUTF-8 text\r\n');
  assert.deepEqual(fs.readFileSync(path.join(folder, '.dant-managed.json')), marker);
  skills.save({
    name: saved.name,
    description: 'Metadata edit',
    instructions: sample.instructions,
  });
  const edited = skills.save({
    ...sample,
    files: { ...viewed.files, 'scripts/new.py': '# Replacement text only\n' },
    preserveBinaryFiles: true,
  });
  assert.equal(edited.assets?.length, assets.size - 1);
  skills.setEnabled(saved.name, false);
  skills.setEnabled(saved.name, true);
  assert.deepEqual(new SkillLibrary({ workspace }).get(saved.name).assets, edited.assets);
  const archive = exportSkillZip(skills, saved.name),
    preview = await importer.preview({ name: archive.name, data: archive.data });
  for (const [relative, data] of assets)
    assert.equal(preview.files.find((item) => item.path === relative)?.size, data.length);
  const restored = importer.commit({ id: preview.id, enabled: false });
  assert.equal(restored.enabled, false);
  assert.deepEqual(restored.assets, edited.assets);
  assert.deepEqual(restored.files, edited.files);
  for (const [relative, data] of assets) {
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(restored.path), relative)), data);
    assert.deepEqual(fs.readFileSync(path.join(folder, relative)), data);
  }
  assert.deepEqual(exportSkillZip(destination, restored.name).data, archive.data);
});

test('legacy full replacement remains explicit while editor preservation cannot discard opaque assets', (t) => {
  const { skills } = fixture(t),
    data = Buffer.from([0, 255, 128]),
    saved = skills.save({ ...sample, binaryFiles: { 'scripts/opaque.data': encoded(data) } });
  assert.deepEqual(
    fs.readFileSync(path.join(path.dirname(saved.path), 'scripts/opaque.data')),
    data,
  );
  assert.throws(() => skills.save({ ...sample, preserveBinaryFiles: 'yes' }));
  assert.throws(() => skills.save({ ...sample, preserveBinaryFiles: true, binaryFiles: {} }));
  assert.throws(() => skills.save({ ...sample, name: 'new-skill', preserveBinaryFiles: true }));
  assert.equal(skills.get(saved.name).assets?.length, 1);
  const replaced = skills.save({ ...sample, files: {} });
  assert.deepEqual(replaced.files, {});
  assert.equal(replaced.assets, undefined);
  assert.equal(fs.existsSync(path.join(path.dirname(saved.path), 'scripts/opaque.data')), false);
});

test('base64 payloads are canonical, bounded and schema validated before replacing any saved file', (t) => {
  const { skills } = fixture(t),
    saved = skills.save(sample),
    binary = encoded(Buffer.from([255, 0]));
  for (const value of [
    null,
    [],
    {},
    'raw text',
    { ...binary, extra: true },
    { ...binary, encoding: 'hex' },
    { ...binary, mediaType: 'image/png' },
    { ...binary, data: binary.data + '\n' },
    { ...binary, data: 'AB==' },
    { ...binary, data: 'A===' },
    { ...binary, data: 'a'.repeat(4 * Math.ceil(SKILL_FILE_BYTES / 3) + 4) },
  ]) {
    assert.throws(() => skills.save({ ...sample, binaryFiles: { 'assets/opaque.data': value } }));
    assert.deepEqual(skills.get(saved.name), saved);
  }
  assert.throws(() => skills.save({ ...sample, binaryFiles: [] }));
  assert.throws(() => skills.save({ ...sample, files: { 'assets/opaque.data': binary } }));
  assert.throws(() => skillFileFromBytes('assets/large.data', Buffer.alloc(SKILL_FILE_BYTES + 1)));
  for (const [relative, data] of assets)
    assert.deepEqual(skillFileFromValue(relative, encoded(data)).data, data);
  assert.deepEqual(
    skillFileFromValue('references/plain.txt', 'plain text').data,
    Buffer.from('plain text'),
  );
});

test('known credentials are checked from actual bytes, including UTF-16, rather than their base64 representation', async (t) => {
  const { skills, importer, destination } = fixture(t, (value) =>
      value.includes('vault-fixture-value'),
    ),
    saved = skills.save(sample),
    folder = path.dirname(saved.path);
  const littleEndian = Buffer.concat([
      Buffer.from([255, 254]),
      Buffer.from('vault-fixture-value', 'utf16le'),
    ]),
    bigEndian = Buffer.from(littleEndian);
  bigEndian.swap16();
  for (const data of [
    Buffer.concat([Buffer.from([0, 255]), Buffer.from('vault-fixture-value')]),
    littleEndian,
    bigEndian,
  ]) {
    const file = path.join(folder, 'scripts/opaque.data');
    assert.throws(() =>
      skills.save({ ...sample, binaryFiles: { 'scripts/opaque.data': encoded(data) } }),
    );
    assert.deepEqual(skills.get(saved.name), saved);
    fs.writeFileSync(file, data);
    assert.throws(
      () => exportSkillZip(skills, saved.name),
      (error) => skillExportFailureReason(error) === SkillExportFailure.Credentials,
    );
    assert.deepEqual(fs.readFileSync(file), data);
    fs.unlinkSync(file);
    const archive = exportSkillZip(
      {
        exportSnapshot: () => ({
          ...sample,
          binaryFiles: { 'scripts/opaque.data': encoded(data) },
        }),
        fileName: (name) => skills.fileName(name),
      },
      saved.name,
    );
    await assert.rejects(
      importer.preview({ name: archive.name, data: archive.data }),
      (error) => errorCode(error) === 'invalid_skill',
    );
    assert.deepEqual(destination.list(), []);
  }
});

test('opaque assets share the named text limits and cannot collide by case or directory', async (t) => {
  const { skills, importer } = fixture(t),
    data = Buffer.from([255, 0, 128]),
    files = Object.fromEntries(
      Array.from({ length: SKILL_SUPPORT_FILE_LIMIT - 1 }, (_, index) => [
        'scripts/helper-' + index + '.py',
        '# helper\n',
      ]),
    ),
    binaryFiles = { 'scripts/opaque.data': encoded(data) },
    saved = skills.save({ ...sample, files, binaryFiles });
  assert.equal(
    Object.keys(saved.files).length + (saved.assets?.length ?? 0),
    SKILL_SUPPORT_FILE_LIMIT,
  );
  const archive = exportSkillZip(skills, saved.name),
    preview = await importer.preview({ name: archive.name, data: archive.data });
  assert.equal(preview.files.length, SKILL_SUPPORT_FILE_LIMIT + 1);
  assert.throws(
    () =>
      skills.save({ ...sample, files: { ...files, 'scripts/extra.py': '# extra' }, binaryFiles }),
    (error) => errorCode(error) === 'size_limit',
  );
  for (const collision of [
    { files: { 'scripts/OPAQUE.DATA': 'text' }, binaryFiles },
    { files: { 'scripts/opaque.data/child.py': '# child' }, binaryFiles },
    { files: {}, binaryFiles: { ...binaryFiles, 'scripts/OPAQUE.DATA': encoded(data) } },
  ])
    assert.throws(() => skills.save({ ...sample, ...collision }));
  assert.deepEqual(skills.get(saved.name), saved);
  const bounded = {
    'assets/one.txt': 'a'.repeat(SKILL_FILE_BYTES),
    'assets/two.txt': 'b'.repeat(SKILL_FILE_BYTES),
    'assets/three.txt': 'c'.repeat(SKILL_FILE_BYTES),
    'assets/four.txt': 'd'.repeat(SKILL_TOTAL_BYTES - 1 - 3 * SKILL_FILE_BYTES - data.length),
  };
  skills.save({ ...sample, instructions: 'i', files: bounded, binaryFiles });
  const maximum = skills.get(saved.name),
    roundtrip = exportSkillZip(skills, saved.name);
  await importer.preview({ name: roundtrip.name, data: roundtrip.data });
  assert.throws(
    () =>
      skills.save({
        ...sample,
        instructions: 'i',
        files: { ...bounded, 'assets/four.txt': bounded['assets/four.txt'] + 'x' },
        binaryFiles,
      }),
    (error) => errorCode(error) === 'size_limit',
  );
  assert.deepEqual(skills.get(saved.name), maximum);
});

test('a realistic 76-file near-megabyte skill including a 172024-byte binary exports and imports within the declared limits', async (t) => {
  const { skills, importer } = fixture(t),
    binaryFiles = Object.fromEntries(
      Array.from({ length: 76 }, (_, index) => [
        'assets/resource-' + index + '.arbitrary',
        encoded(Buffer.alloc(index === 0 ? 172024 : index === 75 ? 9462 : 10600, 255)),
      ]),
    );
  const saved = skills.save({ ...sample, files: {}, binaryFiles }),
    archive = exportSkillZip(skills, saved.name),
    preview = await importer.preview({ name: archive.name, data: archive.data }),
    restored = importer.commit({ id: preview.id });
  assert.equal(saved.assets?.length, 76);
  assert.deepEqual(restored.assets, saved.assets);
  assert.equal(
    preview.files.find((item) => item.path === 'assets/resource-0.arbitrary')?.size,
    172024,
  );
});

test('ordinary-file guards, strict instruction text and bounded diagnostic reasons remain enforced for all formats', (t) => {
  const { directory, skills } = fixture(t),
    saved = skills.save(sample),
    external = path.join(directory, 'outside.data'),
    target = path.join(path.dirname(saved.path), 'scripts/opaque.data'),
    data = Buffer.from([255, 0]);
  fs.writeFileSync(external, data);
  fs.linkSync(external, target);
  assert.throws(() => skills.get(saved.name));
  assert.deepEqual(fs.readFileSync(external), data);
  fs.unlinkSync(target);
  fs.symlinkSync(external, target);
  assert.throws(() => exportSkillZip(skills, saved.name));
  assert.deepEqual(fs.readFileSync(external), data);
  assert.throws(() => skillInstructionText(Buffer.from([255, 0])));
  assert.throws(() => skillInstructionText(Buffer.from('text\0binary')));
  assert.equal(skillInstructionText(Buffer.from('\uFEFFvalid instructions')), 'valid instructions');
  let evaluated = false;
  const hostile = Object.defineProperty({}, 'skillExportReason', {
    get() {
      evaluated = true;
      throw Error('private detail');
    },
  });
  Object.defineProperty(hostile, 'code', {
    get() {
      evaluated = true;
      throw Error('private detail');
    },
  });
  assert.equal(skillExportFailureReason(hostile), SkillExportFailure.Invalid);
  assert.equal(evaluated, false);
  assert.equal(
    skillExportFailureReason({ skillExportReason: '/private/path' }),
    SkillExportFailure.Invalid,
  );
  assert.equal(skillExportFailureReason({ code: 'size_limit' }), SkillExportFailure.Limit);
  assert.equal(
    skillExportFailureReason(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw Error('private detail');
          },
        },
      ),
    ),
    SkillExportFailure.Invalid,
  );
  assert.equal(skillExportFailureReason(null), SkillExportFailure.Invalid);
  assert.equal(
    skillExportFailureReason({ skillExportReason: SkillExportFailure.Encoding }),
    SkillExportFailure.Encoding,
  );
});
