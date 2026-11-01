import { decoder, IndexerError, type IndexerOptions, optionsSchema } from './contracts.ts';

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
  return options;
}

/** A store with no index yet refuses an explicit open-existing before anything is written. */
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
}
