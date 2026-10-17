import { BertTokenizer, FeatureExtractionPipeline, Tensor } from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';
import {
  extractEmbeddingBatch,
  MAX_BATCH_ATTENTION_AREA,
  measurePipelineTokenLengths,
  planAttentionBoundedBatchEnds,
} from '../src/embedding-input-plan';
import tokenizerJson from './fixtures/minilm-tokenizer.json';
import { fixtureEmbeddingModel } from './helpers/fixture-embedding-model';

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
        model: fixtureEmbeddingModel(
          async (inputs: { input_ids: Tensor; attention_mask: Tensor }) => {
            observedTokens = inputs.input_ids.dims[1] ?? 0;
            return {
              last_hidden_state: new Tensor(
                'float32',
                new Float32Array(observedTokens * 2).fill(2),
                [1, observedTokens, 2]
              ),
            };
          }
        ),
        task: 'feature-extraction',
        tokenizer,
      });
      const output = await extractEmbeddingBatch(pipeline, ['hello '.repeat(600)], 'mean');
      expect(observedTokens).toBe(Math.min(modelMaxLength, 602));
      expect(output).toBeInstanceOf(Tensor);
      const result = output as Tensor;
      expect(result.dims).toEqual([1, 2]);
      expect(Array.from(result.data)).toEqual([2, 2]);
      result.dispose();
    }
  );

  it('bounds every call so a long text cannot overflow the 4 GiB ORT tensor limit', async () => {
    // Recorded failure: granite R2 (8192-token limit), batch 64, '/model/global_attn_mask/Tile'
    // would require more than 4294967295 bytes.
    const tokenizer = new BertTokenizer(tokenizerJson, {
      cls_token: '[CLS]',
      mask_token: '[MASK]',
      model_max_length: 8192,
      pad_token: '[PAD]',
      sep_token: '[SEP]',
      unk_token: '[UNK]',
    });
    const calls: number[][] = [];
    const pipeline = new FeatureExtractionPipeline({
      model: fixtureEmbeddingModel(
        async (inputs: { input_ids: Tensor; attention_mask: Tensor }) => {
          const [batch = 0, tokens = 0] = inputs.input_ids.dims;
          calls.push([batch, tokens]);
          const hidden = new Float32Array(batch * tokens * 2);
          for (let row = 0; row < batch; row += 1) {
            hidden.fill(row, row * tokens * 2, (row + 1) * tokens * 2);
          }
          return { last_hidden_state: new Tensor('float32', hidden, [batch, tokens, 2]) };
        }
      ),
      task: 'feature-extraction',
      tokenizer,
    });
    const texts = Array.from({ length: 64 }, (_, index) =>
      index === 40 ? 'hello '.repeat(9000) : `short text ${index} `.repeat(40)
    );
    const ends = planAttentionBoundedBatchEnds(measurePipelineTokenLengths(pipeline, texts), 64);
    let start = 0;
    let embedded = 0;
    for (const end of ends) {
      const output = (await extractEmbeddingBatch(
        pipeline,
        texts.slice(start, end),
        'cls'
      )) as Tensor;
      embedded += output.dims[0] ?? 0;
      output.dispose();
      start = end;
    }
    expect(embedded).toBe(64);
    expect(ends.at(-1)).toBe(64);
    // The text at the model limit runs alone; every shared call stays within the area.
    expect(calls).toContainEqual([1, 8192]);
    for (const [batch = 0, tokens = 0] of calls.filter(([batch = 0]) => batch > 1)) {
      expect(batch * tokens * tokens).toBeLessThanOrEqual(MAX_BATCH_ATTENTION_AREA);
    }
  });

  it('keeps a full batch of ordinary chunks in one call and splits only at the bound', () => {
    expect(planAttentionBoundedBatchEnds(new Array<number>(64).fill(512), 64)).toEqual([64]);
    expect(planAttentionBoundedBatchEnds(new Array<number>(130).fill(512), 64)).toEqual([
      64, 128, 130,
    ]);
    expect(
      planAttentionBoundedBatchEnds([512, 512, 8192, 512, 2048, 2048, 2048, 2048, 2048], 64)
    ).toEqual([2, 3, 7, 9]);
    expect(planAttentionBoundedBatchEnds([], 64)).toEqual([]);
  });
});
