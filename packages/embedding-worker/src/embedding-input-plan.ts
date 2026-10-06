import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/** The vendor pipeline owns tokenization and the selected model's input limit. */
export async function extractEmbeddingBatch(
  extractor: FeatureExtractionPipeline,
  texts: readonly string[]
): Promise<unknown> {
  return await extractor([...texts], { normalize: false, pooling: 'mean' });
}
