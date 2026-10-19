import fs from 'node:fs';
import path from 'node:path';
import { AttachmentStore } from '../src/files/attachments.mts';
import type { Attachment } from '../src/files/attachment-types.ts';
import { isRecord } from '../src/contracts/json.mts';

const sourceArgument = process.argv[2],
  targetArgument = process.argv[3];
if (!sourceArgument || !targetArgument)
  throw Error('Migration requires source and target directories.');
const source = path.resolve(sourceArgument),
  target = path.resolve(targetArgument);
const manifestFile = path.join(source, 'manifest.json');
if (!fs.existsSync(manifestFile)) process.exit(0);
const manifest: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (!isRecord(manifest)) throw Error('Invalid migration manifest.');
const receipt = path.join(target, 'migration-imported.json');
if (fs.existsSync(receipt)) {
  const savedReceipt: unknown = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (!isRecord(savedReceipt) || savedReceipt.id !== manifest.id)
    throw Error('A different import already exists; VM work was preserved.');
  process.exit(0);
}
if (fs.existsSync(path.join(target, 'state.json')))
  throw Error('The VM already has authoritative data; import refused and work preserved.');
const state: unknown = JSON.parse(fs.readFileSync(path.join(source, 'state.json'), 'utf8'));
if (!isRecord(state) || (state.messages !== undefined && !Array.isArray(state.messages)))
  throw Error('Invalid legacy conversation state.');
const attachments = new AttachmentStore(path.join(target, 'attachments')),
  mapped = new Map<unknown, Attachment>(),
  warnings: string[] = [];
const messages: unknown[] = state.messages || [];
for (const message of messages) {
  if (
    !isRecord(message) ||
    (message.attachments !== undefined && !Array.isArray(message.attachments))
  )
    throw Error('Invalid legacy conversation message.');
  const files: unknown[] = message.attachments || [];
  for (let index = 0; index < files.length; index++) {
    const original = files[index];
    if (!isRecord(original)) throw Error('Invalid legacy attachment.');
    if (mapped.has(original.id)) {
      files[index] = mapped.get(original.id);
      continue;
    }
    if (typeof original.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(original.id))
      throw Error('Invalid legacy attachment identifier.');
    const file = path.join(source, 'files', original.id),
      info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      warnings.push(`Attachment missing: ${original.id}`);
      original.unavailable = true;
      continue;
    }
    const item = attachments.put({ name: original.name, data: fs.readFileSync(file) });
    mapped.set(original.id, item);
    files[index] = item;
  }
}
state.settings ??= {};
if (!isRecord(state.settings)) throw Error('Invalid legacy settings.');
state.settings.vm = { host: '', user: 'dant', port: 22, keyPath: '', knownHosts: '' };
state.migration = { ...manifest, warnings, importedAt: new Date().toISOString() };
// Commit state only after every available file has been safely imported.
fs.writeFileSync(path.join(target, 'state.json'), JSON.stringify(state, null, 2), {
  flag: 'wx',
  mode: 0o600,
});
fs.writeFileSync(receipt, JSON.stringify({ ...manifest, warnings }), { flag: 'wx', mode: 0o600 });
