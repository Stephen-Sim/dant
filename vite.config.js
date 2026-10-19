import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {loadProjectEnv} from './src/config/env.mjs';
import {readNetworkConfig, PROTOCOL_PATHS} from './src/config/network.mjs';

loadProjectEnv({projectRoot: fileURLToPath(new URL('.', import.meta.url))});
const network = readNetworkConfig();
export default defineConfig({
  root: 'ui',
  server: {
    host: network.development.host,
    port: network.development.port,
    strictPort: true,
    proxy: {
      [PROTOCOL_PATHS.api]: network.api.httpOrigin,
      [PROTOCOL_PATHS.events]: {target: network.api.wsOrigin, ws: true},
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {input: {main: 'ui/index.html', callOverlay: 'ui/call-overlay.html'}},
  },
});
