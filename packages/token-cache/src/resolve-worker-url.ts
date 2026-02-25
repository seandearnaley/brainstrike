/**
 * Resolve the token cache worker URL that Vite/bundlers can turn into a `Worker` reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 * Source: https://developer.mozilla.org/docs/Web/API/Worker/Worker#syntax
 *
 * This follows the same pattern as @brainstrike/embedding-worker's resolveEmbeddingWorkerUrl().
 * The worker TypeScript source is compiled to JavaScript by tsup during the package build.
 */
interface ImportMetaLike {
  dirname?: string;
  url?: string;
}

function readImportMetaOverride(): ImportMetaLike | null {
  const override = (globalThis as { __BRAINSTRIKE_IMPORT_META__?: ImportMetaLike })
    .__BRAINSTRIKE_IMPORT_META__;
  return override ?? null;
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

function createResolutionError(workerName: string, meta: ImportMetaLike | null): Error {
  const context = describeImportMeta(meta);
  return new Error(
    `Unable to resolve ${workerName} worker URL in this runtime. Context: ${context}. ` +
      'This package must be imported as ESM, not CommonJS.'
  );
}

function resolveWorkerUrl(workerPath: string, workerName: string): URL {
  const meta = getImportMeta();
  if (meta && typeof meta.url === 'string') {
    return new URL(workerPath, meta.url);
  }
  if (meta && typeof meta.dirname === 'string') {
    return new URL(workerPath, `file://${meta.dirname}/`);
  }
  throw createResolutionError(workerName, meta);
}

export function resolveTokenCacheWorkerUrl(): URL {
  return resolveWorkerUrl('./token-cache.worker.js', 'token cache');
}

/**
 * Resolve the background indexer worker URL that Vite/bundlers can turn into a `Worker` reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 * Source: https://developer.mozilla.org/docs/Web/API/Worker/Worker#syntax
 *
 * This follows the same pattern as @brainstrike/embedding-worker's resolveEmbeddingWorkerUrl().
 * The worker TypeScript source is compiled to JavaScript by tsup during the package build.
 */
export function resolveBackgroundIndexerWorkerUrl(): URL {
  return resolveWorkerUrl('./background-indexer.worker.js', 'background indexer');
}
