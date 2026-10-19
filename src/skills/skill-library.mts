import {
  SKILL_DESCRIPTION_BYTES,
  SKILL_INSTRUCTION_BYTES,
  SKILL_FILE_BYTES,
  SKILL_TOTAL_BYTES,
  SKILL_MAX_DEPTH,
  SKILL_RELATIVE_PATH_CHARACTERS,
  SKILL_NAME_PATTERN,
} from './skill-limits.mts';
import type {
  LocatedSkill,
  SkillBinaryFile,
  SkillSnapshot,
  SkillSummary,
  SkillView,
} from './skill-types.ts';
import {
  skillFileFromBytes,
  skillFileFromValue,
  skillInstructionText,
  skillFileFailure,
  SkillExportFailure,
} from './skill-files.mts';
import { isRecord } from '../contracts/json.mts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ordinaryDirectory, renameManaged } from '../files/managed-path.mts';
import { SKILL_SUPPORT_FILE_LIMIT, SKILL_TREE_ENTRY_LIMIT } from './skill-limits.mts';

const slug = (name: unknown): name is string =>
  typeof name === 'string' && SKILL_NAME_PATTERN.test(name);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
const marker = '.dant-managed.json';
const markerByteLimit = 8192 + SKILL_SUPPORT_FILE_LIMIT * 1100;
const generatedCaches = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'node_modules',
]);
const exportFailure = () => Error('Invalid managed skill files for export.');
const countFailure = () =>
  Object.assign(Error('The skill exceeds its supported file count.'), { code: 'size_limit' });
