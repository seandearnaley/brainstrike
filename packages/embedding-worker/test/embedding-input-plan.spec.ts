import { BertTokenizer, FeatureExtractionPipeline, Tensor } from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';
import { extractEmbeddingBatch } from '../src/embedding-input-plan';
import tokenizerJson from './fixtures/minilm-tokenizer.json';

describe('vendor model input ownership', () => {
  it.each([512, 8192])(
    'honors a selected tokenizer limit of %d without the former 256-token cap',
    async (modelMaxLength) => {
      const tokenizer = new BertTokenizer(tokenizerJson, {
        cls_token: '[CLS]',
        mask_token: '[MASK]',
        model_max_length: modelMaxLength,
        pad_token: '[PAD]',
        sep_token: '[SEP]',
        unk_token: '[UNK]',
      });
      let observedTokens = 0;
      const pipeline = new FeatureExtractionPipeline({
        model: async (inputs: { input_ids: Tensor; attention_mask: Tensor }) => {
          observedTokens = inputs.input_ids.dims[1] ?? 0;
          return {
            last_hidden_state: new Tensor('float32', new Float32Array(observedTokens * 2).fill(2), [
              1,
              observedTokens,
              2,
            ]),
          };
        },
        tokenizer,
      });
      const output = await extractEmbeddingBatch(pipeline, ['hello '.repeat(600)]);
      expect(observedTokens).toBe(Math.min(modelMaxLength, 602));
      expect(output).toBeInstanceOf(Tensor);
      const result = output as Tensor;
      expect(result.dims).toEqual([1, 2]);
      expect(Array.from(result.data)).toEqual([2, 2]);
      result.dispose();
    }
  );
});
