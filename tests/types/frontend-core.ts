import { loadLanguage } from '../../ui/i18n/localization.mts';
import { formatPresence } from '../../ui/chat/presence.mts';
import type { PresenceDisplay } from '../../ui/chat/presence.mts';
import { createCallDuration, formatCallDuration } from '../../ui/call/call-duration.mts';
import type { CallDurationClock, CallDurationSnapshot } from '../../ui/call/call-duration.mts';

const externalState: unknown = { workerStatus: 'online' };
const externalClock: unknown = 1000;
const display: PresenceDisplay = formatPresence(externalState, 'ar', externalClock);
const online: boolean = display.online;
const label: string = display.label;
const loading: Promise<void> = loadLanguage(externalState);
void online;
void label;
void loading;

const clock: CallDurationClock = createCallDuration({
  schedule: () => 12,
  cancel(handle) {
    const timerId: number = handle;
    void timerId;
  },
  onTick(snapshot) {
    const seconds: number = snapshot.seconds;
    void seconds;
  },
});
const snapshot: CallDurationSnapshot = clock.snapshot;
const seconds: number = snapshot.seconds;
clock.sync(externalState, [{ kind: 'call', callId: 'previous', seconds: 2 }]);
clock.start('current', externalClock);
clock.stop('current', externalClock);
clock.reset(null);
formatCallDuration('61');
formatCallDuration(seconds);
clock.dispose();

// @ts-expect-error Presence exposes a boolean connection state.
const invalidConnection: string = display.online;
void invalidConnection;
// @ts-expect-error The clock exposes a numeric duration.
snapshot.seconds = 'two';
// @ts-expect-error The clock snapshot getter cannot be replaced.
clock.snapshot = snapshot;
// @ts-expect-error A trusted reset requires a string identity or null.
clock.reset(12);
// @ts-expect-error Scheduler and cancellation handles must have matching types.
createCallDuration({ schedule: () => 1, cancel: (handle: string) => void handle });
// @ts-expect-error A clock tick receives the structured snapshot.
createCallDuration({ onTick: (value: string) => void value });
