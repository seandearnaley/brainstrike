import { decoder, IndexerError, type IndexerOptions, optionsSchema } from './contracts.js';
import { configuredEmbedding } from './index-metadata.js';

/**
 * The indexer options' schema and consistency rules, wherever the store runs.
 * The desktop's file-path rules (an absolute database path, a canonical
 * state root) belong to its opener: `validateIndexerOptions` in `transport.ts`.
 */
export function decodeIndexerOptions(input: unknown): IndexerOptions {
  const options = decoder(optionsSchema)(input);
  if ((options.stateRoot === undefined) !== (options.stateProjection === undefined)) {
    throw new TypeError('State root and producer schema must be acquired together.');
  }
  if (options.stateResources !== undefined) {
    if (options.stateRoot === undefined) {
      throw new TypeError('Message resource grants require acquired State truth.');
    }
    const resources = new Set<string>();
    for (const grant of options.stateResources) {
      if (!options.rootIds.includes(grant.rootId) || resources.has(grant.resourceId)) {
        throw new TypeError('A Memory resource requires one authorized immutable Root grant.');
      }
      resources.add(grant.resourceId);
    }
  }
  return options;
}

/**
 * A store with no index yet refuses an explicit open-existing, and a vector
 * profile it cannot configure, before anything is written.
 */
export function assertFreshOpen(options: IndexerOptions, fresh: boolean): void {
  if (!fresh) {
    return;
  }
  if (options.embedding.indexMode === 'open-existing') {
    throw new IndexerError(
      'index-not-found',
      'Explicit open-existing requires an existing index file.'
    );
  }
  if (options.embedding.indexMode === 'vector-configured') {
    configuredEmbedding(options.embedding.profile);
  }
}
