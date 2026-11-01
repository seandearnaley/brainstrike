import { decoder, type IndexerOptions, optionsSchema } from './contracts.ts';

/**
 * The indexer options' schema, wherever the store runs. The desktop's
 * file-path rules (an absolute database path, a canonical state root) belong
 * to its opener: `validateIndexerOptions` in `transport.ts`.
 */
export function decodeIndexerOptions(input: unknown): IndexerOptions {
  return decoder(optionsSchema)(input);
}
