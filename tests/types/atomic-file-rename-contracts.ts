import { renameSync } from 'node:fs';
import {
  renameAtomicFileSync,
  type AtomicFileRenameOptions,
} from '../../src/files/atomic-file-rename.mts';

const options: AtomicFileRenameOptions = {
  renameSync,
  platform: 'win32',
  pause: (_milliseconds) => {},
};
const rename: (source: string, destination: string, options?: AtomicFileRenameOptions) => void =
  renameAtomicFileSync;
// @ts-expect-error Platforms are explicit Node runtime platforms.
const invalidPlatform: AtomicFileRenameOptions = { platform: 'windows' };
// @ts-expect-error Rename input paths must be text.
renameAtomicFileSync(123, 'destination');
// @ts-expect-error Retry delay injection receives milliseconds, not a string.
const invalidPause: AtomicFileRenameOptions = { pause: (_milliseconds: string) => {} };
void [options, rename, invalidPlatform, invalidPause];
