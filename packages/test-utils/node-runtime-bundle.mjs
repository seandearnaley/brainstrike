// Vitest aliases to a Node bundle of workspace source, for suites that drive
// real processes and workers.
//
// Workspace packages name their worker and process entries beside their own
// module (`new URL('./writer-worker.js', import.meta.url)`), and Node loads
// those by path. A bundle emits every such entry beside its chunks, exactly as
// the desktop app ships them, so a suite runs that layout with no package
// build. It is built from source each time the config loads; there is no
// artifact for a cache to replay.
//
// Plain `.mjs` (no build step): Vitest configs load it in Node.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  nodeRuntimeEntryPoints,
  stateStoreWriterWorkerEntry,
} from '@brainstrike/config/node-runtime-entries';
import { build } from 'esbuild';

const packagesRoot = path.resolve(import.meta.dirname, '..');
const NATIVE_WORKSPACE_PACKAGES = ['@brainstrike/secure-fs-native', '@brainstrike/windows-job-native'];
const PINNING = Symbol('node-runtime-bundle.pinning');
const CREATE_REQUIRE_FROM_MODULE = /createRequire\(\s*import\.meta\.url\s*\)/g;
const SOURCE_FILE = /\.(?:[cm]?ts|tsx|mjs)$/;
const SOURCE_LOADERS = { '.cts': 'ts', '.mjs': 'js', '.mts': 'ts', '.ts': 'ts', '.tsx': 'tsx' };

function isBundledWorkspaceImport(specifier) {
  return (
    specifier.startsWith('@brainstrike/') &&
    !NATIVE_WORKSPACE_PACKAGES.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`)
    )
  );
}

/**
 * Workspace packages are bundled from source. Every other import stays
 * external, pinned to the exact file this checkout resolves it to, so the
 * bundle and the suite share third-party modules wherever they sit on disk.
 * @type {import('esbuild').Plugin}
 */
const pinnedExternals = {
  name: 'pinned-externals',
  setup(builder) {
    builder.onResolve({ filter: /^[^./#]/ }, async (args) => {
      if (args.pluginData?.[PINNING] || path.isAbsolute(args.path)) {
        return;
      }
      if (isBuiltin(args.path) || args.path === 'electron') {
        return { external: true, path: args.path };
      }
      if (isBundledWorkspaceImport(args.path)) {
        return;
      }
      const resolved = await builder.resolve(args.path, {
        importer: args.importer,
        kind: args.kind,
        pluginData: { [PINNING]: true },
        resolveDir: args.resolveDir,
      });
      if (resolved.errors.length > 0) {
        return { errors: resolved.errors };
      }
      return { external: true, path: pathToFileURL(resolved.path).href };
    });
    // `createRequire(import.meta.url)` resolves add-ons and packages from the
    // module's own location at runtime; keep that location the source file's.
    // Sibling-entry URLs stay relative to the bundle.
    builder.onLoad({ filter: SOURCE_FILE }, (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) {
        return;
      }
      const source = readFileSync(args.path, 'utf8');
      if (!source.includes('createRequire(')) {
        return;
      }
      return {
        contents: source.replace(
          CREATE_REQUIRE_FROM_MODULE,
          `createRequire(${JSON.stringify(pathToFileURL(args.path).href)})`
        ),
        loader: SOURCE_LOADERS[path.extname(args.path)],
        resolveDir: path.dirname(args.path),
      };
    });
  },
};

function entryName(specifier) {
  return specifier.replace(/^@/, '').replaceAll('/', '-');
}

/**
 * Bundle `entries` (public specifier -> source file) with every workspace
 * runtime entry beside them, and return exact Vitest aliases to the bundle.
 * `extraEntries` adds entries one suite's code names beside itself that would
 * collide across packages (each package's `process-entry.js`).
 * @param {{
 *   readonly consumerDir: string;
 *   readonly entries: Readonly<Record<string, string>>;
 *   readonly extraEntries?: Readonly<Record<string, string>>;
 * }} options
 */
export async function nodeRuntimeBundleAliases({ consumerDir, entries, extraEntries = {} }) {
  const cacheRoot = path.join(consumerDir, 'node_modules', '.cache', 'brainstrike-node-runtime');
  mkdirSync(cacheRoot, { recursive: true });
  const outdir = mkdtempSync(path.join(cacheRoot, 'bundle-'));
  process.once('exit', () => rmSync(outdir, { force: true, recursive: true }));
  const shared = {
    banner: {
      js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
    },
    bundle: true,
    format: 'esm',
    logLevel: 'warning',
    outdir,
    platform: 'node',
    plugins: [pinnedExternals],
    target: 'node24',
    tsconfigRaw: '{}',
  };
  await Promise.all([
    build({
      ...shared,
      chunkNames: '[name]-[hash]',
      entryPoints: {
        ...Object.fromEntries(
          Object.entries(entries).map(([specifier, source]) => [entryName(specifier), source])
        ),
        ...nodeRuntimeEntryPoints(packagesRoot),
        ...extraEntries,
      },
      splitting: true,
    }),
    build({
      ...shared,
      entryPoints: { 'writer-worker': stateStoreWriterWorkerEntry(packagesRoot) },
      outExtension: { '.js': '.mjs' },
    }),
  ]);
  return Object.keys(entries).map((specifier) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`),
    replacement: path.join(outdir, `${entryName(specifier)}.js`),
  }));
}
