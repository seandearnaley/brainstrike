import type { Migration } from './migration-runner';

/**
 * Migration to enable default local embedding models.
 * Previously all local embedding models were disabled by default,
 * which caused the collection creation dropdown to be empty.
 */
export const migration022EnableDefaultEmbeddingModels: Migration = {
  down: `
    UPDATE models SET is_enabled = false WHERE id = 'Xenova/all-MiniLM-L6-v2';
    UPDATE models SET is_enabled = false WHERE id = 'Xenova/bge-small-en-v1.5';
  `,
  name: 'enable_default_embedding_models',
  up: `
    -- Enable the default local embedding model (small and fast)
    UPDATE models SET is_enabled = true WHERE id = 'Xenova/all-MiniLM-L6-v2';

    -- Also enable BGE Small as a good alternative
    UPDATE models SET is_enabled = true WHERE id = 'Xenova/bge-small-en-v1.5';
  `,
  version: 22,
};
