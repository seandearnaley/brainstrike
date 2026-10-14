import {
  quantizesUnpinnedLoad,
  resolveCatalogEmbeddingPlan,
  unpinnedEmbeddingDType,
} from '@brainstrike/embeddings/inference-plan';
import type { LocalSearchEmbedderFactory } from '@brainstrike/vector-management';
import { generateDesktopDocumentEmbeddings } from './document-embeddings';
import { generateDesktopQueryEmbedding } from './query-embeddings';

/** Main owns the hidden runtime; the shared search cache retains only this request adapter. */
export const createDesktopLocalSearchEmbedder: LocalSearchEmbedderFactory = async (
  model,
  device
) => {
  const resolved = resolveCatalogEmbeddingPlan(
    {
      device,
      dimensions: model.dimensions,
      dtype: unpinnedEmbeddingDType(device, quantizesUnpinnedLoad(model)),
      modelId: model.id,
      ...(model.revision === undefined ? {} : { revision: model.revision }),
    },
    model
  );
  if (resolved.kind !== 'ready') {
    throw new Error(resolved.reason);
  }
  const payload = {
    dimensions: model.dimensions,
    inferencePlan: resolved.workerPlan,
    modelId: model.id,
    modelKey: `local::${model.id}`,
  };
  return {
    embedDocument: async (text) => {
      const [embedding] = await generateDesktopDocumentEmbeddings({ ...payload, texts: [text] });
      if (!embedding) {
        throw new Error('Hidden document inference returned no vector.');
      }
      return { embedding };
    },
    embedQuery: async (text, options) => ({
      embedding: Array.from(
        await generateDesktopQueryEmbedding(
          { ...payload, query: text },
          { signal: options?.signal ?? new AbortController().signal }
        )
      ),
    }),
    runtime: device,
  };
};
