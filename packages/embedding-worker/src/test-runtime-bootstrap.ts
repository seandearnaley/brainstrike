export const EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY =
  '__brainstrikeEmbeddingWorkerTestRuntimeBootstrap__';
export const EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER =
  'bst-369-production-worker-runtime-v1';
export const EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION = 'webdriver-explicit-init';
export const EMBEDDING_WORKER_TEST_RUNTIME_PHASE_KEY =
  '__brainstrikeEmbeddingWorkerTestRuntimeBootstrapPhase__';

export interface EmbeddingWorkerTestRuntimeOverride {
  readonly runtime: unknown;
  readonly webGpuClassProxy: true;
}

interface EmbeddingWorkerTestRuntimeBootstrap {
  readonly automation: typeof EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION;
  readonly marker: typeof EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER;
  readonly takeRuntime: () => EmbeddingWorkerTestRuntimeOverride;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Consumes the fixed webdriver-only runtime installed by the BST-369 wrapper.
 *
 * Normal workers never define this worker-global property and therefore take
 * the real Transformers.js import path. The property is deleted before the
 * runtime factory runs, so a throwing or re-entrant factory cannot be retried
 * as a silent fallback.
 */
export function consumeEmbeddingWorkerTestRuntimeOverride(): EmbeddingWorkerTestRuntimeOverride | null {
  if (Reflect.has(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_PHASE_KEY)) {
    throw new Error('Embedding worker test runtime bootstrap window is already closed.');
  }
  Object.defineProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_PHASE_KEY, {
    configurable: true,
    enumerable: false,
    value: 'closed',
    writable: false,
  });
  const candidate = Reflect.get(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY);
  if (candidate === undefined) {
    return null;
  }
  if (
    !isRecord(candidate) ||
    candidate['marker'] !== EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER ||
    candidate['automation'] !== EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION ||
    typeof candidate['takeRuntime'] !== 'function'
  ) {
    throw new Error('Embedding worker test runtime bootstrap is malformed.');
  }
  if (!Reflect.deleteProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY)) {
    throw new Error('Embedding worker test runtime bootstrap could not be consumed.');
  }

  const override = (candidate as unknown as EmbeddingWorkerTestRuntimeBootstrap).takeRuntime();
  if (
    !isRecord(override) ||
    override['webGpuClassProxy'] !== true ||
    !isRecord(override['runtime'])
  ) {
    throw new Error('Embedding worker test runtime override is malformed.');
  }
  return override as unknown as EmbeddingWorkerTestRuntimeOverride;
}
