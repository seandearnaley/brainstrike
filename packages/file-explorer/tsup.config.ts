import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts', 'src/worker-storage.worker.js'],
  format: ['esm', 'cjs'],
  splitting: false,
  clean: false,
  target: 'es2022',
  dts: false,
  injectStyle: false,
  // Copy the transpiled worker (Rollup/Vite emits ".worker.js") as a separate asset so
  // it can be loaded at runtime without bundling issues.
  loader: { '.worker.js': 'copy' },
  esbuildOptions(options, context) {
    if (context.format === 'cjs') {
      // Suppress "import.meta is not available with the cjs output format" warning.
      //
      // resolveWorkerStorageUrl() in worker-storage.ts uses `import.meta.url` which is
      // ESM-only. The CJS build includes this code statically, but it's NEVER executed
      // at runtime in CJS — worker-init.ts guards the call behind browser-only checks
      // (typeof window, non-test, non-Electron, non-headless). The warning is harmless.
      //
      // If you're tempted to "fix" this by wrapping import.meta in typeof guards or
      // splitting into separate entry points: we tried both — they don't work because
      // the import chain (index → store → persistence → worker-init → worker-storage)
      // is transitively included. Suppressing the warning is the correct solution.
      options.logOverride = {
        ...options.logOverride,
        'empty-import-meta': 'silent',
      };
    }
  },
});
