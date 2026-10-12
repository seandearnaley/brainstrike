import type { EmbeddingPooling } from '@brainstrike/indexing-contract';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * The vendor pipeline owns tokenization, the selected model's input limit and
 * pooling: 'mean' averages the attended token states, 'cls' takes the first.
 */
export async function extractEmbeddingBatch(
  extractor: FeatureExtractionPipeline,
  texts: readonly string[],
  pooling: EmbeddingPooling
): Promise<unknown> {
  return await extractor([...texts], { normalize: false, pooling });
}
