import { isRecord } from '../contracts/json.mts';
import { SKILL_FILE_BYTES } from './skill-limits.mts';
import type { SkillBinaryFile } from './skill-types.ts';

export const SkillExportFailure = Object.freeze({
  Invalid: 'invalid_skill',
  Encoding: 'invalid_encoding',
  Limit: 'size_limit',
  Credentials: 'credentials',
});
export type SkillExportFailureValue = (typeof SkillExportFailure)[keyof typeof SkillExportFailure];
const failureReasons = new Set<string>(Object.values(SkillExportFailure));
export function skillExportFailureReason(error: unknown): SkillExportFailureValue {
  try {
    if (isRecord(error)) {
      const reason = Object.getOwnPropertyDescriptor(error, 'skillExportReason'),
        code = Object.getOwnPropertyDescriptor(error, 'code');
      if (
        reason &&
        'value' in reason &&
        typeof reason.value === 'string' &&
        failureReasons.has(reason.value)
      )
        return reason.value as SkillExportFailureValue;
      if (code && 'value' in code && code.value === 'size_limit') return SkillExportFailure.Limit;
    }
  } catch {
    /* Untrusted errors cannot add operational metadata. */
  }
  return SkillExportFailure.Invalid;
}
export function skillFileFailure(reason: SkillExportFailureValue) {
  return Object.assign(Error('Invalid managed skill file encoding or size.'), {
    code: reason === SkillExportFailure.Limit ? 'size_limit' : 'unsupported_file',
    status: 400,
    skillExportReason: reason,
  });
}
export interface DecodedSkillFile {
  data: Buffer;
  value: string | SkillBinaryFile;
  secretTexts: string[];
}
export function skillInstructionText(data: Buffer) {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
      throw skillFileFailure(SkillExportFailure.Encoding);
    return value;
  } catch {
    throw skillFileFailure(SkillExportFailure.Encoding);
  }
}
/** File formats stay opaque: management never executes, parses or opens their contents. */
export function skillFileFromBytes(_relative: string, data: Buffer): DecodedSkillFile {
  if (data.length > SKILL_FILE_BYTES) throw skillFileFailure(SkillExportFailure.Limit);
  const secretTexts = [new TextDecoder('utf-8', { ignoreBOM: true }).decode(data)];
  // BOM-marked UTF-16 source is also scanned in its own encoding, without changing its bytes.
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))
    secretTexts.push(new TextDecoder(data[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(data));
  let text: string | undefined;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    if (
      !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded) &&
      !/^(?:%PDF-|MZ|PK\x03\x04|RIFF|OggS|GIF8[79]a)/.test(decoded) &&
      Buffer.from(decoded).equals(data)
    )
      text = decoded;
  } catch {
    /* Non-text bytes remain inert, portable binary assets. */
  }
  return {
    data,
    secretTexts,
    value: text ?? {
      encoding: 'base64',
      mediaType: 'application/octet-stream',
      data: data.toString('base64'),
    },
  };
}
export function skillFileFromValue(relative: string, value: unknown): DecodedSkillFile {
  if (typeof value === 'string') return skillFileFromBytes(relative, Buffer.from(value));
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'encoding') ||
    !Object.hasOwn(value, 'mediaType') ||
    !Object.hasOwn(value, 'data') ||
    value.encoding !== 'base64' ||
    value.mediaType !== 'application/octet-stream' ||
    typeof value.data !== 'string' ||
    value.data.length > 4 * Math.ceil(SKILL_FILE_BYTES / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
  )
    throw skillFileFailure(SkillExportFailure.Encoding);
  const data = Buffer.from(value.data, 'base64');
  if (data.toString('base64') !== value.data) throw skillFileFailure(SkillExportFailure.Encoding);
  return skillFileFromBytes(relative, data);
}
