import { BertModel, PretrainedConfig, type Tensor } from '@huggingface/transformers';
import { vi } from 'vitest';

/** Keep the vendor model contract; replace only inference in pipeline tests. */
export function fixtureEmbeddingModel(
  forward: (inputs: {
    input_ids: Tensor;
    attention_mask: Tensor;
  }) => Promise<{ last_hidden_state: Tensor }>
): BertModel {
  const model = new BertModel(new PretrainedConfig({ model_type: 'bert' }), {}, {});
  vi.spyOn(model, 'forward').mockImplementation(forward);
  return model;
}
