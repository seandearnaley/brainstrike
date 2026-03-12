import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, isCompilerHotspot } from '@brainstrike/utils';
import type { HmrContext, Plugin } from 'vite';

// @ts-expect-error: process.env has index signature
const isDev = process.env.NODE_ENV === 'development';
const logger = createLogger('PGliteLocator');

const ASSISTANT_MARKDOWN_VENDOR_MATCHERS = [
  '/@assistant-ui/react-markdown/',
  '/react-shiki/',
  '/@shikijs/',
  '/shiki/',
  '/remark-gfm/',
] as const;

const ASSISTANT_VENDOR_MATCHERS = [
  '/@assistant-ui/react-data-stream/',
  '/@assistant-ui/react/',
  '/@assistant-ui/styles/',
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

const moduleDir =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : path.dirname(fileURLToPath(import.meta.url));
const uiPackageRequire = createRequire(path.resolve(moduleDir, '..', '..', 'ui', 'package.json'));
const dbExplorerPackageRequire = createRequire(
  path.resolve(moduleDir, '..', '..', 'db-explorer', 'package.json')
);
const appShellDir = path.resolve(moduleDir, '..', '..', 'app-shell', 'src');

function resolveOptimizeDepEntries(
  packageRequire: NodeJS.Require,
  specifiers: readonly string[]
): readonly string[] {
  return specifiers.map((specifier) => packageRequire.resolve(specifier));
}

export function resolveAssistantVendorChunk(
  id: string
): 'assistant-markdown-vendor' | 'assistant-vendor' | undefined {
  if (ASSISTANT_MARKDOWN_VENDOR_MATCHERS.some((matcher) => id.includes(matcher))) {
    return 'assistant-markdown-vendor';
  }

  if (ASSISTANT_VENDOR_MATCHERS.some((matcher) => id.includes(matcher))) {
    return 'assistant-vendor';
  }

  return;
}

export function getAssistantOptimizeDepsInclude(): readonly string[] {
  return resolveOptimizeDepEntries(uiPackageRequire, ASSISTANT_OPTIMIZE_DEPS_INCLUDE);
}

export function getDatabaseOptimizeDepsInclude(): readonly string[] {
  return resolveOptimizeDepEntries(dbExplorerPackageRequire, DATABASE_OPTIMIZE_DEPS_INCLUDE);
}

export function getLazySurfaceOptimizeDepsEntries(appRoot: string): readonly string[] {
  return [
    path.resolve(appRoot, 'index.html'),
    path.resolve(appShellDir, 'assistant-ui-panel-wrapper.tsx'),
    path.resolve(appShellDir, 'database-tab-chunk.tsx'),
  ];
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
      if (isDev) {
        logger.debug('Found PGLite WASM', { wasmPath });
      }
      return wasmPath;
    }
  }

  logger.warn('PGLite WASM file not found in any expected location');
  return null;
}

export function fullReloadOnCompilerHotspots(): Plugin {
  return {
    name: 'full-reload-on-compiler-hotspots',
    handleHotUpdate(ctx: HmrContext) {
      if (isCompilerHotspot(ctx.file)) {
        ctx.server.ws.send({ type: 'full-reload' });
        return [];
      }
      return;
    },
  };
}
