import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const win = path.win32;
const registryKeys = [
  'HKLM\\SOFTWARE\\VMware, Inc.\\VMware Workstation',
  'HKLM\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Workstation',
  'HKCU\\SOFTWARE\\VMware, Inc.\\VMware Workstation',
];
const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
function installedDirectory(key) {
  try {
    const text = execFileSync('reg.exe', ['query', key, '/v', 'InstallPath'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /\bInstallPath\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i.exec(text)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** Read-only discovery. No hypervisor executable is launched or installed. */
export function detectHypervisors({
  platform = process.platform,
  env = process.env,
  fileExists = isFile,
  readRegistry = installedDirectory,
} = {}) {
  const providers = [
    { id: 'hyperv', label: 'Hyper-V', available: false, reason: null },
    { id: 'vmware', label: 'VMware Workstation', available: false, reason: null },
  ];
  if (platform !== 'win32') {
    for (const provider of providers) provider.reason = 'Automatic VM setup requires Windows.';
    return providers;
  }
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  providers[0].available =
    fileExists(win.join(systemRoot, 'System32', 'vmms.exe')) &&
    fileExists(
      win.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'Modules',
        'Hyper-V',
        'Hyper-V.psd1',
      ),
    );
  if (!providers[0].available)
    providers[0].reason =
      'Hyper-V and its management tools are not installed. Enable Hyper-V or choose VMware Workstation.';
  const candidates = [
    env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    env.ProgramFiles || 'C:\\Program Files',
  ].map((root) => win.join(root, 'VMware', 'VMware Workstation'));
  const inspect = (directory) => {
    if (typeof directory !== 'string' || /[\0\r\n]/.test(directory)) return null;
    const expanded = directory.replace(/%([^%]+)%/g, (match, name) => env[name] || match);
    if (!win.isAbsolute(expanded)) return null;
    const vmrun = win.join(expanded, 'vmrun.exe'),
      vdiskmanager = win.join(expanded, 'vmware-vdiskmanager.exe');
    return {
      directory: win.normalize(expanded),
      vmrun: fileExists(vmrun) ? vmrun : null,
      vdiskmanager: fileExists(vdiskmanager) ? vdiskmanager : null,
    };
  };
  let partial = null;
  for (const directory of candidates) {
    const tools = inspect(directory);
    if (tools?.vmrun && tools.vdiskmanager) {
      providers[1].available = true;
      providers[1].tools = tools;
      break;
    }
    if (tools?.vmrun || tools?.vdiskmanager) partial = tools;
  }
  if (!providers[1].available)
    for (const key of registryKeys) {
      const tools = inspect(readRegistry(key));
      if (tools?.vmrun && tools.vdiskmanager) {
        providers[1].available = true;
        providers[1].tools = tools;
        break;
      }
      if (tools?.vmrun || tools?.vdiskmanager) partial = tools;
    }
  if (!providers[1].available) {
    providers[1].reason = partial
      ? 'The VMware Workstation installation is incomplete: vmrun and vmware-vdiskmanager are both required.'
      : 'VMware Workstation was not found. Install it yourself, then refresh detection.';
    if (partial) providers[1].tools = partial;
  }
  return providers;
}

/** An existing or previously selected provider is never silently replaced. */
export function selectHypervisor({
  requested = 'auto',
  preferred = null,
  availableProviders = [],
} = {}) {
  if (!['auto', 'hyperv', 'vmware'].includes(requested))
    throw Error('Invalid VM provider: choose auto, hyperv or vmware.');
  const provider =
    requested === 'auto'
      ? preferred || availableProviders.find((item) => item.available)?.id
      : requested;
  if (!provider)
    throw Error(
      'No supported hypervisor is available. Enable Hyper-V or install VMware Workstation, then refresh detection.',
    );
  const detected = availableProviders.find((item) => item.id === provider);
  if (!detected?.available)
    throw Error(
      detected?.reason ||
        `The selected VM provider ${provider} is unavailable; it was not replaced.`,
    );
  return provider;
}
