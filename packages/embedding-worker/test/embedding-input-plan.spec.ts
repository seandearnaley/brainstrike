import {
  BertTokenizer,
  FeatureExtractionPipeline,
  mean_pooling,
  Tensor,
} from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';
import { createTokenBudgetBatchEnds, extractCappedEmbeddings } from '../src/embedding-input-plan';
import tokenizerJson from './fixtures/minilm-tokenizer.json';

function createTokenizer(): BertTokenizer {
  return new BertTokenizer(tokenizerJson, {
    cls_token: '[CLS]',
    mask_token: '[MASK]',
    model_max_length: 512,
    pad_token: '[PAD]',
    sep_token: '[SEP]',
    unk_token: '[UNK]',
  });
}

describe('fused MiniLM token budget', () => {
  it('accounts for special tokens and padded length without changing input order', () => {
    const tokenizer = createTokenizer();
    const texts = ['hello', 'hello world', 'hello '.repeat(300), 'world'];
    expect(createTokenBudgetBatchEnds(texts, tokenizer, 4, 512)).toEqual([2, 4]);
    expect(createTokenBudgetBatchEnds(texts, tokenizer, 4, 256)).toEqual([2, 3, 4]);
    expect(createTokenBudgetBatchEnds(texts, tokenizer, 1, 512)).toEqual([1, 2, 3, 4]);
  });

  it('refuses a budget too small for a single capped input', () => {
    expect(() =>
      createTokenBudgetBatchEnds(['hello '.repeat(300)], createTokenizer(), 8, 255)
    ).toThrow('exceeds the batch token budget');
  });

  it('caps real vendor tokenizer/model input at 256 including CLS and SEP', async () => {
    const tokenizer = createTokenizer();
    let observedTokens = 0;
    const pipeline = new FeatureExtractionPipeline({
      model: async (inputs: { input_ids: Tensor; attention_mask: Tensor }) => {
        observedTokens = inputs.input_ids.dims[1] ?? 0;
        expect(inputs.input_ids.tolist()[0]).toHaveLength(256);
        return {
          last_hidden_state: new Tensor('float32', new Float32Array(256 * 2).fill(1), [1, 256, 2]),
        };
      },
      tokenizer,
    });
    const result = await extractCappedEmbeddings(pipeline, ['hello '.repeat(300)], mean_pooling);
    expect(observedTokens).toBe(256);
    expect(result.dims).toEqual([1, 2]);
    expect(Array.from(result.data)).toEqual([1, 1]);
    expect(tokenizer.model_max_length).toBe(512);
  });
});
