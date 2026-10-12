import type { Migration } from './migration-runner.js';

// BST-1993: granite-embedding-small-english-r2 is the recommended local embedding
// model for semantic search (owner approval, 12 Oct 2026; evidence in BST-1939
// Phase 3, PR #3570). This row is the one owner of the model's facts that change
// its vectors: CLS pooling (`capabilities.pooling`), the immutable revision the
// vectors were qualified at, and the execution dtype per device. fp16 is the
// qualified WebGPU export; q8 (`model_quantized.onnx`) is Transformers.js 4.3's
// own WASM default dtype, for machines without WebGPU. Both exports use external
// data files, which the repository's config declares for Transformers.js.
// "Recommended" is the static catalog's `default` flag, not a column here.
// Hand-written: the catalog generator emits only registry-derived columns.
export const migration149GraniteLocalEmbeddingProfile: Migration = {
  down: `
    DELETE FROM models WHERE id IN ('onnx-community/granite-embedding-small-english-r2-ONNX');
  `,
  ledgerKey: 'custom-149-granite-local-embedding-profile',
  name: 'granite_local_embedding_profile',
  up: `
    INSERT INTO models
      (id, provider_id, name, tagline, description, best_for, capabilities, parameters, sort_order, is_enabled)
    VALUES
      (
        'onnx-community/granite-embedding-small-english-r2-ONNX',
        'local',
        'Granite Embedding Small R2',
        'Recommended for semantic search',
        'Recommended local model for semantic search. On Brainstrike''s retrieval eval of 100 code and docs queries it recalls 60% of relevant results in the top 10, against 52% for all-MiniLM-L6-v2. English, 384 dimensions; a 97 MB download with WebGPU, 52 MB without.',
        '["English", "Code search", "Retrieval"]',
        '{"defaultDimension":384,"pooling":"cls","type":"embedding"}',
        '{"execution":{"wasm":"q8","webgpu":"fp16"},"revision":"1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8","size":"~97MB"}',
        (SELECT COALESCE(MIN(sort_order), 1) FROM models WHERE provider_id = 'local' AND capabilities->>'type' = 'embedding' AND id NOT IN ('onnx-community/granite-embedding-small-english-r2-ONNX')) - 1,
        true
      )
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      description = EXCLUDED.description,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      parameters = EXCLUDED.parameters,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;
  `,
  version: 149,
};
