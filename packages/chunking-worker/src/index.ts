/**
 * @brainstrike/chunking-worker
 *
 * Web Worker for off-main-thread file chunking with AST-aware code splitting and token counting.
 *
 * @example
 * ```ts
 * import { resolveChunkingWorkerUrl, type ChunkRequest, type ChunkResult } from '@brainstrike/chunking-worker';
 *
 * const worker = new Worker(resolveChunkingWorkerUrl(), { type: 'module' });
 *
 * worker.onmessage = (event) => {
 *   if (event.data.type === 'ready') {
 *     // Worker is ready
 *   } else if (event.data.type === 'result') {
 *     const result: ChunkResult = event.data;
 *     console.log('Chunks:', result.chunks);
 *   }
 * };
 *
 * worker.postMessage({
 *   type: 'chunk',
 *   id: 'request-1',
 *   fileRecordId: 'file-123',
 *   content: 'const x = 1;',
 *   fileName: 'example.ts',
 *   filePath: '/src/example.ts',
 *   options: { strategy: 'recursive' },
 * } satisfies ChunkRequest);
 * ```
 */

export type { CodeLanguage } from './chunking-config';

// Re-export chunking config for consumers
export { CHUNKING_CONFIG } from './chunking-config';
export type {
  ExtractedSymbols,
  PortableSymbol,
  PortableSymbolKind,
  PortableSymbolRef,
  PortableSymbolRefKind,
} from './extract-symbols';
// Re-export tree-sitter rollout bootstrap helper for app renderers.
// Apps call this at startup and assign the result to
// globalThis.__BRAINSTRIKE_TREE_SITTER_LANGUAGES__ (Phase 8 of #998).
export { resolveBootstrapTreeSitterLanguages } from './parsers/tree-sitter-rollout';
export type { ChunkSkipCode, PortableChunkingResult } from './portable-chunking';
// Re-export portable chunking for direct usage (if needed outside worker)
export { chunkContent } from './portable-chunking';
// Re-export shared types
export type {
  ChunkBatchRequest,
  ChunkError,
  ChunkingRequestOptions,
  ChunkingStrategy,
  ChunkProgress,
  ChunkRequest,
  ChunkResult,
  ChunkType,
  PortableChunk,
  WorkerLog,
  WorkerReady,
  WorkerRequest,
  WorkerResponse,
} from './shared';

interface ImportMetaLike {
  dirname?: string;
  url?: string;
}

function usesTypeScriptSource(url: string): boolean {
  return (
    url.endsWith('.ts') || url.endsWith('.tsx') || url.endsWith('.mts') || url.endsWith('.cts')
  );
}

function getSourceWorkerPath(path: string): string {
  return path.replace(/\.js$/, '.ts');
}

const IMPORT_META_OVERRIDE_KEY = '__BRAINSTRIKE_IMPORT_META__';

function readImportMetaOverride(): ImportMetaLike | null {
  const override = (globalThis as Record<string, unknown>)[IMPORT_META_OVERRIDE_KEY];
  if (!override || typeof override !== 'object') {
    return null;
  }
  const importMeta = override as ImportMetaLike;
  return importMeta;
}

function getImportMeta(): ImportMetaLike | null {
  const override = readImportMetaOverride();
  if (override) {
    return override;
  }
  if (typeof import.meta !== 'undefined') {
    return import.meta as ImportMetaLike;
  }
  return null;
}

function describeImportMeta(meta: ImportMetaLike | null): string {
  if (!meta) {
    return 'import.meta is undefined (CommonJS context?)';
  }
  const urlDescription =
    typeof meta.url === 'string' ? `import.meta.url: ${meta.url}` : 'import.meta.url is undefined';
  const dirnameDescription =
    typeof meta.dirname === 'string'
      ? `import.meta.dirname: ${meta.dirname}`
      : 'import.meta.dirname is undefined';
  return `${urlDescription}; ${dirnameDescription}`;
}

/**
 * Resolve the chunking worker URL that Vite/bundlers can turn into a `Worker` reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 * Source: https://developer.mozilla.org/docs/Web/API/Worker/Worker#syntax
 *
 * This follows the same pattern as @brainstrike/token-cache's resolveBackgroundIndexerWorkerUrl().
 * The worker TypeScript source is compiled to JavaScript by tsup during the package build.
 *
 * @example
 * ```ts
 * import { resolveChunkingWorkerUrl } from '@brainstrike/chunking-worker';
 *
 * const worker = new Worker(resolveChunkingWorkerUrl(), { type: 'module' });
 * ```
 */
export function resolveChunkingWorkerUrl(): URL {
  const override = readImportMetaOverride();
  if (override) {
    if (typeof override.url === 'string') {
      return usesTypeScriptSource(override.url)
        ? new URL(getSourceWorkerPath('./chunking.worker.js'), override.url)
        : new URL('./chunking.worker.js', override.url);
    }
    if (typeof override.dirname === 'string') {
      return new URL('./chunking.worker.js', `file://${override.dirname}/`);
    }
    const context = describeImportMeta(override);
    throw new Error(
      `Unable to resolve chunking worker URL in this runtime. Context: ${context}. ` +
        'This package must be imported as ESM, not CommonJS.'
    );
  }

  // Keep this literal form so bundlers rewrite to the emitted worker asset.
  if (typeof import.meta.url === 'string') {
    return usesTypeScriptSource(import.meta.url)
      ? new URL(getSourceWorkerPath('./chunking.worker.js'), import.meta.url)
      : new URL('./chunking.worker.js', import.meta.url);
  }

  // `import.meta.url` is always present in the ESM environments we test and ship.
  // This dirname-only fallback exists for unusual non-bundled runtimes and is not
  // practically exercisable under Vitest's ESM runner.
  /* v8 ignore next 10 */
  const meta = getImportMeta();
  if (meta && typeof meta.dirname === 'string') {
    return new URL('./chunking.worker.js', `file://${meta.dirname}/`);
  }

  const context = describeImportMeta(meta);
  throw new Error(
    `Unable to resolve chunking worker URL in this runtime. Context: ${context}. ` +
      'This package must be imported as ESM, not CommonJS.'
  );
}
