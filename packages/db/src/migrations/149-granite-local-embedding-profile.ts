import {
  type EmbeddingModelDefinition,
  listProviderEmbeddingModels,
} from '@brainstrike/assistant-contract';
import type { Migration } from './migration-runner.js';

// BST-1993: local embedding facts come from the canonical provider catalog, and
// granite-embedding-small-english-r2 is the recommended local model for
// semantic search with WebGPU (owner approval, 12 Oct 2026; evidence in
// BST-1939 Phase 3, PR #3570). A row is the one owner of what changes a
// model's vectors (these web seed columns project that same definition):
// - `capabilities.pooling`: granite uses CLS pooling; absent means mean.
// - `capabilities.prompts`: the query/document text its model card says to
//   prepend, or none. These replace substring-guessed prompts, which halved
//   MiniLM's recall on the BST-1922 eval. Sources:
//   - granite r2: https://huggingface.co/ibm-granite/granite-embedding-small-english-r2
//     (raw text, CLS pooling) - none.
//   - all-MiniLM-L6-v2: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 - none.
//   - jina v2 base code/en: https://huggingface.co/jinaai/jina-embeddings-v2-base-code,
//     https://huggingface.co/jinaai/jina-embeddings-v2-base-en (raw inputs) - none.
//   - bge v1.5 small/base/large: https://huggingface.co/BAAI/bge-small-en-v1.5 - the query
//     instruction for short-query-to-passage retrieval, and no passage instruction.
// - `parameters.revision` and `parameters.execution`: granite's qualified
//   revision, fp16 on WebGPU, and q8 (`model_quantized.onnx`, Transformers.js
//   4.3's own WASM default) for machines without WebGPU. Both exports use
//   external data files, which the repository's config declares.
// Which model Settings recommends, per execution device, is the static
// catalog's `recommendedExecution`, not a column here.
// Hand-written: the catalog generator emits only registry-derived columns.
const localEmbeddingModels = listProviderEmbeddingModels('local');

function modelProfile(id: string): EmbeddingModelDefinition {
  const model = localEmbeddingModels.find((candidate) => candidate.id === id);
  if (!model?.prompts) {
    throw new Error(`Local embedding catalog profile is incomplete: ${id}`);
  }
  return model;
}

function sqlJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("'", "''");
}

function capabilities(model: EmbeddingModelDefinition): string {
  return sqlJson({
    defaultDimension: model.defaultDimension,
    ...(model.pooling === undefined ? {} : { pooling: model.pooling }),
    prompts: model.prompts,
    type: model.type,
  });
}

const granite = modelProfile('onnx-community/granite-embedding-small-english-r2-ONNX');
const bgeSmall = modelProfile('Xenova/bge-small-en-v1.5');
const promptUpdates = localEmbeddingModels
  .filter(({ id }) => id !== granite.id && id !== bgeSmall.id)
  .map(
    ({ id }) => `UPDATE models SET capabilities = capabilities ||
    '${sqlJson({ prompts: modelProfile(id).prompts })}'::jsonb
    WHERE provider_id = 'local' AND id = '${id.replaceAll("'", "''")}';`
  )
  .join('\n');

export const migration149GraniteLocalEmbeddingProfile: Migration = {
  down: `
    DELETE FROM models WHERE id IN ('onnx-community/granite-embedding-small-english-r2-ONNX');
    UPDATE models SET capabilities = capabilities - 'prompts'
     WHERE provider_id = 'local' AND id IN (
       'Xenova/all-MiniLM-L6-v2', 'jinaai/jina-embeddings-v2-base-code',
       'Xenova/jina-embeddings-v2-base-en', 'Xenova/bge-small-en-v1.5',
       'Xenova/bge-base-en-v1.5', 'Xenova/bge-large-en-v1.5'
     );
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
        'Best semantic search with WebGPU',
        'On Brainstrike''s retrieval eval of 100 code and docs queries it recalls 60% of relevant results in the top 10, against 52% for all-MiniLM-L6-v2. English, 384 dimensions; a 97 MB download for WebGPU. Without WebGPU it runs on WASM (52 MB), far more slowly and with more than 4 GB of memory.',
        '["English", "Code search", "Retrieval"]',
        '${capabilities(granite)}',
        '${sqlJson({ execution: granite.execution, revision: granite.revision, size: '~97MB' })}',
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
    ${promptUpdates}
    -- BGE Small is the static catalog's recommendation without WebGPU, so its row is
    -- stated here as the local row migration 021 made it; an existing row keeps
    -- everything but gains its prompts.
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, parameters, sort_order, is_enabled)
    VALUES
      (
        'Xenova/bge-small-en-v1.5',
        'local',
        'BGE Small',
        'Balanced performance',
        '["English", "General purpose"]',
        '${capabilities(bgeSmall)}',
        '{"size":"~34MB"}',
        4,
        true
      )
    ON CONFLICT (id) DO UPDATE SET
      capabilities = models.capabilities || '${sqlJson({ prompts: bgeSmall.prompts })}'::jsonb;
  `,
  version: 149,
};
