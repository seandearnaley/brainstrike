/**
 * Pure config for the bundled main-process build — no esbuild import, so the
 * unit test (src/__tests__/build-main-config.test.ts) can pin the contract
 * without loading esbuild inside the jsdom test environment.
 *
 * Output layout is a runtime contract:
 * - dist/main.js            small package.json "main" bootstrap
 * - dist/main-runtime.js    full Main, loaded after utility fork
 * - dist/desktop-*.js       shared bootstrap/profile process owners
 * - dist/lifecycle-delay-seam.js  Main's one E2E delay seam, shared by every Main bundle
 * - dist/preload.js         visible BrowserWindow preload
 * - dist/hidden-preload.js  role-selected hidden renderer capability manifest
 * - dist/host-lease-entry.js  shared root-discovery utility process
 * - dist/main-log-transport.js  Pino worker target, unpacked beside app.asar
 * - dist/main-watchdog-worker.js  freeze watchdog, unpacked beside app.asar
 * - dist/windows-command-entry.js  self-contained Windows command wrapper
 *
 * This single-file-per-entry-point (`bundle: true`) output is why resolving
 * a sibling output file from the running bundled module's own on-disk path
 * is safe: the file that's actually running always sits directly in
 * `dist/`, regardless of how Electron was launched. That's load-bearing
 * (BST-1459 — `app.getAppPath()` returns launch-mode-dependent values and
 * cannot substitute for this) at every call site consolidated into
 * `apps/desktop/src/bundled-sibling-path.ts` (see its docblock for why it
 * uses `__filename`, not `module.filename` — empty under Vitest's module
 * transform — or `import.meta.filename` — empty in this esbuild `cjs`
 * output), among them:
 * - `resolveMainWatchdogWorkerPath` (diagnostics/main-watchdog-path.ts)
 * - `resolveMainLogTransportPath` (diagnostics/main-log-transport-path.ts)
 * - `resolveDesktopPythonRuntimeResourcesDir` (python-runtime/resources-dir.ts) —
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
  'agent-egress-entry': 'src/agent-egress-entry.ts',
  'agent-host-entry': 'src/agent-host-entry.ts',
  'desktop-bootstrap-runtime': 'src/desktop-bootstrap-runtime.ts',
  'desktop-database-location': 'src/desktop-database-location.ts',
  'desktop-env': 'src/desktop-env.ts',
  'desktop-shutdown-state': 'src/desktop-shutdown-state.ts',
  'hidden-preload': 'src/hidden-preload.ts',
  'host-lease-entry': 'src/host-lease-entry.ts',
  'indexer-host-entry': 'src/indexer-host-entry.ts',
  'lifecycle-delay-seam': 'src/lifecycle-delay-seam.ts',
  main: 'src/main-bootstrap.ts',
  'main-log-transport': 'src/diagnostics/main-log-transport.ts',
  'main-runtime': 'src/main.ts',
  'main-watchdog-worker': 'src/diagnostics/main-watchdog-worker.ts',
  preload: 'src/preload.ts',
  'sqlite-query-host-entry': 'src/sqlite-query-host-entry.ts',
};

/** Each existing process-wide owner is emitted once, shared by bootstrap and Main. */
const sharedMainModules = new Map(
  [
    ['main', 'main-runtime'],
    ['desktop-bootstrap-runtime', 'desktop-bootstrap-runtime'],
    ['desktop-database-location', 'desktop-database-location'],
    ['desktop-env', 'desktop-env'],
    ['desktop-shutdown-state', 'desktop-shutdown-state'],
    ['lifecycle-delay-seam', 'lifecycle-delay-seam'],
  ].map(([source, output]) => [path.join(appRoot, 'src', `${source}.ts`), output])
);

