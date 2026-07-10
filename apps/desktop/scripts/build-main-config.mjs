/**
 * Pure config for the bundled main-process build — no esbuild import, so the
 * unit test (src/__tests__/build-main-config.test.ts) can pin the contract
 * without loading esbuild inside the jsdom test environment.
 *
 * Output layout is a runtime contract:
 * - dist/main.js            package.json "main"
 * - dist/preload.js         BrowserWindow preload (visible window + hidden hosts)
 * - dist/db-host-entry.js   utilityProcess.fork target, resolved as a SIBLING
 * - dist/parser-host-entry.js  of the bundled main.js via module.filename
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAIN_PROCESS_ENTRY_POINTS = [
  'src/main.ts',
  'src/preload.ts',
  'src/db-host-entry.ts',
  'src/parser-host-entry.ts',
];

export const MAIN_PROCESS_BUILD_OPTIONS = {
  absWorkingDir: appRoot,
  bundle: true,
  entryPoints: MAIN_PROCESS_ENTRY_POINTS,
  format: 'cjs',
  logLevel: 'info',
  minify: false,
  outbase: path.join(appRoot, 'src'),
  outdir: path.join(appRoot, 'dist'),
  // Bare imports (electron, node-pty, @brainstrike/* dist packages, every
  // node_modules dep) stay external requires: bundling them would change
  // runtime resolution (native modules, agent-client-loader's require.resolve
  // probing) and duplicate prebuilt workspace bundles. Only relative app code
  // is bundled.
  packages: 'external',
  platform: 'node',
  sourcemap: false,
  // Electron 43 ships Node 24.
  target: 'node24',
  // Do NOT let esbuild pick up apps/desktop/tsconfig.json: its `paths` map
  // @brainstrike/* to SOURCE for the vite renderer, which would inline
  // workspace package sources and leak their own dependencies as unresolvable
  // requires (e.g. @brainstrike/indexing-contract is not a dependency of this
  // app). An empty tsconfigRaw disables paths resolution; bare imports stay
  // external and resolve at runtime exactly like the previous tsc output.
  tsconfigRaw: '{}',
};
