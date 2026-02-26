export type {
  EmbeddingDevice,
  EmbeddingDeviceHint,
  EmbeddingDType,
  EmbedWorkerError,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerSuccess,
} from './shared';

export {
  cloneAsFloat32,
  computeInitialBatchSize,
  l2Normalize,
  truncateVector,
  vectorsFromPipelineOutput,
} from './shared';

interface ImportMetaLike {
  dirname?: string;
  url?: string;
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
 * Resolve the module worker URL that Vite/Rspack can turn into a `Worker` reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 * Source: https://developer.mozilla.org/docs/Web/API/Worker/Worker#syntax
 */
export function resolveEmbeddingWorkerUrl(): URL {
  const override = readImportMetaOverride();
  if (override) {
    if (typeof override.url === 'string') {
      return new URL('./embedding.worker.js', override.url);
    }
    if (typeof override.dirname === 'string') {
      return new URL('./embedding.worker.js', `file://${override.dirname}/`);
    }
    const context = describeImportMeta(override);
    throw new Error(
      `Unable to resolve embedding worker URL in this runtime. Context: ${context}. ` +
        'This package must be imported as ESM, not CommonJS.'
    );
  }

  // Keep this literal form so bundlers rewrite to the emitted worker asset.
  if (typeof import.meta.url === 'string') {
    return new URL('./embedding.worker.js', import.meta.url);
  }

  const meta = getImportMeta();
  if (meta && typeof meta.dirname === 'string') {
    return new URL('./embedding.worker.js', `file://${meta.dirname}/`);
  }

  const context = describeImportMeta(meta);
  throw new Error(
    `Unable to resolve embedding worker URL in this runtime. Context: ${context}. ` +
      'This package must be imported as ESM, not CommonJS.'
  );
}