/** @type {import('esbuild').Plugin} */
const sharedMainOwners = {
  name: 'shared-main-owners',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (args) => {
      const source = path.resolve(args.resolveDir, args.path).replace(/\.js$/, '');
      const output = sharedMainModules.get(`${source}.ts`);
      if (!output) {
        return;
      }
      return { external: true, path: `./${output}.js` };
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
export const MAIN_PROCESS_BUILD_OPTIONS = {
  absWorkingDir: appRoot,
  // Narrow exceptions to packages:'external' (aliases are applied before
  // external classification):
  // - @brainstrike/assistant-data is ESM-only. Main inlines the canonical
  //   history-mapper and memory-resource subpaths from source rather than
  //   requiring an export Node cannot execute from this CJS bundle.
  // - @brainstrike/workspace-search/core is a browser ESM barrel with
  //   extensionless relative imports. Inline this exact public subpath for
  //   the native assistant consumer; retain the shared fusion implementation.
  alias: {
    '@brainstrike/assistant-data/assistant-memory-repository': path.resolve(
      appRoot,
      '../../packages/assistant-data/src/assistant-memory-repository.ts'
    ),
    // The host platform entry acquires memory vectors for this resource (BST-1928).
    '@brainstrike/assistant-data/assistant-memory-resource': path.resolve(
      appRoot,
      '../../packages/assistant-data/src/assistant-memory-resource.ts'
    ),
    // Shared request parsing is pure and must be bundled into the sandbox preload.
    '@brainstrike/types/catalog-args': path.resolve(
      appRoot,
      '../../packages/types/src/catalog-args/index.ts'
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
  // runtime resolution (native modules) and duplicate prebuilt workspace
  // bundles. Only relative app code is bundled.
  packages: 'external',
  platform: 'node',
  plugins: [sharedMainOwners],
  sourcemap: false,
  // Electron 43 ships Node 24.
  target: 'node24',
  // Do NOT let esbuild pick up apps/desktop/tsconfig.json: it configures the
  // renderer's type-check, not this Node bundle. Bare imports stay external and
  // resolve at runtime exactly like the previous tsc output.
  tsconfigRaw: '{}',
};

/**
 * The platform shares the Node kernel's ESM dependencies. Emitting CJS here
 * loads a second agent/Mastra runtime through their conditional exports.
 * Its utility launcher stays CJS so compile caching precedes all host imports.
 * Main and both sandboxed preloads retain their existing CJS contract.
 * @type {import('esbuild').BuildOptions}
 */
export const AGENT_HOST_PLATFORM_BUILD_OPTIONS = {
  ...MAIN_PROCESS_BUILD_OPTIONS,
  chunkNames: '[name]-[hash]',
  define: { __dirname: 'import.meta.dirname', __filename: 'import.meta.filename' },
  entryPoints: { 'agent-host-platform-entry': 'src/agent-host-platform-entry.ts' },
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  plugins: [],
  splitting: true,
};

/**
 * dist/windows-command-entry.js, the trusted Windows command wrapper. It inlines
 * every package; only the native Job addon stays a runtime require.
 * @type {import('esbuild').BuildOptions}
 */
export const WINDOWS_COMMAND_BUILD_OPTIONS = {
  absWorkingDir: appRoot,
  bundle: true,
  entryPoints: { 'windows-command-entry': 'src/windows-command-entry.ts' },
  external: ['@brainstrike/windows-job-native'],
  format: 'cjs',
  logLevel: 'info',
  outdir: path.join(appRoot, 'dist'),
  packages: 'bundle',
  platform: 'node',
  target: 'node24',
  tsconfigRaw: '{}',
};

/**
 * Every Node-side build, in order. build-main.mjs emits each one, then its
 * inference gate scans all of them (BST-2148); nothing Node loads is emitted later.
 */
export const NODE_BUILDS = [
  MAIN_PROCESS_BUILD_OPTIONS,
  AGENT_HOST_PLATFORM_BUILD_OPTIONS,
  WINDOWS_COMMAND_BUILD_OPTIONS,
];
