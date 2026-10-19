import type { Hypervisor, VmProvider } from './computer-types.ts';
import type { HostPlatform } from '../platform/host-types.ts';
import { createHostPlatform } from '../platform/host-platform.mts';
import { VmProviderId } from '../contracts/states.mts';
import { createVmProviders } from './providers/vm-providers.mts';
interface HypervisorDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  host?: HostPlatform;
  fileExists?: (file: string) => boolean;
  readRegistry?: (key: string) => string | null;
}
interface HypervisorSelection {
  requested?: unknown;
  preferred?: VmProvider | null;
  availableProviders?: readonly { id: string; available: boolean; reason?: string | null }[];
}

/** Read-only discovery through implemented provider adapters; never launches a VM. */
export function detectHypervisors({
  platform = process.platform,
  env = process.env,
  host = createHostPlatform({ platform, env }),
  fileExists,
  readRegistry,
}: HypervisorDetectionOptions = {}): [Hypervisor, Hypervisor] {
  const providers = createVmProviders(host, {
    ...(fileExists ? { fileExists } : {}),
    ...(readRegistry ? { readRegistry } : {}),
  });
  return [providers.managed[0].detect(), providers.managed[1].detect()];
}

/** An existing or previously selected provider is never silently replaced. */
export function selectHypervisor({
  requested = 'auto',
  preferred = null,
  availableProviders = [],
}: HypervisorSelection = {}) {
  if (
    typeof requested !== 'string' ||
    !['auto', VmProviderId.HyperV, VmProviderId.VMware].includes(requested)
  )
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
  if (detected.id !== VmProviderId.HyperV && detected.id !== VmProviderId.VMware)
    throw Error('Invalid VM provider: choose auto, hyperv or vmware.');
  return detected.id;
}
