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
 * - dist/host-lease-entry.js  shared root-discovery utility process
 * - dist/main-log-transport.js  Pino worker target, unpacked beside app.asar
 * - dist/main-watchdog-worker.js  freeze watchdog, unpacked beside app.asar
 *
 * This single-file-per-entry-point (`bundle: true`) output is why resolving
 * a sibling output file from the running bundled module's own on-disk path
 * is safe: the file that's actually running always sits directly in
 * `dist/`, regardless of how Electron was launched. That's now load-bearing
 * at THREE more call sites beyond db-host-entry/parser-host-entry (BST-1459
 * — `app.getAppPath()` returns launch-mode-dependent values and cannot
 * substitute for this), all three now consolidated into
 * `apps/desktop/src/bundled-sibling-path.ts` (see its docblock for why it
 * uses `__filename`, not `module.filename` — empty under Vitest's module
 * transform — or `import.meta.filename` — empty in this esbuild `cjs`
 * output; db-host-entry/parser-host-entry still use the older
 * `module.filename` shape, tracked as BST-1460 migration debt):
 * - `resolveMainWatchdogWorkerPath` (diagnostics/main-watchdog-path.ts)
 * - `resolveMainLogTransportPath` (diagnostics/main-log-transport-path.ts)
 * - `resolveDesktopPythonRuntimeResourcesDir` (python-runtime/index.ts) —
 *   takes `path.dirname()` TWICE (dist/ → its parent apps/desktop/) to
 *   reach `resources/python-runtime`, a sibling of `dist/` rather than a
 *   sibling of `main.js` itself, and additionally requires that immediate
 *   parent directory to be literally NAMED `dist` — an identity check on
 *   that one path segment, not a depth check (e.g. `out/dist/main.js`
 *   still resolves correctly; only the parent's basename is compared, not
 *   how many levels it sits below the app root). The other two sites need
 *   no name assumption at all. This one enforces its identity assumption
 *   at runtime — it throws if that parent directory isn't named `dist`,
 *   rather than silently pointing at the wrong directory if a future
 *   change renames or restructures the bundled output.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAIN_PROCESS_ENTRY_POINTS = {
  'agent-host-entry': 'src/agent-host-entry.ts',
  'db-host-entry': 'src/db-host-entry.ts',
  'hidden-preload': 'src/hidden-preload.ts',
  'host-lease-entry': 'src/host-lease-entry.ts',
  'indexer-host-entry': 'src/indexer-host-entry.ts',
  main: 'src/main-bootstrap.ts',
  'main-log-transport': 'src/diagnostics/main-log-transport.ts',
  'main-watchdog-worker': 'src/diagnostics/main-watchdog-worker.ts',
  'official-conformance-client-entry': 'src/official-conformance-client-entry.ts',
  'parser-host-entry': 'src/parser-host-entry.ts',
  preload: 'src/preload.ts',
  'sqlite-query-host-entry': 'src/sqlite-query-host-entry.ts',
};

/** @type {import('esbuild').BuildOptions} */
export const MAIN_PROCESS_BUILD_OPTIONS = {
  absWorkingDir: appRoot,
  // Narrow exceptions to packages:'external' (aliases are applied before
  // external classification):
  // - @brainstrike/notes-vault ships a bundler-target ESM dist with
  //   EXTENSIONLESS relative imports, which Node's runtime resolver cannot
  //   load from this CJS bundle. Its one main-process subpath is inlined.
  // - @brainstrike/assistant-data is ESM-only. Main inlines the shared
  //   startup-reaper and canonical history-mapper subpaths from source rather
  //   than requiring an export Node cannot execute from this CJS bundle.
  // - @brainstrike/workspace-search/core is a browser ESM barrel with
  //   extensionless relative imports. Inline this exact public subpath for
  //   the native assistant consumer; retain the shared fusion implementation.
  alias: {
    '@brainstrike/assistant-data/assistant-memory-repository': path.resolve(
      appRoot,
      '../../packages/assistant-data/src/assistant-memory-repository.ts'
    ),
    '@brainstrike/assistant-data/assistant-thread-run-reaper': path.resolve(
      appRoot,
      '../../packages/assistant-data/src/assistant-thread-run-reaper.ts'
    ),
    '@brainstrike/notes-vault/core': path.resolve(
      appRoot,
      '../../packages/notes-vault/src/core/index.ts'
    ),
    '@brainstrike/workspace-search/core': path.resolve(
      appRoot,
      '../../packages/workspace-search/src/core/index.ts'
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
