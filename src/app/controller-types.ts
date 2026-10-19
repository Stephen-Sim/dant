import type { OwnedVmLifecycle } from './desktop-lifecycle.mts';
import type { Appearance } from '../settings/appearance-types.ts';
import type { LanguageCode } from '../i18n/languages.mts';
import type {
  VmBridgeOptions,
  VmConnectOptions,
  VmRequestOptions,
  BridgeServiceUpdate,
} from '../computer/vm-bridge.mts';
import type { ProvisioningOptions } from '../computer/provisioning.mts';
import type { VmLifecycleOptions } from '../computer/vm-lifecycle.mts';
import type { VmProfiles, VmProfileOptions } from '../computer/vm-profiles.mts';
import type { ConnectionStatusValue } from '../contracts/contracts.ts';
import type { VmObservation } from '../computer/vm-observation-types.ts';
import type { Diagnostics, DiagnosticsOptions } from '../diagnostics/diagnostics.mts';
import type { UpdateService, UpdateServiceOptions } from '../updates/updates.mts';
import type { listSystemFonts } from '../settings/appearance.mts';

export interface ControllerConfig extends Appearance {
  language: LanguageCode;
  notifications: boolean;
  showWorkSummary: boolean;
  serviceUpdatesPaused: boolean;
}
export interface PreferenceSync {
  identity: string;
  abort: AbortController;
  pending: Promise<void> | null;
  confirmed: string | null;
  submitted: boolean;
  retryAt: number;
}

export interface ControllerBridge {
  on(event: 'state', listener: (state: VmObservation) => void): unknown;
  on(event: 'change', listener: () => void): unknown;
  on(event: 'event' | 'diagnostic', listener: (event: unknown) => void): unknown;
  removeListener(event: 'diagnostic', listener: (event: unknown) => void): unknown;
  status: ConnectionStatusValue;
  cached?: VmObservation | undefined;
  error?: string | null | undefined;
  generation?: number | undefined;
  preparing?: Promise<unknown> | null | undefined;
  refreshing?: Promise<VmObservation | undefined> | null | undefined;
  reconnectManaged: boolean;
  serviceUpdate?: BridgeServiceUpdate | null | undefined;
  close(): void;
  connect(options?: VmConnectOptions): Promise<unknown>;
  disconnect(): void;
  prepare(): Promise<unknown>;
  refresh(force?: boolean): Promise<VmObservation | undefined>;
  request(route: string, options?: VmRequestOptions): Promise<Response>;
  pauseWorkForUpdate(options?: { reason?: 'install' | 'exit' }): Promise<unknown>;
}
export interface ProvisioningObservation {
  status: string;
  running?: boolean;
}
export interface ControllerProvisioning {
  snapshot(): ProvisioningObservation;
  providers(): unknown;
  on(event: 'change', listener: (state: ProvisioningObservation) => void): unknown;
  close(): void;
  start(input: {
    cpu?: unknown;
    memoryGB?: unknown;
    diskGB?: unknown;
    adminSudo?: unknown;
    provider?: unknown;
  }): unknown;
  resumeMonitoring(): ProvisioningObservation;
}
export interface ControllerVoiceKeys {
  status(): { configured: boolean; source?: unknown; storage?: unknown };
  get(): string | null | Promise<string | null>;
  set(value: unknown): Promise<unknown>;
  clear(): Promise<unknown>;
}
export type ControllerProfiles = Pick<
  VmProfiles,
  'autoImport' | 'discover' | 'import' | 'registerCurrent'
>;
export type ControllerDiagnostics = Pick<Diagnostics, 'status' | 'log' | 'recent' | 'close'>;
export type ControllerUpdates = Pick<UpdateService, 'info' | 'check' | 'close'>;
export interface ControllerAppOptions {
  dataDir?: string;
  projectRoot?: string;
  prepareOnly?: boolean;
  bridgeFactory?: (options: VmBridgeOptions) => ControllerBridge;
  provisioningFactory?: (options: ProvisioningOptions) => ControllerProvisioning;
  secretFactory?: (directory: string) => ControllerVoiceKeys;
  profileFactory?: (options: VmProfileOptions) => ControllerProfiles;
  profileOptions?: VmProfileOptions;
  fontsProvider?: typeof listSystemFonts;
  diagnosticsFactory?: (options: DiagnosticsOptions) => ControllerDiagnostics;
  updatesFactory?: (options: UpdateServiceOptions) => ControllerUpdates;
  lifecycleFactory?: (options: VmLifecycleOptions) => OwnedVmLifecycle;
}

declare global {
  namespace Express {
    interface Request {
      updateInstallDone?: (error?: unknown) => void;
    }
  }
}
