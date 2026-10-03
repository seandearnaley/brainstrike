import type {
  FeatureExtractionPipeline,
  PreTrainedTokenizer,
  Tensor,
} from '@huggingface/transformers';

export const MINILM_MAX_INPUT_TOKENS = 256;
export const EMBEDDING_BATCH_TOKEN_BUDGET = 8192;

/** Count the actual tokenizer output, including special tokens and batch padding. */
export function createTokenBudgetBatchEnds(
  texts: readonly string[],
  tokenizer: PreTrainedTokenizer,
  maxBatchSize: number,
  tokenBudget = EMBEDDING_BATCH_TOKEN_BUDGET
): number[] {
  if (
    !(
      Number.isSafeInteger(maxBatchSize) &&
      maxBatchSize > 0 &&
      Number.isSafeInteger(tokenBudget) &&
      tokenBudget > 0
    )
  ) {
    throw new Error('Embedding batch limits must be positive safe integers.');
  }
  const ends: number[] = [];
  let start = 0;
  let longest = 0;
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    if (text === undefined) {
      throw new Error('Embedding input is missing.');
    }
    const length = tokenizer(text, {
      // biome-ignore lint/style/useNamingConvention: Transformers.js tokenizer option.
      max_length: MINILM_MAX_INPUT_TOKENS,
      padding: false,
      // biome-ignore lint/style/useNamingConvention: Transformers.js tokenizer option.
      return_tensor: false,
      truncation: true,
    }).input_ids.length;
    if (length > tokenBudget) {
      throw new Error('Embedding input exceeds the batch token budget.');
    }
    const paddedLength = Math.max(longest, length);
    if (
      index > start &&
      (index - start >= maxBatchSize || paddedLength * (index - start + 1) > tokenBudget)
    ) {
      ends.push(index);
      start = index;
      longest = length;
    } else {
      longest = paddedLength;
    }
  }
  if (start < texts.length) {
    ends.push(texts.length);
  }
  return ends;
}

/** Vendor custom-inference API: tokenize with a cap, run the model, then mean-pool. */
export async function extractCappedEmbeddings(
  extractor: FeatureExtractionPipeline,
  texts: readonly string[],
  meanPooling: (lastHiddenState: Tensor, attentionMask: Tensor) => Tensor
): Promise<Tensor> {
  const inputs = extractor.tokenizer([...texts], {
    // biome-ignore lint/style/useNamingConvention: Transformers.js tokenizer option.
    max_length: MINILM_MAX_INPUT_TOKENS,
    padding: true,
    truncation: true,
  });
  try {
    const output: unknown = await extractor.model(inputs);
    if (!(output && typeof output === 'object' && 'last_hidden_state' in output)) {
      throw new Error('Fused MiniLM did not return last_hidden_state.');
    }
    const hiddenState = output.last_hidden_state as Tensor;
    try {
      return meanPooling(hiddenState, inputs.attention_mask);
    } finally {
      hiddenState.dispose();
    }
  } finally {
    for (const input of Object.values(inputs)) {
      input?.dispose();
    }
  }
}
