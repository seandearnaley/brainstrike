import {
  assertModelCacheStatusRequest,
  assertModelCacheStatusResponse,
  EMBED_WORKER_INSTANCE_NAME_PREFIX,
  type ModelCachePlan,
  type ModelCacheStatusRequest,
  type ModelCacheStatusResponse,
} from '@brainstrike/indexing-contract';

/** Transformers.js's `ModelRegistry`, as much of it as the cache check reads. */
export interface ModelCacheRegistry {
  // biome-ignore lint/style/useNamingConvention: Transformers.js ModelRegistry is the vendor API.
  is_pipeline_cached(
    task: 'feature-extraction',
    modelId: string,
    options: { readonly device: string; readonly dtype: string; readonly revision?: string }
  ): Promise<boolean>;
}

/**
 * BST-2241, in the embedding worker: whether each plan's files are all in this
 * realm's model cache, by Transformers.js's own file list for the plan. It reads
 * the cache only; nothing is fetched or loaded.
 */
export async function answerModelCacheStatus(
  value: unknown,
  loadRegistry: () => Promise<ModelCacheRegistry>,
  post: (response: ModelCacheStatusResponse) => void
): Promise<void> {
  const id = value && typeof value === 'object' ? Reflect.get(value, 'id') : undefined;
  let request: ModelCacheStatusRequest;
  try {
    request = assertModelCacheStatusRequest(value);
  } catch (error) {
    if (typeof id === 'string' && id.length > 0) {
      post({ id, message: messageOf(error), type: 'model-cache-status-error' });
    }
    return;
  }
  try {
    const registry = await loadRegistry();
    const cached = await Promise.all(
      request.plans.map((plan) =>
        registry.is_pipeline_cached('feature-extraction', plan.modelId, {
          device: plan.device,
          dtype: plan.dtype,
          ...(plan.revision === undefined ? {} : { revision: plan.revision }),
        })
      )
    );
    post({ cached, id: request.id, type: 'model-cache-status-result' });
  } catch (error) {
    post({ id: request.id, message: messageOf(error), type: 'model-cache-status-error' });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

const MODEL_CACHE_STATUS_TIMEOUT_MS = 30_000;

/**
 * Asks a short-lived embedding worker, in the caller's realm, which plans are
 * fully cached. The worker is the realm that downloads and indexes, so its
 * cache is the one that counts; it is terminated once it answers.
 */
export async function readModelCacheStatus(
  workerUrl: string | URL,
  plans: readonly ModelCachePlan[],
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}
): Promise<readonly boolean[]> {
  options.signal?.throwIfAborted();
  if (plans.length === 0) {
    return [];
  }
  const request: ModelCacheStatusRequest = {
    id: crypto.randomUUID(),
    plans,
    type: 'model-cache-status',
  };
  // The worker refuses a name outside its managed identity contract.
  const worker = new Worker(workerUrl, {
    name: `${EMBED_WORKER_INSTANCE_NAME_PREFIX}model-cache-${request.id}`,
    type: 'module',
  });
  try {
    return await new Promise<readonly boolean[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The embedding worker did not report its model cache in time.')),
        options.timeoutMs ?? MODEL_CACHE_STATUS_TIMEOUT_MS
      );
      const settle = (): void => clearTimeout(timer);
      options.signal?.addEventListener(
        'abort',
        () => {
          settle();
          reject(options.signal?.reason);
        },
        { once: true }
      );
      worker.addEventListener('error', (event) => {
        settle();
        reject(new Error(`The embedding worker failed: ${event.message || 'unknown error'}`));
      });
      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        const data: unknown = event.data;
        // The worker's other traffic is not this answer: workerpool's 'ready', and its
        // "unknown method" reply, which echoes this request's id.
        if (!(data && typeof data === 'object')) {
          return;
        }
        const type = Reflect.get(data, 'type');
        if (
          Reflect.get(data, 'id') !== request.id ||
          !(type === 'model-cache-status-result' || type === 'model-cache-status-error')
        ) {
          return;
        }
        settle();
        try {
          const response = assertModelCacheStatusResponse(data, request);
          if (response.type === 'model-cache-status-error') {
            reject(new Error(response.message));
            return;
          }
          resolve(response.cached);
        } catch (error) {
          reject(error);
        }
      });
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}
