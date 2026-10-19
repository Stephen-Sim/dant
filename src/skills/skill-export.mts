import {
  SKILL_DESCRIPTION_BYTES,
  SKILL_INSTRUCTION_BYTES,
  SKILL_TOTAL_BYTES,
  SKILL_NAME_PATTERN,
} from './skill-limits.mts';
import { isRecord } from '../contracts/json.mts';
import { skillFileFromValue, skillFileFailure, SkillExportFailure } from './skill-files.mts';
export interface SkillExportSource {
  exportSnapshot(name: string): unknown;
  fileName(relative: string): void;
  containsSecret?(value: string): boolean;
}
import { crc32 } from 'node:zlib';
import { SKILL_SUPPORT_FILE_LIMIT } from './skill-limits.mts';

// Stored ZIP entries preserve bounded files in every format without another
// compressor dependency or executing any of the exported helpers.
export function exportSkillZip(skills: SkillExportSource, name: unknown) {
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name))
    throw Error('Invalid managed skill for export.');
  const value = skills.exportSnapshot(name);
  if (!isRecord(value)) throw Error('Invalid managed skill for export.');
  const skill = value,
    support = skill.files ?? {},
    binary = skill.binaryFiles ?? {},
    validText = (value: unknown): value is string =>
      typeof value === 'string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
  if (
    skill.name !== name ||
    !validText(skill.description) ||
    !skill.description.trim() ||
    Buffer.byteLength(skill.description) > SKILL_DESCRIPTION_BYTES ||
    !validText(skill.instructions) ||
    !skill.instructions.trim() ||
    !isRecord(support) ||
    !isRecord(binary)
  )
    throw Error('Invalid managed skill for export.');
  const supportEntries = [...Object.entries(support), ...Object.entries(binary)];
  if (supportEntries.length > SKILL_SUPPORT_FILE_LIMIT)
    throw Object.assign(Error('The skill exceeds its export file count.'), { code: 'size_limit' });
  if (Buffer.byteLength(skill.instructions) > SKILL_INSTRUCTION_BYTES)
    throw skillFileFailure(SkillExportFailure.Limit);
  let managedBytes = Buffer.byteLength(skill.instructions);
  const paths = new Set(['skill.md']);
  const output = new Map<string, Buffer>(),
    secretTexts: string[] = [];
  for (const [relative, value] of supportEntries) {
    skills.fileName(relative);
    if (
      /[\x00-\x1f\x7f]/.test(relative) ||
      paths.has(relative.toLowerCase()) ||
      (Object.hasOwn(support, relative) && typeof value !== 'string') ||
      (Object.hasOwn(binary, relative) && typeof value === 'string')
    )
      throw Error('Invalid managed skill for export.');
    paths.add(relative.toLowerCase());
    const file = skillFileFromValue(relative, value);
    output.set(relative, file.data);
    secretTexts.push(...file.secretTexts);
    managedBytes += file.data.length;
    if (managedBytes > SKILL_TOTAL_BYTES) throw skillFileFailure(SkillExportFailure.Limit);
  }
  for (const relative of paths) {
    const parts = relative.split('/');
    for (let count = 1; count < parts.length; count++)
      if (paths.has(parts.slice(0, count).join('/')))
        throw Error('Invalid managed skill for export.');
  }
  if (
    [name, skill.description, skill.instructions, ...output.keys(), ...secretTexts].some((value) =>
      skills.containsSecret?.(value),
    )
  )
    throw skillFileFailure(SkillExportFailure.Credentials);
  const files = new Map<string, Buffer>([
    [
      'SKILL.md',
      Buffer.from(
        '---\nname: ' +
          JSON.stringify(skill.name) +
          '\ndescription: ' +
          JSON.stringify(skill.description) +
          '\n---\n\n' +
          skill.instructions +
          '\n',
      ),
    ],
    ...output,
  ]);
  let offset = 0;
  const local: Buffer[] = [],
    central: Buffer[] = [];
  for (const [relative, data] of files) {
    const file = Buffer.from(skill.name + '/' + relative),
      checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(file.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(file.length, 28);
    entry.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    local.push(header, file, data);
    central.push(entry, file);
    offset += header.length + file.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22),
    count = files.size;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return { name: skill.name + '.zip', data: Buffer.concat([...local, directory, end]) };
}
