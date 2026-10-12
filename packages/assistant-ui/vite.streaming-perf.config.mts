import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import desktop from '../../apps/desktop/vite.config.mts';

// Compile/minify the exact shipped renderer configuration (BST-1929 perf lane).
// Only the test document, its disposable output directory and React DOM's
// profiling build (so <Profiler> reports actualDuration) differ from the app.
export default defineConfig(
  mergeConfig(desktop, {
    build: {
      emptyOutDir: true,
      rolldownOptions: {
        input: {
          main: resolve(import.meta.dirname, 'src/__tests__/streaming-perf/index.html'),
        },
      },
    },
    resolve: {
      alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }],
    },
    root: resolve(import.meta.dirname, 'src/__tests__/streaming-perf'),
  })
);
