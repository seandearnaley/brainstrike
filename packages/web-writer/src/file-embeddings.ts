/**
 * The web file index's local document embeddings (BST-1940; owner decision,
 * 16 Oct: the index worker runs its own embedder). They run on desktop's
 * embedding stack: `SimpleEmbeddingService` loads a collection's pinned plan
 * through the browser embedding queue, whose workerpool runs the embedding
 * worker the tab names, as workers of the index worker's own. Inference never
 * runs in the index worker itself.
 *
 * One plan is loaded at a time, and a different plan replaces it. Calls run
 * one after another, so a plan is never replaced under a call that uses it.
 */
import type { CanonicalDocumentEmbeddingsPayload } from '@brainstrike/canonical-ingestion/browser';
import { embeddingWorkerTelemetrySink } from '@brainstrike/embedding-worker';
import { assertPinnedPlanResult, pinnedPlanModelConfig } from '@brainstrike/embeddings/pinned-plan';
import { registerEmbeddingQueueFactory } from '@brainstrike/embeddings/runtime-config';
import { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import { requestedEmbeddingPooling } from '@brainstrike/indexing-contract';
import type { QueueAdapter } from '@brainstrike/queue';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';

interface LoadedPlan {
  readonly identity: string;
  readonly service: SimpleEmbeddingService;
}

/** What makes two payloads load the same model: its key and its whole execution. */
function planIdentity({ inferencePlan: plan, modelKey }: CanonicalDocumentEmbeddingsPayload) {
  return JSON.stringify([
    modelKey,
    plan.modelId,
    plan.dimensions,
    plan.revision ?? null,
    plan.device,
    plan.dtype,
    requestedEmbeddingPooling(plan),
    plan.prompts ? [plan.prompts.query, plan.prompts.document] : null,
  ]);
}

export class WebDocumentEmbeddings {
  readonly #workerUrl: string;
  #chain: Promise<unknown> = Promise.resolve();
  #closed = false;
  #loaded: LoadedPlan | undefined;
  #queue: QueueAdapter | undefined;

  /** `workerUrl` is the embedding worker as the tab's bundle serves it. */
  constructor(workerUrl: string) {
    this.#workerUrl = workerUrl;
  }

  /** `NativeCanonicalInference`'s local transport. */
  readonly documentEmbeddings = (
    payload: CanonicalDocumentEmbeddingsPayload,
    options?: { signal?: AbortSignal }
  ): Promise<number[][]> => this.#serially(() => this.#embed(payload, options?.signal));

  /** Unloads the plan and stops the embedding workers; later calls refuse. */
  close(): Promise<void> {
    this.#closed = true;
    return this.#serially(async () => {
      const loaded = this.#loaded;
      this.#loaded = undefined;
      try {
        await loaded?.service.dispose();
      } finally {
        await this.#queue?.dispose?.();
      }
    });
  }

  #serially<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #embed(
    payload: CanonicalDocumentEmbeddingsPayload,
    signal: AbortSignal | undefined
  ): Promise<number[][]> {
    signal?.throwIfAborted();
    const service = await this.#service(payload);
    signal?.throwIfAborted();
    const results = await service.generateEmbeddings(payload.texts, signal ? { signal } : {});
    signal?.throwIfAborted();
    if (results.length !== payload.texts.length) {
      throw new Error('The file index embedder returned a different number of vectors.');
    }
    for (const result of results) {
      assertPinnedPlanResult(payload.inferencePlan, result);
    }
    return results.map((result) => result.embedding);
  }

  async #service(payload: CanonicalDocumentEmbeddingsPayload): Promise<SimpleEmbeddingService> {
    if (this.#closed) {
      throw new Error('The file index embedder is closed.');
    }
    const identity = planIdentity(payload);
    if (this.#loaded?.identity === identity) {
      return this.#loaded.service;
    }
    const previous = this.#loaded;
    this.#loaded = undefined;
    await previous?.service.dispose();
    if (!this.#queue) {
      const queue = createBrowserEmbeddingQueue({
        requireWorkerpool: true,
        worker: {
          name: 'web-file-index-embedding',
          telemetry: embeddingWorkerTelemetrySink,
          workerUrl: this.#workerUrl,
        },
      });
      // The service's backend runs on the queue this realm registers.
      registerEmbeddingQueueFactory(() => queue);
      this.#queue = queue;
    }
    const plan = payload.inferencePlan;
    const service = new SimpleEmbeddingService();
    await service.initialize({ ...plan, modelConfig: pinnedPlanModelConfig(plan) });
    this.#loaded = { identity, service };
    return service;
  }
}
