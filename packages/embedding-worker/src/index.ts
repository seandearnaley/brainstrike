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

/**
 * Resolve the module worker URL that Vite/Rspack can turn into a `Worker` reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 * Source: https://developer.mozilla.org/docs/Web/API/Worker/Worker#syntax
 */
export function resolveEmbeddingWorkerUrl(): URL {
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    return new URL('./embedding.worker.js', import.meta.url);
  }
  if (typeof import.meta.dirname === 'string') {
    return new URL('./embedding.worker.js', `file://${import.meta.dirname}/`);
  }
  throw new Error('Unable to resolve embedding worker URL in this runtime');
}
