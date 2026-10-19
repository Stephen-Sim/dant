import type { Hypervisor, HypervisorTools, ManagedVmProvider } from '../computer-types.ts';
import type { VmProviderId } from '../../contracts/states.mts';

export interface VmProviderCapabilities {
  readonly automaticSetup: boolean;
  readonly powerLifecycle: boolean;
  readonly existingConnection: boolean;
}
export interface VmSetupInput {
  readonly dataDir: string;
  readonly cpu: number;
  readonly memoryGB: number;
  readonly diskGB: number;
  readonly adminSudo: boolean;
  readonly tools?: HypervisorTools | undefined;
}
export interface VmSetupPlan {
  readonly prepare: { readonly script: string; readonly args: readonly string[] };
  readonly create: { readonly script: string; readonly args: readonly string[] };
  readonly stage: 'creating' | 'awaiting-admin';
}
export interface VmLifecycleCommandInput {
  readonly projectRoot: string;
  readonly dataDir: string;
  readonly action: 'suspend' | 'resume';
  readonly binding: string;
  readonly vmId: string | null;
  readonly operationId: string;
  readonly expiresAt: number;
}
export interface ManagedVmAdapter {
  readonly id: ManagedVmProvider;
  readonly label: string;
  readonly capabilities: VmProviderCapabilities;
  detect(): Hypervisor;
  setupPlan(input: VmSetupInput): VmSetupPlan;
  lifecycleCommand(input: VmLifecycleCommandInput): { command: string; args: string[] };
}
export interface SshVmAdapter {
  readonly id: typeof VmProviderId.Ssh;
  readonly label: string;
  readonly capabilities: VmProviderCapabilities;
}
export interface VmProviderRegistry {
  readonly managed: readonly [ManagedVmAdapter, ManagedVmAdapter];
  readonly ssh: SshVmAdapter;
  get(id: unknown): ManagedVmAdapter | SshVmAdapter;
}
