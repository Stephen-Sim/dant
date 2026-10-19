import {
  SKILL_DESCRIPTION_BYTES,
  SKILL_INSTRUCTION_BYTES,
  SKILL_FILE_BYTES,
  SKILL_TOTAL_BYTES,
  SKILL_NAME_PATTERN,
} from './skill-limits.mts';
import { isRecord } from '../contracts/json.mts';
export interface SkillExportSource {
  exportSnapshot(name: string): unknown;
  fileName(relative: string): void;
  containsSecret?(value: string): boolean;
}
import { crc32 } from 'node:zlib';
import { SKILL_SUPPORT_FILE_LIMIT } from './skill-limits.mts';

// Stored ZIP entries keep these small text skills portable without another
// compressor dependency or executing any of the exported helpers.
export function exportSkillZip(skills: SkillExportSource, name: unknown) {
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name))
    throw Error('Invalid managed skill for export.');
  const value = skills.exportSnapshot(name);
  if (!isRecord(value)) throw Error('Invalid managed skill for export.');
  const skill = value,
    support = skill.files ?? {},
    validText = (value: unknown): value is string =>
      typeof value === 'string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
  if (
    skill.name !== name ||
    !validText(skill.description) ||
    !skill.description.trim() ||
    Buffer.byteLength(skill.description) > SKILL_DESCRIPTION_BYTES ||
    !validText(skill.instructions) ||
    !skill.instructions.trim() ||
    !isRecord(support)
  )
    throw Error('Invalid managed skill for export.');
  if (Object.keys(support).length > SKILL_SUPPORT_FILE_LIMIT)
    throw Object.assign(Error('The skill exceeds its export file count.'), { code: 'size_limit' });
  if (Buffer.byteLength(skill.instructions) > SKILL_INSTRUCTION_BYTES)
    throw Error('The skill exceeds its export limit.');
  let managedBytes = Buffer.byteLength(skill.instructions);
  const paths = new Set(['skill.md']);
  for (const [relative, text] of Object.entries(support)) {
    skills.fileName(relative);
    if (
      /[\x00-\x1f\x7f]/.test(relative) ||
      paths.has(relative.toLowerCase()) ||
      !validText(text) ||
      /^(?:%PDF-|PK\x03\x04|RIFF|OggS|GIF8[79]a)/.test(text)
    )
      throw Error('Invalid managed skill for export.');
    paths.add(relative.toLowerCase());
    managedBytes += Buffer.byteLength(text);
    if (Buffer.byteLength(text) > SKILL_FILE_BYTES || managedBytes > SKILL_TOTAL_BYTES)
      throw Error('The skill exceeds its export limit.');
  }
  for (const relative of paths) {
    const parts = relative.split('/');
    for (let count = 1; count < parts.length; count++)
      if (paths.has(parts.slice(0, count).join('/')))
        throw Error('Invalid managed skill for export.');
  }
  if (
    [
      name,
      skill.description,
      skill.instructions,
      ...Object.keys(support),
      ...Object.values(support).map((value) => {
        if (typeof value !== 'string') throw Error('Invalid managed skill for export.');
        return value;
      }),
    ].some((value) => skills.containsSecret?.(value))
  )
    throw Error('Keep credentials out of exported skills.');
  const files: Record<string, string> = {
    'SKILL.md':
      '---\nname: ' +
      JSON.stringify(skill.name) +
      '\ndescription: ' +
      JSON.stringify(skill.description) +
      '\n---\n\n' +
      skill.instructions +
      '\n',
    ...Object.fromEntries(
      Object.entries(support).map(([name, value]) => {
        if (typeof value !== 'string') throw Error('Invalid managed skill for export.');
        return [name, value];
      }),
    ),
  };
  let offset = 0;
  const local: Buffer[] = [],
    central: Buffer[] = [];
  for (const [relative, text] of Object.entries(files)) {
    const data = Buffer.from(text),
      file = Buffer.from(skill.name + '/' + relative),
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
    count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return { name: skill.name + '.zip', data: Buffer.concat([...local, directory, end]) };
}
