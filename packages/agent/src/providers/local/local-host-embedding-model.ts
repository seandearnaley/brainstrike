/**
 * AI SDK v2 embedding model for Mastra semantic recall backed by a LOCAL
 * embedding host (desktop: the hidden embedding-host renderer, reached from
 * Electron main via EmbeddingHostManager.queryEmbedding).
 *
 * packages/agent stays platform-pure: the host boundary is the injected
 * `LocalEmbeddingHostClient`, and dimensions are resolved lazily by the host
 * (desktop looks them up in the models catalog).
 */
import type { EmbeddingModelV2 } from '@ai-sdk/provider';

export interface LocalEmbeddingHostQuery {
  readonly dimensions: number;
  readonly modelId: string;
  readonly modelKey: string;
  readonly query: string;
}

export interface LocalEmbeddingHostClient {
  queryEmbedding(payload: LocalEmbeddingHostQuery): Promise<number[]>;
}

export function createLocalHostEmbeddingModel(args: {
  client: LocalEmbeddingHostClient;
  modelId: string;
  /** Lazily resolves the model's embedding dimensions (cached after first success). */
  resolveDimensions: () => Promise<number>;
}): EmbeddingModelV2<string> {
  const { client, modelId, resolveDimensions } = args;
  const modelKey = `local::${modelId}`;
  let dimensionsPromise: Promise<number> | undefined;
  const getDimensions = (): Promise<number> => {
    dimensionsPromise ??= resolveDimensions().catch((error: unknown) => {
      // Allow a later call to retry instead of caching the rejection forever.
      dimensionsPromise = undefined;
      throw error;
    });
    return dimensionsPromise;
  };

  return {
    specificationVersion: 'v2',
    provider: 'local',
    modelId,
    maxEmbeddingsPerCall: undefined,
    // The local embedding host serializes GPU work behind the foreground
    // gate; issuing values sequentially avoids queueing pressure.
    supportsParallelCalls: false,
    async doEmbed({ values }) {
      const dimensions = await getDimensions();
      const embeddings: number[][] = [];
      for (const value of values) {
        embeddings.push(
          await client.queryEmbedding({
            dimensions,
            modelId,
            modelKey,
            query: value,
          })
        );
      }
      return { embeddings };
    },
  };
}
