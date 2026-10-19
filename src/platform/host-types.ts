import type { HostPlatformIdValue } from '../contracts/states.mts';
import type { HostConfiguration } from '../config/host-config.mts';

export interface HostSecretProtection {
  protect(value: string): Promise<Buffer>;
  unprotect(blob: Buffer): Promise<string>;
}

export interface HostPlatform {
  readonly id: HostPlatformIdValue;
  readonly platform: NodeJS.Platform;
  readonly capabilities: Readonly<{
    managedVm: boolean;
    existingSsh: boolean;
    secretProtection: boolean;
  }>;
  readonly commands: Readonly<{
    powershell: string | null;
    registry: string | null;
    archive: string;
  }>;
  readonly windows: HostConfiguration | null;
  readonly secretProtection?: HostSecretProtection;
}
