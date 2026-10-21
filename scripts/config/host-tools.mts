// Build and verification tools use this host's OS directories. Missing or
// malformed environment values must not select a guessed Windows drive.
import path from 'node:path';

const HOST_DIRECTORY_MAX_CHARACTERS = 4096;
type HostEnvironment = Readonly<Record<string, string | undefined>>;
type WindowsDirectory = 'SystemRoot' | 'ProgramFiles';

export interface HostTools {
  readonly openSshDirectory: string | null;
  readonly bash: string;
  readonly tar: string;
}

function windowsDirectory(environment: HostEnvironment, name: WindowsDirectory): string {
  const values = Object.entries(environment)
    .filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && value !== undefined)
    .map(([, value]) => value);
  const selected = values[0];
  if (
    !selected ||
    selected.length > HOST_DIRECTORY_MAX_CHARACTERS ||
    /[\u0000-\u001f\u007f]/.test(selected) ||
    values.some((value) => value !== selected) ||
    !path.win32.isAbsolute(selected) ||
    /^[\\/]$/.test(path.win32.parse(selected).root)
  ) {
    throw Error(`The Windows ${name} directory must be set to an absolute path.`);
  }
  return path.win32.normalize(selected);
}

export function resolveHostTools(
  platform: NodeJS.Platform = process.platform,
  environment: HostEnvironment = process.env,
): Readonly<HostTools> {
  if (platform !== 'win32') {
    return Object.freeze({ openSshDirectory: null, bash: 'bash', tar: 'tar' });
  }
  const systemRoot = windowsDirectory(environment, 'SystemRoot');
  const programFiles = windowsDirectory(environment, 'ProgramFiles');
  return Object.freeze({
    openSshDirectory: path.win32.join(systemRoot, 'System32', 'OpenSSH'),
    bash: path.win32.join(programFiles, 'Git', 'bin', 'bash.exe'),
    tar: path.win32.join(systemRoot, 'System32', 'tar.exe'),
  });
}
