import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Every native add-on this package depends on, by its exact name. An exact
// package name also keeps its subpaths external (secure-fs-native/default-owner,
// BST-2246); a wildcard pattern such as `@brainstrike/*-native` does not.
// https://esbuild.github.io/api/#external
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const nativeAddons = Object.keys(manifest.dependencies).filter((name) =>
  /^@brainstrike\/[a-z-]+-native$/.test(name)
);

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
    ...nativeAddons,
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
