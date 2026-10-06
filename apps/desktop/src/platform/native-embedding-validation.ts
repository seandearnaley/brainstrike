import type { CatalogEmbeddingWorkerPlan } from '@brainstrike/embeddings/inference-plan';
import type { IndexerEmbeddingProfile } from '@brainstrike/indexing-contract/indexer-client';
import { assertSupportedKeys, parseRecord } from '../ipc-domains/contract-args';

function positiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 16_000;
}
function validDtype(value: unknown): value is CatalogEmbeddingWorkerPlan['dtype'] {
  return value === 'q4' || value === 'q8' || value === 'fp16' || value === 'fp32';
}
function optionalRevision(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value));
}
/** Pure shared trust decoder; main and sandboxed preloads retain the exact same plan. */
export function decodeNativeEmbeddingWorkerPlan(value: unknown): CatalogEmbeddingWorkerPlan {
  const plan = parseRecord(value, 'native embedding worker plan');
  const { modelId, dimensions, device, dtype, revision } = plan;
  if (
    !(
      typeof modelId === 'string' &&
      modelId.trim() &&
      positiveDimension(dimensions) &&
      (device === 'wasm' || device === 'webgpu') &&
      validDtype(dtype) &&
      optionalRevision(revision)
    )
  ) {
    throw new TypeError(
      'Native embedding plan requires model, dimensions, device, dtype and a valid optional revision.'
    );
  }
  return { device, dimensions, dtype, modelId, ...(revision === undefined ? {} : { revision }) };
}
/** Canonical profile DTO parsing; durable authority and profile hashes are checked by the owner. */
export function decodeNativeEmbeddingProfile(value: unknown): IndexerEmbeddingProfile {
  const profile = parseRecord(value, 'native embedding profile');
  assertSupportedKeys(
    profile,
    ['provider', 'distance', 'modelId', 'dimensions', 'revision', 'dtype', 'tokenCap'],
    'native embedding profile'
  );
  const { modelId, dimensions, provider, distance, dtype, revision, tokenCap } = profile;
  if (!(typeof modelId === 'string' && modelId.trim() && positiveDimension(dimensions))) {
    throw new TypeError('Native embedding profile has invalid model or dimensions.');
  }
  if (
    provider !== undefined &&
    provider !== 'local' &&
    provider !== 'transformers' &&
    provider !== 'openai' &&
    provider !== 'google' &&
    provider !== 'cohere' &&
    provider !== 'voyage' &&
    provider !== 'ollama' &&
    provider !== 'lmstudio'
  ) {
    throw new TypeError('Native embedding provider is unsupported.');
  }
  if (distance !== undefined && distance !== 'cosine' && distance !== 'l2' && distance !== 'ip') {
    throw new TypeError('Native embedding distance is unsupported.');
  }
  if (provider === undefined && distance !== undefined) {
    throw new TypeError('Explicit distance requires a canonical embedding provider.');
  }
  if (provider !== undefined && distance === undefined) {
    throw new TypeError('Canonical embedding profile requires distance.');
  }
  if (provider === undefined || provider === 'local' || provider === 'transformers') {
    if (
      !(
        validDtype(dtype) &&
        optionalRevision(revision) &&
        (tokenCap === undefined ||
          (typeof tokenCap === 'number' && Number.isSafeInteger(tokenCap) && tokenCap > 0))
      )
    ) {
      throw new TypeError(
        'Native local profile requires dtype and valid optional revision and token cap.'
      );
    }
  } else if (dtype !== undefined || revision !== undefined || tokenCap !== undefined) {
    throw new TypeError('Hosted embedding profile cannot contain local runtime choices.');
  }
  return profile as unknown as IndexerEmbeddingProfile;
}
