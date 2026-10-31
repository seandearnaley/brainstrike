/**
 * Pure config for the bundled Node-side build — no esbuild import, so the
 * unit test (src/__tests__/build-main-config.test.ts) can pin the contract
 * without loading esbuild inside the jsdom test environment.
 *
 * Desktop compiles every workspace package it runs from source
 * (workspace-source-bundling.mjs): `@brainstrike/*` is bundled, and only
 * third-party packages, `electron` and the two native add-ons stay runtime
 * imports, resolved from this app's own node_modules. Desktop loads no
 * workspace package's `dist`.
 *
 * Output layout is a runtime contract. Everything sits directly in `dist/`:
 * - dist/main.js            package.json "main" (ESM; desktop is `type: module`)
 * - dist/*-entry.js         utility-process entries Main forks by sibling path;
 *   the order-sensitive ones are launchers (`PROCESS_LAUNCHERS`)
 * - dist/<chunk>-<hash>.js  modules shared by those entries. One process loads
 *   one instance of each module, however many entries it loads (Main loads its
 *   bootstrap and runtime; the agent host loads its launcher and platform).
 * - dist/<package entry>.js  worker and module entries the bundled packages
 *   name by path (`PACKAGE_RUNTIME_ENTRY_POINTS`)
 * - dist/writer-worker.mjs, memory-calculator-worker.mjs  the state-store writer
 *   and memory calculator workers, self-contained
 * - dist/main-log-transport.js, main-watchdog-worker.js  self-contained ESM,
 *   unpacked beside app.asar, so they cannot share chunks inside it
 * - dist/preload.cjs  the sandboxed preload (CommonJS)
 * - dist/windows-command-entry.cjs  self-contained Windows command wrapper
 *
 * Resolving a sibling output from the running module's own path is therefore
 * safe: the running file always sits directly in `dist/`, however Electron was
 * launched (BST-1459 — `app.getAppPath()` is launch-mode-dependent). See
 * `apps/desktop/src/bundled-sibling-path.ts` and
 * `resolveDesktopPythonRuntimeResourcesDir` (python-runtime/resources-dir.ts),
 * which additionally requires that parent directory to be named `dist`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceSourceBundling } from './workspace-source-bundling.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = path.resolve(appRoot, '../../packages');

/**
 * Workspace source may call `require` (through `createRequire` or a dependency's
 * CommonJS interop); give every ESM output a real one.
 */
export const ESM_REQUIRE_BANNER = {
  js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
  absWorkingDir: appRoot,
  bundle: true,
  logLevel: 'info',
  // Each bundle's inputs, from which build-main.mjs reports the third-party
  // packages it inlines for the license notices.
  metafile: true,
  minify: false,
  outdir: path.join(appRoot, 'dist'),
  platform: 'node',
  sourcemap: false,
  // Electron 43 ships Node 24.
  target: 'node24',
  // Do NOT let esbuild pick up apps/desktop/tsconfig.json: it configures the
  // renderer's type-check, not this Node bundle.
  tsconfigRaw: '{}',
};

/**
 * Worker and module entries the bundled packages name by path, emitted where
 * that path resolves from a chunk in dist/. Each name is unique in dist/.
 * - agent-host's keyring worker and the indexer's writer pool name a sibling:
 *   `./keyring-native-entry.js`, `./writer-worker.js`.
 * - agent-host names its emitted modules in its package `dist/` from a module
 *   directly in src/ or dist/ (`../dist/<file>`, BST-1977). From a chunk in
 *   this app's dist/, that is this dist/.
 */
export const PACKAGE_RUNTIME_ENTRY_POINTS = {
  'adapters/memory-storage-calculator': path.join(
    packagesRoot,
    'agent-host/src/adapters/memory-storage-calculator.ts'
  ),
  'host-state-index-worker': path.join(packagesRoot, 'agent-host/src/host-state-index-worker.ts'),
  'keyring-native-entry': path.join(
    packagesRoot,
    'agent-host/src/adapters/keyring-native-entry.ts'
  ),
  'state-projection': path.join(packagesRoot, 'agent-host/src/state-projection.ts'),
  'writer-worker': path.join(packagesRoot, 'indexer/src/writer-worker.ts'),
};

/** Entries a process loads, and the package entries those modules name. */
export const NODE_PROCESS_ENTRY_POINTS = {
  'agent-egress-entry': 'src/agent-egress-entry.ts',
  'agent-host-platform-entry': 'src/agent-host-platform-entry.ts',
  'agent-host-process': 'src/agent-host-entry.ts',
  // The app-close integration proof loads it by path before Main.
  'desktop-bootstrap-runtime': 'src/desktop-bootstrap-runtime.ts',
  'desktop-env': 'src/desktop-env.ts',
  // Main imports it lazily; the packaged Python probe loads it by path.
  'fence-executor': path.join(packagesRoot, 'agent/src/fence-executor.ts'),
  'host-lease-process': 'src/host-lease-entry.ts',
  'indexer-host-process': 'src/indexer-host-entry.ts',
  'lifecycle-delay-seam': 'src/lifecycle-delay-seam.ts',
  'main-process': 'src/main-bootstrap.ts',
  'sqlite-query-host-entry': 'src/sqlite-query-host-entry.ts',
  ...PACKAGE_RUNTIME_ENTRY_POINTS,
};

