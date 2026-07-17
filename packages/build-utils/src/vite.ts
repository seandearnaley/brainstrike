import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HmrContext, Plugin } from 'vite';
import { createBuildLogger } from './build-logger';
import { isCompilerHotspot } from './compiler-hotspots';

// @ts-expect-error: process.env has index signature
const isDev = process.env.NODE_ENV === 'development';
const logger = createBuildLogger('PGliteLocator');

/**
 * Co-locate the whole context-action / command system into ONE chunk.
 *
 * `defineContextAction` (packages/context-actions) and `defineCommand`
 * (packages/commands) are pure identity helpers, but the feature
 * `*​/context-actions` modules CALL them at MODULE-INIT to build their action
 * arrays (e.g. `const actions = [defineContextAction({ id: 'file.copy-name' })]`).
 * Rolldown's default chunking hoists the shared helper into its own chunk,
 * separate from its eager callers; the caller chunk then runs `helper(...)` at
 * init before the helper chunk has initialized → a circular chunk-init TDZ
 * ("k is not a function") that leaves the BUILT renderer with an empty #root on
 * startup. Dev is unaffected (Vite serves unbundled ESM, native init order).
 * Forcing a single chunk removes the cross-chunk init-order hazard. Source
 * aliasing alone does NOT fix it — rolldown still splits the shared helper out
 * for dedup. Do NOT remove without re-verifying the built apps mount
 * (apps/web/e2e @web-smoke + desktop e2e smoke).
 *
 * This is intentionally the ONLY manual code-splitting group. A previous
 * blanket `node_modules → vendor` group (plus assistant vendor groups) merged
 * lazily-imported libraries (mermaid, d3, katex, codemirror, shiki, lodash-es)
 * into eagerly-loaded chunks — rolldown group chunks absorb matched modules'
 * shared dependencies, so react itself ended up inside the "markdown vendor"
 * chunk and the entry statically imported all of it. Default reachability-based
 * splitting keeps dynamic-import-only code off the startup critical path.
 */
export function isContextActionSystemModule(id: string): boolean {
  if (id.includes('node_modules')) {
    return false;
  }
  // Matches the core package (…/context-actions/src/…), every feature
  // …/src/context-actions/… module that calls defineContextAction at init, and
  // the commands registry that shares the same define-at-init pattern.
  return /[\\/]context-actions[\\/]/.test(id) || /[\\/]packages[\\/]commands[\\/]/.test(id);
}

const CORE_APP_OPTIMIZE_DEPS_INCLUDE = [
  'idb',
  'minimatch',
  'pino',
  'react-helmet-async',
  'react-hotkeys-hook',
  'react-router-dom',
  'tiktoken',
  'tiktoken/lite/init',
  'xxhash-wasm',
  'zod',
  'zustand/shallow',
  '@radix-ui/react-accordion',
  '@radix-ui/react-checkbox',
  '@radix-ui/react-dialog',
  '@radix-ui/react-scroll-area',
  '@radix-ui/react-tabs',
  '@radix-ui/react-toast',
] as const;

const ASSISTANT_OPTIMIZE_DEPS_INCLUDE = [
  '@assistant-ui/react',
  '@assistant-ui/react-data-stream',
  '@assistant-ui/react-markdown',
  'react-shiki/core',
  'remark-gfm',
  'shiki/wasm',
  '@shikijs/themes/github-light',
  '@shikijs/themes/github-dark',
  '@shikijs/langs/bash',
  '@shikijs/langs/css',
  '@shikijs/langs/diff',
  '@shikijs/langs/go',
  '@shikijs/langs/html',
  '@shikijs/langs/javascript',
  '@shikijs/langs/json',
  '@shikijs/langs/jsx',
  '@shikijs/langs/markdown',
  '@shikijs/langs/python',
  '@shikijs/langs/rust',
  '@shikijs/langs/sql',
  '@shikijs/langs/toml',
  '@shikijs/langs/tsx',
  '@shikijs/langs/typescript',
  '@shikijs/langs/yaml',
] as const;

const DATABASE_OPTIMIZE_DEPS_INCLUDE = ['jszip', 'file-saver', 'react-resizable-panels'] as const;

const HEAVY_RUNTIME_OPTIMIZE_DEPS_EXCLUDE = ['@huggingface/transformers'] as const;

const moduleDir =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url));
// This helper is intentionally monorepo-only: the app Vite configs must point at the
// workspace source entries so Vite owns the emitted lazy chunks. Do not repurpose this
// for published/node_modules consumption without reworking the path contract.
const appShellDir = path.resolve(moduleDir, '..', '..', 'app-shell', 'src');
const uiDir = path.resolve(moduleDir, '..', '..', 'ui', 'src');
const dbExplorerDir = path.resolve(moduleDir, '..', '..', 'db-explorer', 'src');

export function getAssistantOptimizeDepsInclude(): readonly string[] {
  return ASSISTANT_OPTIMIZE_DEPS_INCLUDE;
}

export function getCoreAppOptimizeDepsInclude(): readonly string[] {
  return CORE_APP_OPTIMIZE_DEPS_INCLUDE;
}

export function getDatabaseOptimizeDepsInclude(): readonly string[] {
  return DATABASE_OPTIMIZE_DEPS_INCLUDE;
}

export function getHeavyRuntimeOptimizeDepsExclude(): readonly string[] {
  return HEAVY_RUNTIME_OPTIMIZE_DEPS_EXCLUDE;
}

