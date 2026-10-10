import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import desktop from '../../apps/desktop/vite.config.mts';

// Compile/minify the exact shipped renderer configuration. Only the test
// document and its disposable output directory differ from the app build.
export default defineConfig(
  mergeConfig(desktop, {
    build: {
      emptyOutDir: true,
      rolldownOptions: {
        input: {
          main: resolve(import.meta.dirname, 'src/__tests__/committed-production/index.html'),
        },
      },
    },
    root: resolve(import.meta.dirname, 'src/__tests__/committed-production'),
  })
);
