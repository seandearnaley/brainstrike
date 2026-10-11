import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Windows M3 repeated-open tests spent the deadline loading these two process
// graphs. Keep the library/declarations as tsc output; bundle only the existing
// process boundaries, without moving their native dependencies or worker owners.
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  banner: {
    js: "import { createRequire as __entryRequire } from 'node:module'; const require = __entryRequire(import.meta.url);",
  },
  bundle: true,
  entryPoints: ['src/process-entry.ts', 'src/writer-worker.ts'],
  external: [
    '@brainstrike/state-store',
    '@brainstrike/*-native',
    '@brainstrike/chunking-worker',
    'better-sqlite3',
  ],
  format: 'esm',
  outdir: 'dist',
  packages: 'bundle',
  platform: 'node',
  sourcemap: true,
  target: 'node24',
  tsconfigRaw: {},
});
