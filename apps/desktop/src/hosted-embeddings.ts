import { resolveHostedProviderKey } from '@brainstrike/assistant-contract/provider-key-resolution';
import {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  OpenAIEmbeddingProvider,
  parseProviderModelKey,
  resolveHostedProviderApiKey,
  VoyageEmbeddingProvider,
} from '@brainstrike/embeddings/provider-core';
import { resolveProviderBaseUrl } from '@brainstrike/host-capabilities/provider-base-url';
import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import {
  HOSTED_EMBEDDING_MISSING_KEY_MESSAGE,
  HostedEmbeddingError,
  hostedRefusal,
} from './hosted-embedding-error';
import type { QueryEmbeddingRequest } from './ipc-domains/index-search.contract';
import { getSecretsService } from './secrets';

const logger = createLogger('DesktopHostedEmbeddings');

type HostedEmbeddingProvider =
  | OpenAIEmbeddingProvider
  | GoogleEmbeddingProvider
  | CohereEmbeddingProvider
  | VoyageEmbeddingProvider;
async function resolveEmbeddingApiKey(
  provider: EmbeddingProviderType
): Promise<string | undefined> {
  // Shared resolution order (BST-979): the environment is authoritative, the
  // keychain is the fallback — previously this path was keychain-first, so a
  // key rotated via env could stay shadowed by a stale stored key. The
  // env leg reuses the embeddings resolver (same table + core order); the
  // secret leg preserves the BST-574 escape hatch: a keychain read failure
  // is NOT an absent credential and stays visible unless env supplied a key.
  const fromEnvironment = await resolveHostedProviderApiKey(provider);
  if (fromEnvironment) {
    return fromEnvironment;
  }
  const secrets = getSecretsService();
  const stored = await resolveHostedProviderKey({
    envKeyNames: [],
    envSources: [],
    readSecret: () => secrets.getKey(provider),
  });
  if (stored.secretReadError) {
    logger.warn('Stored embedding API key is unreadable and no env key exists', {
      error: stored.secretReadError,
      provider,
    });
    throw stored.secretReadError;
  }
  return stored.key;
}

export function createHostedProvider(
  provider: EmbeddingProviderType,
  modelId: string,
  dimensions: number,
  apiKey: string,
  purpose: 'document' | 'query' = 'query'
): HostedEmbeddingProvider {
  switch (provider) {
    case 'openai':
      // Wherever a real OpenAI turn goes (`OPENAI_BASE_URL`), so indexing and chat share one origin.
      return new OpenAIEmbeddingProvider({
        apiKey,
        endpoint: `${resolveProviderBaseUrl('openai')}/embeddings`,
        modelId,
        targetDimensions: dimensions,
      });
    case 'google':
      return new GoogleEmbeddingProvider({ apiKey, modelId, outputDimensions: dimensions });
    case 'cohere':
      return new CohereEmbeddingProvider({
        apiKey,
        inputType: purpose === 'document' ? 'search_document' : 'search_query',
        modelId,
      });
    case 'voyage':
      return new VoyageEmbeddingProvider({ apiKey, inputType: purpose, modelId });
  }
}

/** Existing provider and credential owners, shared by canonical documents and native queries. */
export async function generateHostedEmbeddings(input: {
  readonly provider: EmbeddingProviderType;
  readonly modelId: string;
  readonly dimensions: number;
  readonly texts: readonly string[];
  readonly purpose: 'document' | 'query';
  readonly signal: AbortSignal;
}): Promise<number[][]> {
  input.signal.throwIfAborted();
  const apiKey = await resolveEmbeddingApiKey(input.provider);
  input.signal.throwIfAborted();
  if (!apiKey) {
    throw new HostedEmbeddingError('missing-key', HOSTED_EMBEDDING_MISSING_KEY_MESSAGE);
  }
  const provider = createHostedProvider(
    input.provider,
    input.modelId,
    input.dimensions,
    apiKey,
    input.purpose
  );
  const result = await provider.embed({
    modelId: input.modelId,
    signal: input.signal,
    text: [...input.texts],
  });
  if (!result.ok) {
    if (
      result.error.type === 'network_error' &&
      input.signal.aborted &&
      result.error.originalError === input.signal.reason
    ) {
      throw input.signal.reason;
    }
    // Keep the original typed provider diagnostic in Main before the utility
    // fault channel deliberately projects plain-object causes to Error text.
    logger.error('Hosted embedding request failed', {
      error: result.error,
      provider: input.provider,
    });
    throw hostedRefusal(input.provider, result.error);
  }
  input.signal.throwIfAborted();
  const output = result.value;
  const vectors = output.embeddings ?? (input.texts.length === 1 ? [output.embedding] : []);
  if (
    output.modelId !== input.modelId ||
    output.provider !== input.provider ||
    output.dimensions !== input.dimensions ||
    vectors.length !== input.texts.length ||
    vectors.some((vector) => vector.length !== input.dimensions || !vector.every(Number.isFinite))
  ) {
    throw new HostedEmbeddingError(
      'provider-status',
      `Embedding provider ${input.provider} returned vectors that do not match the requested model, dimensions or batch.`
    );
  }
  return vectors;
}

/** Embeds one search query with the index's hosted model; the signal cancels the request. */
export async function hostedQueryEmbedding(
  request: QueryEmbeddingRequest,
  signal: AbortSignal
): Promise<number[]> {
  const selected = parseProviderModelKey(request.modelKey);
  if (!selected || selected.modelId !== request.modelId) {
    throw new Error('The query embedding model disagrees with its provider/model key.');
  }
  const [vector] = await generateHostedEmbeddings({
    dimensions: request.dimensions,
    modelId: request.modelId,
    provider: selected.provider,
    purpose: 'query',
    signal,
    texts: [request.query],
  });
  if (!vector) {
    throw new Error('Hosted query returned no vector.');
  }
  return vector;
}
