import path from 'node:path';

const WINDOWS_SYSTEM_ROOT = 'C:\\Windows';
const WINDOWS_PROGRAM_FILES = 'C:\\Program Files';
const WINDOWS_PROGRAM_FILES_X86 = 'C:\\Program Files (x86)';

function windowsDirectory(value: string | undefined, fallback: string): string {
  const directory = value || fallback;
  if (/[\0\r\n]/.test(directory) || !path.win32.isAbsolute(directory))
    throw Error('Invalid host system directory.');
  return path.win32.normalize(directory);
}

/** Capture and validate host OS paths once; these are not deployment preferences. */
export function hostConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const systemRoot = windowsDirectory(env.SystemRoot, WINDOWS_SYSTEM_ROOT);
  const systemDirectory = path.win32.join(systemRoot, 'System32');
  const capturedEnvironment = { ...env };
  return Object.freeze({
    systemDirectory,
    powershell: path.win32.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    archive: path.win32.join(systemDirectory, 'tar.exe'),
    hypervService: path.win32.join(systemDirectory, 'vmms.exe'),
    hypervModule: path.win32.join(
      systemDirectory,
      'WindowsPowerShell',
      'v1.0',
      'Modules',
      'Hyper-V',
      'Hyper-V.psd1',
    ),
    vmwareDirectories: Object.freeze(
      [
        windowsDirectory(env['ProgramFiles(x86)'], WINDOWS_PROGRAM_FILES_X86),
        windowsDirectory(env.ProgramFiles, WINDOWS_PROGRAM_FILES),
      ].map((root) => path.win32.join(root, 'VMware', 'VMware Workstation')),
    ),
    expandWindowsDirectory(value: unknown): string | null {
      if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return null;
      const expanded = value.replace(
        /%([^%]+)%/g,
        (match: string, name: string) => capturedEnvironment[name] || match,
      );
      if (/[\0\r\n]/.test(expanded) || !path.win32.isAbsolute(expanded)) return null;
      return path.win32.normalize(expanded);
    },
  });
}
export type HostConfiguration = ReturnType<typeof hostConfiguration>;
