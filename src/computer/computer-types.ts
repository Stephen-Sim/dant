import type { VmProviderId, VmProviderIdValue } from '../contracts/states.mts';
export type ManagedVmProvider = Exclude<VmProviderIdValue, typeof VmProviderId.Ssh>;
export type VmProvider = VmProviderIdValue;
export interface VmBindingMetadata {
  provider?: VmProvider;
  name?: string;
  vmxPath?: string;
  vmwareId?: string;
}
export interface VmBinding extends VmBindingMetadata {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  knownHosts: string;
}
export interface VmProfile extends VmBindingMetadata {
  id: string;
  label: string;
  directory: string;
  host: string;
  user: string;
  port: number;
  source: string;
  vm: VmBinding;
}
export type PublicVmProfile = Omit<VmProfile, 'vm'>;
export interface HypervisorTools {
  directory: string;
  vmrun: string | null;
  vdiskmanager: string | null;
}
export interface Hypervisor {
  id: ManagedVmProvider;
  label: string;
  available: boolean;
  reason: string | null;
  tools?: HypervisorTools;
}
