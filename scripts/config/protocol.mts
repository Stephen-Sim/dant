import canonical from '../../resources/config/protocol.json' with { type: 'json' };
import { validateProtocol } from '../../ui/shared/network-protocol.mts';

export {
  MAX_PORT,
  validateProtocol,
  parseProtocolJSON,
} from '../../ui/shared/network-protocol.mts';
export type { Protocol } from '../../ui/shared/network-protocol.mts';

export const PROTOCOL = validateProtocol(canonical);
