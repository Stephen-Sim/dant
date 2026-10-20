import { loadProjectEnv, type ProjectEnvOptions } from '../../scripts/config/project-env.mts';
import {
  configPort,
  readNetworkConfig,
  type ConfigurationEnvironment,
  type NetworkConfig,
  type NetworkEndpoint,
} from '../../scripts/config/network.mts';

const environment: ConfigurationEnvironment = { DANT_PORT: '5400', DANT_DEV_PORT: '5401' };
const options: ProjectEnvOptions = { projectRoot: '/project', file: '.env' };
const loaded: boolean = loadProjectEnv(options);
const config: NetworkConfig = readNetworkConfig(environment);
const endpoint: NetworkEndpoint = config.api;

// @ts-expect-error A validated development endpoint is immutable.
endpoint.port = 1234;
// @ts-expect-error The port boundary requires a numeric default.
configPort(undefined, 'DANT_PORT', '4317');
// @ts-expect-error Only the private project .env path is accepted.
loadProjectEnv({ file: '../.env' });
// @ts-expect-error Environment inputs must be a field-addressable record.
readNetworkConfig(42);

void [loaded, config, endpoint];
