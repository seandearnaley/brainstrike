import path from 'node:path';

/**
 * Conventions every Node bundle of workspace code shares: desktop's app build,
 * the kept-built verification packages, and the suite-time bundles tests run.
 * Workspace packages export their source, so a bundle compiles them; Node never
 * loads a workspace package's own files.
 */

/** node-gyp builds these; their binaries load from the package at runtime. */
export const NATIVE_WORKSPACE_PACKAGES: readonly string[] = [
  '@brainstrike/secure-fs-native',
  '@brainstrike/windows-job-native',
];

/** A workspace import a bundle compiles from source (every one but the native add-ons). */
export function isBundledWorkspaceImport(specifier: string): boolean {
  return (
    specifier.startsWith('@brainstrike/') &&
    !NATIVE_WORKSPACE_PACKAGES.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`)
    )
  );
}

/**
 * An esbuild plugin (structurally typed; no esbuild import here): bundle workspace
 * packages from source and keep every other bare import (third-party,
 * `electron`, `node:*`, the native add-ons) a runtime import resolved from the
 * bundling package's own dependencies.
 */
export const workspaceSourceBundling = {
  name: 'workspace-source-bundling',
  setup(build: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string }) => { external: true; path: string } | undefined
    ): void;
  }): void {
    build.onResolve({ filter: /^[^./#]/ }, (args) => {
      if (path.isAbsolute(args.path) || isBundledWorkspaceImport(args.path)) {
        return;
      }
      return { external: true, path: args.path };
    });
  },
};

/**
 * Worker and module entries that workspace packages name beside their own
 * module (`new URL('./writer-worker.js', import.meta.url)`) and Node loads by
 * path. A Node bundle of workspace code emits each one beside its chunks, so
 * every sibling a bundled package names resolves to its bundled entry. Each
 * name is unique across the workspace: two packages naming the same sibling
 * would collide in one bundle directory.
 */
export function nodeRuntimeEntryPoints(packagesRoot: string): Record<string, string> {
  return {
    'host-state-index-worker': path.join(packagesRoot, 'agent-host/src/host-state-index-worker.ts'),
    'keyring-native-entry': path.join(packagesRoot, 'agent-host/src/adapters/keyring-native-entry.ts'),
    'memory-storage-calculator': path.join(
      packagesRoot,
      'agent-host/src/adapters/memory-storage-calculator.ts'
    ),
    'state-projection': path.join(packagesRoot, 'agent-host/src/state-projection.ts'),
    'writer-worker': path.join(packagesRoot, 'indexer/src/writer-worker.ts'),
  };
}

/**
 * The state-store writer worker is plain ESM that state-store names beside
 * itself as `./writer-worker.mjs`, so a bundle emits it with that extension
 * (it cannot share the `writer-worker` name with the indexer's `.js` worker).
 */
export function stateStoreWriterWorkerEntry(packagesRoot: string): string {
  return path.join(packagesRoot, 'state-store/src/writer-worker.mjs');
}

/**
 * Workspace source may call `require` (through `createRequire` or a dependency's
 * CommonJS interop); give every ESM output a real one.
 */
export const ESM_REQUIRE_BANNER = {
  js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
};

/**
 * esbuild options (structurally typed) for a kept-built Node bundle that runs
 * the agent host: its entries and every runtime entry beside them in one
 * code-split build, so the entries one process loads share each module, plus
 * the state-store writer worker. Third-party imports resolve from the bundling
 * package's own dependencies.
 */
export function agentHostNodeBundles(options: {
  readonly absWorkingDir: string;
  readonly entryPoints: Readonly<Record<string, string>>;
  readonly outdir: string;
  readonly packagesRoot: string;
}): readonly Record<string, unknown>[] {
  const shared = {
    absWorkingDir: options.absWorkingDir,
    banner: ESM_REQUIRE_BANNER,
    bundle: true,
    format: 'esm',
    logLevel: 'warning',
    outdir: options.outdir,
    platform: 'node',
    plugins: [workspaceSourceBundling],
    target: 'node24',
    tsconfigRaw: '{}',
  };
  return [
    {
      ...shared,
      chunkNames: '[name]-[hash]',
      entryPoints: { ...nodeRuntimeEntryPoints(options.packagesRoot), ...options.entryPoints },
      splitting: true,
    },
    {
      ...shared,
      entryPoints: { 'writer-worker': stateStoreWriterWorkerEntry(options.packagesRoot) },
      outExtension: { '.js': '.mjs' },
    },
  ];
}
