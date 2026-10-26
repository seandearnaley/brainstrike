import type { IndexerEmbeddingProfile } from '@brainstrike/indexing-contract/indexer-client';
import { assertSupportedKeys, parseRecord } from '../ipc-domains/contract-args';

function positiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 16_000;
}
/** Canonical profile DTO parsing; durable authority and profile hashes are checked by the owner. */
export function decodeNativeEmbeddingProfile(value: unknown): IndexerEmbeddingProfile {
  const profile = parseRecord(value, 'native embedding profile');
  assertSupportedKeys(
    profile,
    ['provider', 'distance', 'modelId', 'dimensions'],
    'native embedding profile'
  );
  const { modelId, dimensions, provider, distance } = profile;
  if (!(typeof modelId === 'string' && modelId.trim() && positiveDimension(dimensions))) {
    throw new TypeError('Native embedding profile has invalid model or dimensions.');
  }
  if (
    provider !== 'openai' &&
    provider !== 'google' &&
    provider !== 'cohere' &&
    provider !== 'voyage'
  ) {
    throw new TypeError('Native embedding provider is unsupported.');
  }
  if (distance !== 'cosine' && distance !== 'l2' && distance !== 'ip') {
    throw new TypeError('Native embedding distance is unsupported.');
  }
  return profile as unknown as IndexerEmbeddingProfile;
}
