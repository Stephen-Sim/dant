import { crc32, deflateSync } from 'node:zlib';

export interface SkillPngFixtureOptions {
  width?: number;
  height?: number;
  color?: number;
  depth?: number;
  interlaced?: boolean;
  pixels?: Buffer;
  compressed?: Buffer;
  chunks?: readonly { type: string; data: Buffer }[];
}
export function skillPngChunk(type: string, data: Buffer) {
  const header = Buffer.alloc(8),
    checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  header.write(type, 4, 'latin1');
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, checksum]);
}
/** Small inert PNG fixtures, with explicit overrides for malformed-image tests. */
export function skillPngFixture({
  width = 2,
  height = 2,
  color = 6,
  depth = 8,
  interlaced = false,
  pixels,
  compressed,
  chunks = [],
}: SkillPngFixtureOptions = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = color;
  header[12] = interlaced ? 1 : 0;
  let image = pixels;
  if (!image && !compressed) {
    const channels: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 },
      passes = interlaced
        ? ([
            [0, 0, 8, 8],
            [4, 0, 8, 8],
            [0, 4, 4, 8],
            [2, 0, 4, 4],
            [0, 2, 2, 4],
            [1, 0, 2, 2],
            [0, 1, 1, 2],
          ] as const)
        : ([[0, 0, 1, 1]] as const),
      rows: Buffer[] = [];
    for (const [x, y, dx, dy] of passes) {
      const columns = Math.max(0, Math.ceil((width - x) / dx)),
        count = Math.max(0, Math.ceil((height - y) / dy)),
        bytes = Math.ceil((columns * (channels[color] ?? 1) * depth) / 8);
      if (!columns || !count) continue;
      if ((bytes + 1) * count > 20 * 1024 * 1024) throw Error('Oversized PNG fixture.');
      for (let row = 0; row < count; row++) {
        const data = Buffer.alloc(bytes + 1, (row + 127) % 256);
        data[0] = 0;
        rows.push(data);
      }
    }
    image = Buffer.concat(rows);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    skillPngChunk('IHDR', header),
    ...chunks.map(({ type, data }) => skillPngChunk(type, data)),
    skillPngChunk('IDAT', compressed ?? deflateSync(image ?? Buffer.alloc(0))),
    skillPngChunk('IEND', Buffer.alloc(0)),
  ]);
}
