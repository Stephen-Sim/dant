import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProvisioningStatus, VmProviderId } from '../../contracts/states.mts';
import type { HostPlatform } from '../../platform/host-types.ts';
import type { Hypervisor, HypervisorTools, ManagedVmProvider } from '../computer-types.ts';
import type {
  ManagedVmAdapter,
  VmProviderRegistry,
  VmSetupInput,
  VmSetupPlan,
  VmLifecycleCommandInput,
} from './provider-types.ts';

const REGISTRY_TIMEOUT_MS = 3000;
const WINDOWS_REQUIRED = 'Automatic VM setup requires Windows.';
const REGISTRY_KEYS = Object.freeze([
  'HKLM\\SOFTWARE\\VMware, Inc.\\VMware Workstation',
  'HKLM\\SOFTWARE\\WOW6432Node\\VMware, Inc.\\VMware Workstation',
  'HKCU\\SOFTWARE\\VMware, Inc.\\VMware Workstation',
]);
export interface VmProviderDetection {
  fileExists?: (file: string) => boolean;
  readRegistry?: (key: string) => string | null;
}
const isFile = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
function installedDirectory(host: HostPlatform, key: string) {
  if (!host.commands.registry) return null;
  try {
    const text = execFileSync(host.commands.registry, ['query', key, '/v', 'InstallPath'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: REGISTRY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /\bInstallPath\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i.exec(text)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** Provider adapters build fixed commands. Ownership and result proof stay with VmLifecycle. */
export function createVmProviders(
  host: HostPlatform,
  {
    fileExists = isFile,
    readRegistry = (key: string) => installedDirectory(host, key),
  }: VmProviderDetection = {},
): VmProviderRegistry {
  function adapter(id: ManagedVmProvider, label: string): ManagedVmAdapter {
    const supported = host.capabilities.managedVm;
    return Object.freeze({
      id,
      label,
      capabilities: Object.freeze({
        automaticSetup: supported,
        powerLifecycle: supported,
        existingConnection: host.capabilities.existingSsh,
      }),
      detect(): Hypervisor {
        const result: Hypervisor = { id, label, available: false, reason: null };
        const windows = host.windows;
        if (!supported || !windows) return { ...result, reason: WINDOWS_REQUIRED };
        if (id === VmProviderId.HyperV) {
          result.available = fileExists(windows.hypervService) && fileExists(windows.hypervModule);
          if (!result.available)
            result.reason =
              'Hyper-V and its management tools are not installed. Enable Hyper-V or choose VMware Workstation.';
          return result;
        }
        const inspect = (value: unknown): HypervisorTools | null => {
          const directory = windows.expandWindowsDirectory(value);
          if (!directory) return null;
          const vmrun = path.win32.join(directory, 'vmrun.exe');
          const vdiskmanager = path.win32.join(directory, 'vmware-vdiskmanager.exe');
          return {
            directory,
            vmrun: fileExists(vmrun) ? vmrun : null,
            vdiskmanager: fileExists(vdiskmanager) ? vdiskmanager : null,
          };
        };
        let partial: HypervisorTools | null = null;
        for (const directory of windows.vmwareDirectories) {
          const tools = inspect(directory);
          if (tools?.vmrun && tools.vdiskmanager) return { ...result, available: true, tools };
          if (tools?.vmrun || tools?.vdiskmanager) partial = tools;
        }
        for (const key of REGISTRY_KEYS) {
          const tools = inspect(readRegistry(key));
          if (tools?.vmrun && tools.vdiskmanager) return { ...result, available: true, tools };
          if (tools?.vmrun || tools?.vdiskmanager) partial = tools;
        }
        return {
          ...result,
          reason: partial
            ? 'The VMware Workstation installation is incomplete: vmrun and vmware-vdiskmanager are both required.'
            : 'VMware Workstation was not found. Install it yourself, then refresh detection.',
          ...(partial ? { tools: partial } : {}),
        };
      },
      setupPlan(input: VmSetupInput): VmSetupPlan {
        if (!supported || !host.commands.powershell) throw Error(WINDOWS_REQUIRED);
        const vmware = id === VmProviderId.VMware;
        const tools =
          vmware && input.tools
            ? [
                '-VmrunPath',
                input.tools.vmrun ?? '',
                '-VdiskmanagerPath',
                input.tools.vdiskmanager ?? '',
              ]
            : [];
        const base = ['-DataDirectory', input.dataDir, ...tools];
        return {
          prepare: {
            script: vmware ? 'prepare-vmware.ps1' : 'prepare-vm.ps1',
            args: [...base, ...(input.adminSudo ? ['-AdminSudo'] : [])],
          },
          create: {
            script: vmware ? 'create-vmware.ps1' : 'launch-vm.ps1',
            args: [
              ...base,
              '-Cpu',
              String(input.cpu),
              '-MemoryGB',
              String(input.memoryGB),
              '-DiskGB',
              String(input.diskGB),
            ],
          },
          stage: vmware ? ProvisioningStatus.Creating : ProvisioningStatus.AwaitingAdmin,
        };
      },
      lifecycleCommand(input: VmLifecycleCommandInput) {
        if (!supported || !host.commands.powershell)
          throw Error('VM power management is unavailable on this host.');
        const args = [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(input.projectRoot, 'scripts', 'vm-lifecycle.ps1'),
          '-Action',
          input.action,
          '-DataDirectory',
          input.dataDir,
          '-ExpectedBinding',
          input.binding,
          '-ExpectedOperation',
          input.operationId,
          '-ExpectedDeadline',
          String(input.expiresAt),
        ];
        if (input.vmId) args.push('-ExpectedVmId', input.vmId);
        return { command: host.commands.powershell, args };
      },
    });
  }
  const hyperv = adapter(VmProviderId.HyperV, 'Hyper-V');
  const vmware = adapter(VmProviderId.VMware, 'VMware Workstation');
  const ssh = Object.freeze({
    id: VmProviderId.Ssh,
    label: 'SSH',
    capabilities: Object.freeze({
      automaticSetup: false,
      powerLifecycle: false,
      existingConnection: host.capabilities.existingSsh,
    }),
  });
  return Object.freeze({
    managed: Object.freeze([hyperv, vmware] as const),
    ssh,
    get(id: unknown) {
      if (id === VmProviderId.HyperV) return hyperv;
      if (id === VmProviderId.VMware) return vmware;
      if (id === VmProviderId.Ssh) return ssh;
      throw Error('Invalid VM provider.');
    },
  });
}
