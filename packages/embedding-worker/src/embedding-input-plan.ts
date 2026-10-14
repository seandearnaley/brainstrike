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

/**
 * ONNX Runtime refuses any tensor over 4 GiB. Attention masks and scores grow with
 * batch × padded_seq², and the pipeline pads each call to its longest text, so one
 * long text in a full batch overflows long-context models (granite R2's
 * `global_attn_mask` Tile). 2^24 still fits 64 texts of 512 tokens in one call; a
 * text near an 8192-token limit runs alone.
 */
export const MAX_BATCH_ATTENTION_AREA = 2 ** 24;

/** Each text's token count after the pipeline tokenizer's own truncation. */
export function measurePipelineTokenLengths(
  extractor: FeatureExtractionPipeline,
  texts: readonly string[]
): number[] {
  return texts.map((text) => {
    const { input_ids: inputIds } = extractor.tokenizer(text, { truncation: true });
    return inputIds.dims.at(-1) ?? 0;
  });
}

/** Ordered batch ends with at most `maxCount` texts and count × longest² within `maxArea`. */
export function planAttentionBoundedBatchEnds(
  tokenLengths: readonly number[],
  maxCount: number,
  maxArea: number = MAX_BATCH_ATTENTION_AREA
): number[] {
  const ends: number[] = [];
  let count = 0;
  let longest = 0;
  for (const [index, length] of tokenLengths.entries()) {
    const widest = Math.max(longest, length);
    if (count > 0 && (count === maxCount || (count + 1) * widest * widest > maxArea)) {
      ends.push(index);
      count = 0;
      longest = 0;
    }
    count += 1;
    longest = Math.max(longest, length);
  }
  if (count > 0) {
    ends.push(tokenLengths.length);
  }
  return ends;
}
