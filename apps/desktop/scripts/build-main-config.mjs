/**
 * Pure config for the bundled Node-side build — no esbuild import, so the
 * unit test (src/__tests__/build-main-config.test.ts) can pin the contract
 * without loading esbuild inside the jsdom test environment.
 *
 * Desktop compiles every workspace package it runs from source: `@brainstrike/*`
 * is bundled, and only third-party packages and the two native add-ons stay
 * runtime imports, resolved from this app's own node_modules. No workspace
 * package ships a `dist` for Node to load.
 *
 * Output layout is a runtime contract. Everything sits directly in `dist/`:
 * - dist/main.js            package.json "main" (ESM; desktop is `type: module`)
 * - dist/*-entry.js         utility-process entries Main forks by sibling path
 * - dist/<chunk>-<hash>.js  modules shared by those entries. One process loads
 *   one instance of each module, however many entries it loads (Main loads its
 *   bootstrap and runtime; the agent host loads its launcher and platform).
 * - dist/writer-worker.js, host-state-index-worker.js, keyring-native-entry.js,
 *   memory-storage-calculator.js  worker and module entries a workspace package
 *   names beside its own module (`new URL('./writer-worker.js', import.meta.url)`);
 *   every chunk sits in dist/, so the sibling is the bundled entry.
 * - dist/writer-worker.mjs  the state-store writer worker, self-contained
 * - dist/main-log-transport.js, main-watchdog-worker.js  self-contained ESM,
 *   unpacked beside app.asar, so they cannot share chunks inside it
 * - dist/preload.cjs, hidden-preload.cjs  sandboxed preloads (CommonJS)
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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = path.resolve(appRoot, '../../packages');

/** node-gyp builds these, and the packaged app unpacks their binaries beside app.asar. */
const NATIVE_WORKSPACE_PACKAGES = ['@brainstrike/secure-fs-native', '@brainstrike/windows-job-native'];

function isBundledWorkspaceImport(specifier) {
  return (
    specifier.startsWith('@brainstrike/') &&
    !NATIVE_WORKSPACE_PACKAGES.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`)
    )
  );
}

/**
 * Bundle workspace packages from their source exports; every other bare import
 * (third-party, `electron`, `node:*`, the native add-ons) stays a runtime import.
 * @type {import('esbuild').Plugin}
 */
export const workspaceSourceBundling = {
  name: 'workspace-source-bundling',
  setup(build) {
    build.onResolve({ filter: /^[^./#]/ }, (args) => {
      if (path.isAbsolute(args.path) || isBundledWorkspaceImport(args.path)) {
        return;
      }
      return { external: true, path: args.path };
    });
  },
};

/**
 * Workspace source may call `require` (through `createRequire` or a dependency's
 * CommonJS interop); give every ESM output a real one.
 */
const ESM_REQUIRE_BANNER = {
  js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
};

const shared = {
  absWorkingDir: appRoot,
  bundle: true,
  logLevel: 'info',
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

/** Entries a process loads, and the package entries those modules name beside themselves. */
export const NODE_PROCESS_ENTRY_POINTS = {
  'agent-egress-entry': 'src/agent-egress-entry.ts',
  'agent-host-entry': 'src/agent-host-entry.ts',
  'agent-host-platform-entry': 'src/agent-host-platform-entry.ts',
  // The app-close integration proof loads it by path before Main.
  'desktop-bootstrap-runtime': 'src/desktop-bootstrap-runtime.ts',
  'host-lease-entry': 'src/host-lease-entry.ts',
  'host-state-index-worker': path.join(packagesRoot, 'agent-host/src/host-state-index-worker.ts'),
  'indexer-host-entry': 'src/indexer-host-entry.ts',
  'keyring-native-entry': path.join(packagesRoot, 'agent-host/src/adapters/keyring-native-entry.ts'),
  main: 'src/main-bootstrap.ts',
  'memory-storage-calculator': path.join(
    packagesRoot,
    'agent-host/src/adapters/memory-storage-calculator.ts'
  ),
  'official-conformance-client-entry': 'src/official-conformance-client-entry.ts',
  'sqlite-query-host-entry': 'src/sqlite-query-host-entry.ts',
  'writer-worker': path.join(packagesRoot, 'indexer/src/writer-worker.ts'),
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
  plugins: [workspaceSourceBundling],
  splitting: true,
};

/**
 * The state-store writer worker is plain ESM (`.mjs`) that state-store names
 * beside its own module, so its bundled entry keeps that extension.
 * @type {import('esbuild').BuildOptions}
 */
export const STATE_STORE_WRITER_BUILD_OPTIONS = {
  ...shared,
  banner: ESM_REQUIRE_BANNER,
  entryPoints: { 'writer-worker': path.join(packagesRoot, 'state-store/src/writer-worker.mjs') },
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  plugins: [workspaceSourceBundling],
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
  plugins: [workspaceSourceBundling],
};

/**
 * The sandboxed preloads: CommonJS that requires nothing but `electron`
 * (preload-bundle-contract.mjs).
 * @type {import('esbuild').BuildOptions}
 */
export const PRELOAD_BUILD_OPTIONS = {
  ...shared,
  entryPoints: { 'hidden-preload': 'src/hidden-preload.ts', preload: 'src/preload.ts' },
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  plugins: [workspaceSourceBundling],
};

/**
 * dist/windows-command-entry.cjs, the trusted Windows command wrapper. It inlines
 * every package; only the native Job addon stays a runtime require.
 * @type {import('esbuild').BuildOptions}
 */
export const WINDOWS_COMMAND_BUILD_OPTIONS = {
  ...shared,
  entryPoints: { 'windows-command-entry': 'src/windows-command-entry.ts' },
  external: ['@brainstrike/windows-job-native'],
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  packages: 'bundle',
};

/**
 * Every Node-side build, in order. build-main.mjs emits each one, then its
 * inference gate scans all of them (BST-2148); nothing Node loads is emitted later.
 */
export const NODE_BUILDS = [
  NODE_PROCESS_BUILD_OPTIONS,
  STATE_STORE_WRITER_BUILD_OPTIONS,
  UNPACKED_WORKER_BUILD_OPTIONS,
  PRELOAD_BUILD_OPTIONS,
  WINDOWS_COMMAND_BUILD_OPTIONS,
];