function instructionBody(source: string) {
  const boundary = source.indexOf('\n---\n', 4);
  if (!source.startsWith('---\n') || boundary < 0)
    throw Error('Invalid managed skill frontmatter.');
  return source.slice(boundary + 5).trim();
}
function snapshotBytes(library: SkillLibrary, directory: string, relative: string) {
  const file = library.inside(path.join(directory, relative));
  library.ordinary(path.dirname(file));
  const before = fs.lstatSync(file);
  if (before.size > SKILL_FILE_BYTES) throw skillFileFailure(SkillExportFailure.Limit);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw exportFailure();
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.size > SKILL_FILE_BYTES) throw skillFileFailure(SkillExportFailure.Limit);
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw exportFailure();
    const buffer = Buffer.alloc(SKILL_FILE_BYTES + 1);
    let length = 0,
      read;
    while (
      length < buffer.length &&
      (read = fs.readSync(descriptor, buffer, length, buffer.length - length, length))
    )
      length += read;
    const after = fs.fstatSync(descriptor),
      current = fs.lstatSync(file);
    library.ordinary(path.dirname(file));
    if (length > SKILL_FILE_BYTES) throw skillFileFailure(SkillExportFailure.Limit);
    if (
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      current.isSymbolicLink() ||
      current.nlink > 1 ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw exportFailure();
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Only dant-owned folders are editable. Enabled skills use Codex's workspace discovery path. */
export class SkillLibrary {
  readonly workspace: string;
  readonly enabledRoot: string;
  readonly disabledRoot: string;
  readonly containsSecret: (value: string) => boolean;
  constructor({
    workspace,
    containsSecret = () => false,
  }: {
    workspace: string;
    containsSecret?: (value: string) => boolean;
  }) {
    this.workspace = path.resolve(workspace);
    this.enabledRoot = path.join(this.workspace, '.agents', 'skills');
    this.disabledRoot = path.join(this.workspace, '.dant-disabled-skills');
    this.containsSecret = containsSecret;
  }
  inside(target: string) {
    const full = path.resolve(target),
      relative = path.relative(this.workspace, full);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('Invalid managed skill path.');
    return full;
  }
  ordinary(directory: string, { create = false }: { create?: boolean } = {}) {
    this.inside(directory);
    ordinaryDirectory(directory, { create });
  }
  locate(name: unknown): LocatedSkill | null {
    if (!slug(name)) throw Error('Invalid skill name.');
    for (const [root, enabled] of [
      [this.enabledRoot, true],
      [this.disabledRoot, false],
    ] as const) {
      const directory = this.inside(path.join(root, name));
      if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
        this.ordinary(directory);
        const file = path.join(directory, marker),
          stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > markerByteLimit)
          throw Error('This skill is not managed by dant.');
        const meta: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (
          !isRecord(meta) ||
          meta.owner !== 'dant' ||
          meta.name !== name ||
          typeof meta.description !== 'string' ||
          typeof meta.updatedAt !== 'number'
        )
          throw Error('This skill is not managed by dant.');
        return {
          directory,
          enabled,
          meta: { owner: 'dant', name, description: meta.description, updatedAt: meta.updatedAt },
        };
      }
    }
    return null;
  }
  list() {
    const items: SkillSummary[] = [];
    for (const root of [this.enabledRoot, this.disabledRoot]) {
      if (!fs.existsSync(root)) continue;
      this.ordinary(root);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !slug(entry.name)) continue;
        try {
          const found = this.locate(entry.name);
          if (!found || items.some((item) => item.name === entry.name)) continue;
          items.push({
            name: entry.name,
            description: found.meta.description,
            enabled: found.enabled,
            path: path.join(found.directory, 'SKILL.md'),
            updatedAt: found.meta.updatedAt,
          });
        } catch {
          /* User/system skill folders are not managed here. */
        }
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }
  get(name: unknown): SkillView {
    const { binaryFiles, ...snapshot } = this.exportSnapshot(name),
      assets = Object.entries(binaryFiles ?? {}).map(([relative, value]) => ({
        path: relative,
        mediaType: value.mediaType,
        size: Buffer.from(value.data, 'base64').length,
      }));
    return { ...snapshot, files: { ...snapshot.files }, ...(assets.length ? { assets } : {}) };
  }
  exportSnapshot(name: unknown): SkillSnapshot {
    const found = this.locate(name);
    if (!found) throw Error('Skill not found.');
    const { directory, enabled, meta } = found,
      files: Record<string, string> = Object.create(null),
      binaryFiles: Record<string, SkillBinaryFile> = Object.create(null),
      instructions = instructionBody(
        skillInstructionText(snapshotBytes(this, directory, 'SKILL.md')),
      );
    let entries = 0,
      supportCount = 0,
      total = Buffer.byteLength(instructions);
    if (!instructions) throw exportFailure();
    if (total > SKILL_INSTRUCTION_BYTES) throw skillFileFailure(SkillExportFailure.Limit);
    const walk = (folder: string, prefix = '', depth = 0) => {
      this.ordinary(folder);
      if (depth > SKILL_MAX_DEPTH) throw exportFailure();
      for (const entry of fs
        .readdirSync(folder, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (++entries > SKILL_TREE_ENTRY_LIMIT) throw countFailure();
        const relative = prefix + entry.name,
          full = this.inside(path.join(folder, entry.name)),
          stat = fs.lstatSync(full);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw exportFailure();
        if (!prefix && (entry.name === marker || entry.name === 'SKILL.md')) {
          if (!stat.isFile()) throw exportFailure();
          continue;
        }
        if (/[\x00-\x1f\x7f]/.test(relative)) throw exportFailure();
        if (stat.isDirectory()) {
          if (generatedCaches.has(entry.name)) continue;
          this.fileName(relative + '/x');
          walk(full, relative + '/', depth + 1);
        } else {
          this.fileName(relative);
          if (++supportCount > SKILL_SUPPORT_FILE_LIMIT) throw countFailure();
          const value = skillFileFromBytes(relative, snapshotBytes(this, directory, relative));
          total += value.data.length;
          if (total > SKILL_TOTAL_BYTES) throw skillFileFailure(SkillExportFailure.Limit);
          if (value.secretTexts.some((value) => this.containsSecret(value)))
            throw skillFileFailure(SkillExportFailure.Credentials);
          if (typeof value.value === 'string') files[relative] = value.value;
          else binaryFiles[relative] = value.value;
        }
      }
    };
    walk(directory);
    return {
      name: meta.name,
      description: meta.description,
      instructions,
      files,
      ...(Object.keys(binaryFiles).length ? { binaryFiles } : {}),
      enabled,
      path: path.join(directory, 'SKILL.md'),
      updatedAt: meta.updatedAt,
    };
  }
  fileName(relative: unknown): asserts relative is string {
    if (
      typeof relative !== 'string' ||
      relative.length > SKILL_RELATIVE_PATH_CHARACTERS ||
      relative.includes('\\') ||
      relative.includes('\0') ||
      !/^(?:(scripts|references|assets)\/|README\.md$|(?:LICENSE|NOTICE)(?:\.txt|\.md)?$)/.test(
        relative,
      ) ||
      relative
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.includes(':'))
    )
      throw Error('Invalid supporting skill file path.');
  }
  save(input: unknown, { overwrite = true }: { overwrite?: boolean } = {}) {
    if (
      !isRecord(input) ||
      !slug(input.name) ||
      !text(input.description, SKILL_DESCRIPTION_BYTES) ||
      !input.description.trim() ||
      !text(input.instructions, SKILL_INSTRUCTION_BYTES) ||
      !input.instructions.trim() ||
      (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
      (input.preserveBinaryFiles !== undefined && typeof input.preserveBinaryFiles !== 'boolean')
    )
      throw Error('Invalid skill name, description, or instructions.');
    const existing = this.locate(input.name);
    if (existing && !overwrite)
      throw Object.assign(Error('A skill with this name already exists.'), { code: 'EEXIST' });
    if (input.preserveBinaryFiles && (!existing || input.binaryFiles !== undefined))
      throw Error('Invalid supporting skill preservation request.');
    // Omitted files preserve all content. Editors explicitly retain read-only binary assets.
    // A complete replacement without that flag keeps the legacy replacement contract.
    const snapshot =
      existing && (input.files === undefined || input.preserveBinaryFiles)
        ? this.exportSnapshot(input.name)
        : null;
    const files = input.files === undefined ? (snapshot?.files ?? {}) : input.files,
      binaryFiles =
        input.binaryFiles === undefined ? (snapshot?.binaryFiles ?? {}) : input.binaryFiles;
    if (!isRecord(files) || !isRecord(binaryFiles)) throw Error('Invalid supporting skill files.');
    const entries = [...Object.entries(files), ...Object.entries(binaryFiles)];
    if (entries.length > SKILL_SUPPORT_FILE_LIMIT) throw countFailure();
    const output = new Map<string, Buffer>(),
      paths = new Set(['skill.md']),
      secrets: string[] = [];
    let bytes = Buffer.byteLength(input.instructions);
    for (const [relative, value] of entries) {
      this.fileName(relative);
      if (
        (Object.hasOwn(files, relative) && typeof value !== 'string') ||
        (Object.hasOwn(binaryFiles, relative) && typeof value === 'string') ||
        paths.has(relative.toLowerCase())
      )
        throw Error('Invalid supporting skill file.');
      paths.add(relative.toLowerCase());
      const file = skillFileFromValue(relative, value);
      bytes += file.data.length;
      if (bytes > SKILL_TOTAL_BYTES) throw skillFileFailure(SkillExportFailure.Limit);
      secrets.push(...file.secretTexts);
      output.set(relative, file.data);
    }
    for (const relative of paths) {
      const parts = relative.split('/');
      for (let count = 1; count < parts.length; count++)
        if (paths.has(parts.slice(0, count).join('/')))
          throw Error('Conflicting supporting skill paths.');
    }
    if (
      [input.name, input.description, input.instructions, ...output.keys(), ...secrets].some(
        (value) => this.containsSecret(value),
      )
    )
      throw Error('Keep credentials in the credential vault, not in skills.');
    const enabled = input.enabled ?? existing?.enabled ?? true,
      root = enabled ? this.enabledRoot : this.disabledRoot;
    this.ordinary(root, { create: true });
    const destination = this.inside(path.join(root, input.name));
    if (existing && existing.directory !== destination && fs.existsSync(destination))
      throw Error('The skill destination already exists.');
    const temporary = this.inside(path.join(root, '.staging-' + randomUUID())),
      backup = this.inside(path.join(root, '.backup-' + randomUUID()));
    fs.mkdirSync(temporary, { mode: 0o700 });
    let moved = false;
    try {
      fs.writeFileSync(
        path.join(temporary, 'SKILL.md'),
        '---\nname: ' +
          JSON.stringify(input.name) +
          '\ndescription: ' +
          JSON.stringify(input.description.trim()) +
          '\n---\n\n' +
          input.instructions.trim() +
          '\n',
        { mode: 0o600 },
      );
      for (const [relative, value] of output) {
        const file = this.inside(path.join(temporary, relative));
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
      }
      fs.writeFileSync(
        path.join(temporary, marker),
        JSON.stringify({
          owner: 'dant',
          name: input.name,
          description: input.description.trim(),
          files: [...output.keys()],
          updatedAt: Date.now(),
        }),
        { mode: 0o600 },
      );
      if (existing) {
        this.inside(existing.directory);
        renameManaged(existing.directory, backup);
        moved = true;
      }
      try {
        renameManaged(temporary, destination);
      } catch (error) {
        if (moved && existing) renameManaged(backup, existing.directory);
        moved = false;
        throw error;
      }
      if (moved)
        fs.rmSync(this.inside(backup), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 20,
        });
      return this.get(input.name);
    } finally {
      if (fs.existsSync(temporary))
        fs.rmSync(this.inside(temporary), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 20,
        });
    }
  }
  setEnabled(name: string, enabled: unknown) {
    if (typeof enabled !== 'boolean') throw Error('Invalid skill enable preference.');
    const existing = this.get(name);
    if (existing.enabled === enabled) return existing;
    const directory = path.dirname(existing.path),
      root = enabled ? this.enabledRoot : this.disabledRoot;
    this.ordinary(root, { create: true });
    const destination = this.inside(path.join(root, name));
    if (fs.existsSync(destination)) throw Error('The skill destination already exists.');
    renameManaged(directory, destination);
    return { ...existing, enabled, path: path.join(destination, 'SKILL.md') };
  }
  remove(name: unknown) {
    const found = this.locate(name);
    if (!found) throw Error('Skill not found.');
    fs.rmSync(this.inside(found.directory), { recursive: true, maxRetries: 5, retryDelay: 20 });
    return { removed: true, name };
  }
  context() {
    return (
      'Available dant-managed VM skills (reference index; read SKILL.md when relevant):\n' +
      JSON.stringify(
        this.list()
          .filter((item) => item.enabled)
          .map(({ name, description, path }) => ({ name, description, path })),
      )
    );
  }
}
