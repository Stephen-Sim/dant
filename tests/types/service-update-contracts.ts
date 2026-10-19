import { ConnectionStatus, ServiceUpdateStatus } from '../../src/contracts/states.mts';
import {
  VmServiceUpdateLoop,
  serviceUpdateIdle,
  serviceUpdatePaused,
  type AutomaticServiceConnection,
  type ServiceUpdateBridge,
  type ServiceUpdateLoopOptions,
} from '../../src/computer/vm-service-update.mts';

const bridge: ServiceUpdateBridge = {
  status: ConnectionStatus.Offline,
  generation: 1,
  serviceUpdate: { status: ServiceUpdateStatus.Checking, reason: null },
  refresh: async (_force) => ({ active: null }),
};
const options: ServiceUpdateLoopOptions = {
  bridge,
  binding: () => ({ host: '192.0.2.1' }),
  connect: async (_connection) => {},
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: (timer) => {
    if (timer !== null) clearTimeout(timer);
  },
};
const loop = new VmServiceUpdateLoop(options);
const snapshot: unknown = { active: null };
const idle: boolean = serviceUpdateIdle(snapshot);
const paused: boolean = serviceUpdatePaused(snapshot);
const automatic: AutomaticServiceConnection = { deploy: false, automatic: true };

// @ts-expect-error The automatic loop never requests a manual connection intent.
const manual: AutomaticServiceConnection = { deploy: true, automatic: false };
const interrupt: AutomaticServiceConnection = {
  deploy: true,
  automatic: true,
  // @ts-expect-error Automatic connection requests cannot acquire permission to interrupt work.
  updateRunningWork: true,
};
// @ts-expect-error A refresh must be asynchronous and its result remains unknown until validated.
const synchronous: ServiceUpdateBridge = { ...bridge, refresh: () => ({ active: null }) };
// @ts-expect-error Unknown transport states cannot be silently treated as online.
const invalid: ServiceUpdateBridge = { ...bridge, status: 'ready' };
// @ts-expect-error The loop requires explicit connection ownership and dependencies.
new VmServiceUpdateLoop({ bridge });

void [loop, idle, paused, automatic, manual, interrupt, synchronous, invalid];