export function getLazySurfaceOptimizeDepsEntries(
  appRoot: string,
  entryExists: (entry: string) => boolean = existsSync
): readonly string[] {
  const entries = [
    path.resolve(appRoot, 'index.html'),
    path.resolve(appShellDir, 'database-panel.tsx'),
    path.resolve(appShellDir, 'assistant-chat-panel.tsx'),
    path.resolve(appShellDir, 'assistant-ui-panel-wrapper-lazy.tsx'),
    path.resolve(appShellDir, 'assistant-ui-panel-wrapper.tsx'),
    path.resolve(appShellDir, 'database-tab.tsx'),
    path.resolve(uiDir, 'assistant-ui-panel', 'assistant-ui-panel.tsx'),
    path.resolve(uiDir, 'assistant-ui-panel', 'markdown-text.tsx'),
    path.resolve(appShellDir, 'database-tab-chunk.tsx'),
    path.resolve(dbExplorerDir, 'database-demo-panel.tsx'),
  ].map(toVitePath);

  for (const entry of entries) {
    if (!entryExists(entry)) {
      throw new Error(`Lazy-surface optimizeDeps entry does not exist: ${entry}`);
    }
  }

  return entries;
}

export function getWorkerpoolBrowserStubAliases(baseDir: string): Readonly<Record<string, string>> {
  const stubDir = path.resolve(baseDir, '../../packages/build-utils/src/browser-node-stubs');
  return Object.fromEntries([
    ['child_process', toVitePath(path.resolve(stubDir, 'child-process.ts'))],
    ['os', toVitePath(path.resolve(stubDir, 'os.ts'))],
    ['worker_threads', toVitePath(path.resolve(stubDir, 'worker-threads.ts'))],
  ]);
}

/**
 * Static-copy target for a vendored tree-sitter grammar `.wasm` file.
 * Shape matches `vite-plugin-static-copy`'s Target interface so the helper's
 * return value plugs straight into the `targets` array.
 *
 * The `rename: { stripBase: true }` field forces flat output: without it,
 * vite-plugin-static-copy preserves the source path beyond the workspace
 * root and the file ends up at `dist/assets/grammars/packages/
 * chunking-worker/grammars/python.wasm` instead of the expected
 * `dist/assets/grammars/python.wasm`. `stripBase: true` removes the entire
 * directory prefix, keeping just the basename.
 */
export interface TreeSitterGrammarCopyTarget {
  /** Output directory under the app's build `dist/` (the plugin handles the prefix). */
  readonly dest: string;
  /** Strip the source-path prefix so the file lands flat at `dest/<basename>`. */
  readonly rename: { readonly stripBase: true };
  /** Absolute path to the vendored grammar file in the monorepo. */
  readonly src: string;
}

/**
 * Tree-sitter languages whose grammars are vendored under
 * `packages/chunking-worker/grammars/`. Adding a language to the rollout
 * means adding it here + landing the matching `<lang>.wasm` file +
 * extending the chunking-worker's adapter.
 *
 * Phase 1 (#998) ships Python only. Follow-on PRDs add Rust, Go,
 * Markdown, etc. by extending this list.
 */
const VENDORED_TREE_SITTER_GRAMMARS = ['python'] as const;

/**
 * Build the static-copy target list for tree-sitter grammars.
 *
 * Both apps/web and apps/desktop call this from their vite configs so the
 * same grammar `.wasm` files ship to `dist/assets/grammars/<lang>.wasm`.
 * Centralizing here means future grammar additions don't require touching
 * each app's vite config — just extend `VENDORED_TREE_SITTER_GRAMMARS`.
 *
 * @param baseDir - the calling app's directory (`__dirname` from the
 *                  vite config). Path resolution mirrors `findPGliteWasm`:
 *                  `<baseDir>/../../packages/chunking-worker/grammars/<lang>.wasm`.
 * @returns Array of `{ src, dest, rename }` targets; pass directly into
 *          `viteStaticCopy({ targets: [...] })`.
 */
export function getTreeSitterGrammarCopyTargets(baseDir: string): TreeSitterGrammarCopyTarget[] {
  return VENDORED_TREE_SITTER_GRAMMARS.map((language) => ({
    dest: 'assets/grammars',
    rename: { stripBase: true },
    src: toVitePath(
      path.resolve(baseDir, '../../packages/chunking-worker/grammars', `${language}.wasm`)
    ),
  }));
}

function toVitePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

export function findPGliteWasm(baseDir: string): string | null {
  const possiblePaths = [
    path.resolve(baseDir, '../../node_modules/@electric-sql/pglite/dist/pglite.wasm'),
    path.resolve(baseDir, 'node_modules/@electric-sql/pglite/dist/pglite.wasm'),
  ];

  try {
    const pnpmDir = path.resolve(baseDir, '../../node_modules/.pnpm');
    if (existsSync(pnpmDir)) {
      const entries = readdirSync(pnpmDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('@electric-sql+pglite@')) {
          const wasmPath = path.join(
            pnpmDir,
            entry.name,
            'node_modules/@electric-sql/pglite/dist/pglite.wasm'
          );
          possiblePaths.push(wasmPath);
        }
      }
    }
  } catch {
    // ignore errors when scanning pnpm directory
  }

  for (const wasmPath of possiblePaths) {
    if (existsSync(wasmPath)) {
      const vitePath = toVitePath(wasmPath);
      if (isDev) {
        logger.debug('Found PGLite WASM', { wasmPath: vitePath });
      }
      return vitePath;
    }
  }

  logger.warn('PGLite WASM file not found in any expected location');
  return null;
}

export function fullReloadOnCompilerHotspots(): Plugin {
  return {
    handleHotUpdate(ctx: HmrContext) {
      if (isCompilerHotspot(ctx.file)) {
        ctx.server.ws.send({ type: 'full-reload' });
        return [];
      }
      return;
    },
    name: 'full-reload-on-compiler-hotspots',
  };
}
