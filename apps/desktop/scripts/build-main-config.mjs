/**
 * Pure config for the bundled main-process build — no esbuild import, so the
 * unit test (src/__tests__/build-main-config.test.ts) can pin the contract
 * without loading esbuild inside the jsdom test environment.
 *
 * Output layout is a runtime contract:
 * - dist/main.js            package.json "main"
 * - dist/preload.js         visible BrowserWindow preload
 * - dist/hidden-preload.js  role-selected hidden renderer capability manifest
 * - dist/db-host-entry.js   utilityProcess.fork target, resolved as a SIBLING
 * - dist/parser-host-entry.js  of the bundled main.js via module.filename
 * - dist/main-log-transport.js  Pino worker target, unpacked beside app.asar
 * - dist/main-watchdog-worker.js  freeze watchdog, unpacked beside app.asar
 *
 * This single-file-per-entry-point (`bundle: true`) output is why
 * `module.filename`-based sibling resolution is safe: the file that's
 * actually running always sits directly in `dist/`, regardless of how
 * Electron was launched. That's now load-bearing at THREE more call sites
 * beyond db-host-entry/parser-host-entry (BST-1459 — `app.getAppPath()`
 * returns launch-mode-dependent values and cannot substitute for this):
 * - `resolveMainWatchdogWorkerPath` (diagnostics/main-watchdog-path.ts)
 * - `resolveMainLogTransportPath` (diagnostics/main-log-transport-path.ts)
 * - `resolveDesktopPythonRuntimeResourcesDir` (python-runtime/index.ts) —
 *   takes `path.dirname()` TWICE (dist/ → its parent apps/desktop/) to
 *   reach `resources/python-runtime`, a sibling of `dist/` rather than a
 *   sibling of `main.js` itself. That second `dirname()` additionally
 *   encodes dist/'s DEPTH below the app root, not just its identity — the
 *   other two sites only need "same directory as the running module" and
 *   are unaffected if dist/ ever moves; this one silently breaks if a
 *   future change nests dist/ one level deeper or shallower.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAIN_PROCESS_ENTRY_POINTS = {
  'db-host-entry': 'src/db-host-entry.ts',
  'hidden-preload': 'src/hidden-preload.ts',
  main: 'src/main-bootstrap.ts',
  'main-log-transport': 'src/diagnostics/main-log-transport.ts',
  'main-watchdog-worker': 'src/diagnostics/main-watchdog-worker.ts',
  'parser-host-entry': 'src/parser-host-entry.ts',
  preload: 'src/preload.ts',
};

export const MAIN_PROCESS_BUILD_OPTIONS = {
  absWorkingDir: appRoot,
  // Narrow exceptions to packages:'external' (aliases are applied before
  // external classification):
  // - @brainstrike/notes-vault ships a bundler-target ESM dist with
  //   EXTENSIONLESS relative imports, which Node's runtime resolver cannot
  //   load from this CJS bundle. Its one main-process subpath is inlined.
  // - @brainstrike/assistant-data is an ESM-only renderer package. The shared,
  //   dependency-free startup-reaper subpath is inlined so web and desktop use
  //   one predicate without adding a fake `require` export that Node cannot
  //   actually execute.
  alias: {
    '@brainstrike/assistant-data/assistant-thread-run-reaper': path.resolve(
      appRoot,
      '../../packages/assistant-data/src/assistant-thread-run-reaper.ts'
    ),
    '@brainstrike/notes-vault/core': path.resolve(
      appRoot,
      '../../packages/notes-vault/src/core/index.ts'
    ),
  },
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
