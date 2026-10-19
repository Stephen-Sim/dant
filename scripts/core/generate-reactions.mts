import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = path.join(root, 'core/internal/history/assets');
const maxDataBytes = 2 * 1024 * 1024;
const sources = [
  {
    url: 'https://www.unicode.org/Public/17.0.0/emoji/emoji-sequences.txt',
    sha256: '12cc8267dc33cbd11ed32bcf6fc5dc2ad9c7a77bae1bdfba2f41b1b9b3ead8dd',
  },
  {
    url: 'https://www.unicode.org/Public/17.0.0/emoji/emoji-zwj-sequences.txt',
    sha256: '5b25441daed2322b068c5e70cda522946a4f0274df864445a1965a92e5fc5cad',
  },
] as const;
const emoji = new RegExp('^(?:\\p{RGI_Emoji})(?![\\s\\S])', 'v');
const component = new RegExp('^\\p{Emoji_Component}$', 'u');
const compatible = new Set(['👍', '❤️', '😆', '😮', '😢', '😡', '😂', '👀', '🎉']);
const valid = (value: string) =>
  value.length > 0 &&
  value.length <= 64 &&
  !/[\s\p{Cc}]/u.test(value) &&
  !component.test(value) &&
  (compatible.has(value) || emoji.test(value));

export function reactionSequences(text: string): string[] {
  const result = new Set<string>();
  for (const line of text.split('\n')) {
    const field = line.split('#')[0]?.split(';')[0]?.trim();
    if (!field) continue;
    const range = /^([A-F0-9]+)\.\.([A-F0-9]+)$/.exec(field);
    if (range?.[1] && range[2]) {
      const first = Number.parseInt(range[1], 16);
      const last = Number.parseInt(range[2], 16);
      if (last < first || last > 0x10ffff) throw Error('Invalid Unicode reaction range.');
      for (let value = first; value <= last; value++) result.add(String.fromCodePoint(value));
    } else {
      const points = field.split(/\s+/);
      if (!points.every((point) => /^[A-F0-9]{1,6}$/.test(point)))
        throw Error('Invalid Unicode reaction sequence.');
      const codes = points.map((point) => Number.parseInt(point, 16));
      if (codes.some((point) => point > 0x10ffff)) throw Error('Invalid Unicode reaction code.');
      result.add(String.fromCodePoint(...codes));
    }
  }
  return [...result];
}

export function checkReactions(): void {
  const values = fs
    .readFileSync(path.join(directory, 'reactions.txt'), 'utf8')
    .trimEnd()
    .split('\n');
  if (values.length !== 3944 || new Set(values).size !== values.length || !values.every(valid))
    throw Error('The pinned Go reaction vocabulary differs from the Node contract.');
}

async function regenerate(): Promise<void> {
  const values = new Set<string>();
  for (const source of sources) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Error('Unicode reaction data unavailable.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.length > maxDataBytes ||
      createHash('sha256').update(bytes).digest('hex') !== source.sha256
    )
      throw Error('Unicode reaction data did not match its pinned digest.');
    for (const value of reactionSequences(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      if (valid(value)) values.add(value);
  }
  if (values.size !== 3944) throw Error('The Node reaction vocabulary requires a reviewed update.');
  fs.writeFileSync(path.join(directory, 'reactions.txt'), [...values].sort().join('\n') + '\n');
  checkReactions();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--fetch') await regenerate();
  else if (process.argv.length === 2) checkReactions();
  else throw Error('Use generate-reactions.mts [--fetch].');
}
