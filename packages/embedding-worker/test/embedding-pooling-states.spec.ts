import { FeatureExtractionPipeline, Tensor } from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';
import { extractEmbeddingBatch } from '../src/embedding-input-plan';
import recorded from './fixtures/minilm-token-states.json';

/**
 * BST-1939: pooling over real ONNX token states. The fixture is the control
 * model's tokenization and last_hidden_state for two padded texts, recorded
 * in the hidden embedding host through the product's Transformers.js build.
 */
const [texts, tokens, width] = [recorded.texts, recorded.dims[1] ?? 0, recorded.dims[2] ?? 0];
const ids = (rows: readonly (readonly number[])[]): Tensor =>
  new Tensor('int64', BigInt64Array.from(rows.flat().map(BigInt)), [rows.length, tokens]);
/** The recorded tokenizer output: the pipeline pools with its attention mask. */
const tokenizer = Object.assign(
  (input: readonly string[]) => {
    expect(input).toEqual(texts);
    return { attention_mask: ids(recorded.attentionMask), input_ids: ids(recorded.inputIds) };
  },
  { model_max_length: 512 }
) as unknown as ConstructorParameters<typeof FeatureExtractionPipeline>[0]['tokenizer'];
const pipeline = new FeatureExtractionPipeline({
  model: async () => ({
    last_hidden_state: new Tensor(
      'float32',
      Float32Array.from(recorded.lastHiddenState),
      recorded.dims
    ),
  }),
  tokenizer,
});
const state = (text: number, token: number): number[] =>
  recorded.lastHiddenState.slice(
    (text * tokens + token) * width,
    (text * tokens + token + 1) * width
  );

describe('pooling over recorded token states', () => {
  it('holds one token state per recorded token', () => {
    expect(recorded.dims).toEqual([texts.length, recorded.inputIds[0]?.length, 384]);
    expect(recorded.lastHiddenState).toHaveLength(texts.length * tokens * width);
  });

  it("'cls' returns each text's first-token state", async () => {
    const output = (await extractEmbeddingBatch(pipeline, texts, 'cls')) as Tensor;
    expect(output.dims).toEqual([texts.length, width]);
    expect(output.tolist()).toEqual(texts.map((_, text) => state(text, 0)));
    output.dispose();
  });

  it("'mean' still averages each text's attended token states", async () => {
    const output = (await extractEmbeddingBatch(pipeline, texts, 'mean')) as Tensor;
    const actual = output.tolist() as number[][];
    for (const [text, mask] of recorded.attentionMask.entries()) {
      const attended = mask.flatMap((on, token) => (on === 1 ? [state(text, token)] : []));
      const expected = Array.from(
        { length: width },
        (_, column) =>
          attended.reduce((sum, vector) => sum + (vector[column] ?? 0), 0) / attended.length
      );
      for (const [column, value] of expected.entries()) {
        expect(actual[text]?.[column]).toBeCloseTo(value, 5);
      }
    }
    // The second text is longer: the first text's padding must not reach its mean.
    expect(recorded.attentionMask[0]).toContain(0);
    output.dispose();
  });
});