const DEFAULT_OWNER = '@brainstrike/secure-fs-native/default-owner';

/**
 * Code splitting hoists shared-chunk imports above an entry's own first import
 * (https://esbuild.github.io/api/#splitting), so a process whose first module
 * must evaluate before anything else starts from a launcher: static imports, in
 * order. The default owner (BST-2246) evaluates before any module that can
 * create a file; Main's environment and delay seam modules precede its
 * bootstrap. No step moves behind a dynamic import, so Main's pre-`ready` work
 * stays in its static graph. build-main.mjs writes each as dist/<name>.js.
 */
export const PROCESS_LAUNCHERS = {
  'agent-host-entry': [DEFAULT_OWNER, './agent-host-process.js'],
  'host-lease-entry': [DEFAULT_OWNER, './host-lease-process.js'],
  'indexer-host-entry': [DEFAULT_OWNER, './indexer-host-process.js'],
  main: [DEFAULT_OWNER, './desktop-env.js', './lifecycle-delay-seam.js', './main-process.js'],
};

/**
 * One ESM build with code splitting, so every module shared by entries that run
 * in one process exists once there. Main's pre-`ready` work runs in the static
 * import graph of dist/main.js; only Main's runtime loads after `ready`, through
 * the dynamic import it always used.
 * @type {import('esbuild').BuildOptions}
 */
export const NODE_PROCESS_BUILD_OPTIONS = {
  ...shared,
  banner: ESM_REQUIRE_BANNER,
  // Chunks stay in dist/ beside the entries (see the layout contract above).
  chunkNames: '[name]-[hash]',
  define: { __dirname: 'import.meta.dirname', __filename: 'import.meta.filename' },
  entryPoints: NODE_PROCESS_ENTRY_POINTS,
  format: 'esm',
  plugins: [workspaceSourceBundling({ packagesRoot, thirdParty: 'external' })],
  splitting: true,
};

/**
 * The state-store writer and memory calculator workers are plain ESM (`.mjs`)
 * that state-store names beside its own modules, so their bundled entries keep
 * that extension.
 * @type {import('esbuild').BuildOptions}
 */
export const STATE_STORE_WRITER_BUILD_OPTIONS = {
  ...shared,
  banner: ESM_REQUIRE_BANNER,
  entryPoints: {
    'memory-calculator-worker': path.join(
      packagesRoot,
      'state-store/src/memory-calculator-worker.mjs'
    ),
    'writer-worker': path.join(packagesRoot, 'state-store/src/writer-worker.mjs'),
  },
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  plugins: [workspaceSourceBundling({ packagesRoot, thirdParty: 'external' })],
};

/**
 * Worker threads Main starts from beside app.asar: each is one self-contained file.
 * @type {import('esbuild').BuildOptions}
 */
export const UNPACKED_WORKER_BUILD_OPTIONS = {
  ...shared,
  entryPoints: {
    'main-log-transport': 'src/diagnostics/main-log-transport.ts',
    'main-watchdog-worker': 'src/diagnostics/main-watchdog-worker.ts',
  },
  format: 'esm',
  plugins: [workspaceSourceBundling({ packagesRoot, thirdParty: 'external' })],
};

/**
 * The sandboxed preload: CommonJS that requires nothing but `electron`
 * (preload-bundle-contract.mjs).
 * @type {import('esbuild').BuildOptions}
 */
export const PRELOAD_BUILD_OPTIONS = {
  ...shared,
  entryPoints: { preload: 'src/preload.ts' },
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  plugins: [workspaceSourceBundling({ packagesRoot, thirdParty: 'external' })],
};

/**
 * dist/windows-command-entry.cjs, the trusted Windows command wrapper. It inlines
 * every package; only the native Job addon stays a runtime require.
 * @type {import('esbuild').BuildOptions}
 */
export const WINDOWS_COMMAND_BUILD_OPTIONS = {
  ...shared,
  entryPoints: { 'windows-command-entry': 'src/windows-command-entry.ts' },
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  plugins: [workspaceSourceBundling({ packagesRoot, thirdParty: 'bundle' })],
};

/**
 * Every Node-side build. build-main.mjs emits each one.
 */
export const NODE_BUILDS = [
  NODE_PROCESS_BUILD_OPTIONS,
  STATE_STORE_WRITER_BUILD_OPTIONS,
  UNPACKED_WORKER_BUILD_OPTIONS,
  PRELOAD_BUILD_OPTIONS,
  WINDOWS_COMMAND_BUILD_OPTIONS,
];
