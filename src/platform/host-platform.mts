import { HostPlatformId } from '../contracts/states.mts';
import { hostConfiguration } from '../config/host-config.mts';
import { createWindowsDpapi } from '../security/secrets.mts';
import type { HostPlatform, HostSecretProtection } from './host-types.ts';

export interface HostPlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  secretProtection?: HostSecretProtection;
}

/** Host capabilities describe implemented adapters, not a promise of device availability. */
export function createHostPlatform({
  platform = process.platform,
  env = process.env,
  secretProtection,
}: HostPlatformOptions = {}): HostPlatform {
  const id =
    platform === HostPlatformId.Windows
      ? HostPlatformId.Windows
      : platform === HostPlatformId.MacOS
        ? HostPlatformId.MacOS
        : platform === HostPlatformId.Linux
          ? HostPlatformId.Linux
          : HostPlatformId.Unsupported;
  const windows = id === HostPlatformId.Windows ? hostConfiguration(env) : null;
  const protection =
    secretProtection ||
    (windows ? createWindowsDpapi({ powershellPath: windows.powershell }) : undefined);
  return Object.freeze({
    id,
    platform,
    capabilities: Object.freeze({
      managedVm: windows !== null,
      existingSsh: id !== HostPlatformId.Unsupported,
      secretProtection: protection !== undefined,
    }),
    commands: Object.freeze({
      powershell: windows ? 'powershell.exe' : null,
      registry: windows ? 'reg.exe' : null,
      archive: windows?.archive ?? 'tar',
    }),
    windows,
    ...(protection ? { secretProtection: protection } : {}),
  });
}
