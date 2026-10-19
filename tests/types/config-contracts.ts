import { loadProjectEnv, type ProjectEnvOptions } from '../../src/config/env.mts';
import {
  applicationEndpoint,
  configPort,
  publicVmEnvironment,
  readNetworkConfig,
  validatePublicVmEnvironment,
  type ConfigurationEnvironment,
  type NetworkConfig,
  type NetworkEndpoint,
  type PublicVmEnvironment,
} from '../../src/config/network.mts';

const environment: ConfigurationEnvironment = {
  DANT_GUEST_PORT: '4320',
  DANT_MANAGED: '1',
};
const options: ProjectEnvOptions = { projectRoot: '/project', file: '.env' };
const loaded: boolean = loadProjectEnv(options);
const config: NetworkConfig = readNetworkConfig(environment);
const endpoint: NetworkEndpoint = applicationEndpoint(environment, { vmWorker: true });
const publicEnvironment: PublicVmEnvironment = publicVmEnvironment(environment);
const validated: PublicVmEnvironment = validatePublicVmEnvironment({
  DANT_GUEST_HOST: 'localhost',
  DANT_GUEST_PORT: '4320',
});

// @ts-expect-error A validated endpoint cannot be mutated after construction.
endpoint.port = 1234;
// @ts-expect-error The configuration boundary requires a numeric default port.
configPort(undefined, 'DANT_PORT', '4317');
// @ts-expect-error Only the private root .env file is accepted by the typed API.
loadProjectEnv({ file: '../.env' });
// @ts-expect-error Worker selection is an explicit boolean.
applicationEndpoint(environment, { vmWorker: 'true' });
// @ts-expect-error Public VM data never contains numeric or unvalidated ports.
const invalidPublic: PublicVmEnvironment = { DANT_GUEST_HOST: 'localhost', DANT_GUEST_PORT: 4320 };

void [loaded, config, endpoint, publicEnvironment, validated, invalidPublic];
