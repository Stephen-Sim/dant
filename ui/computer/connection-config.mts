import type { VmSettings } from '../shared/contracts.mts';

// The standard SSH default applies only when no custom VM port is present.
export const DEFAULT_SSH_PORT = 22;

// A retained desktop frame belongs to this connection and its trust settings.
// Online/connecting state and the conversation do not change that ownership.
export function computerConnectionIdentity(vm: VmSettings): string {
  return JSON.stringify([
    vm.host ?? null,
    vm.user ?? null,
    vm.port ?? DEFAULT_SSH_PORT,
    vm.keyPath ?? null,
    vm.knownHosts ?? null,
    vm.provider ?? null,
  ]);
}
