import { ASSISTANT_PREFERENCES_STORE_NAME } from '@brainstrike/app-state/stores/assistant-preferences-store-name';
import { resolveHostedProviderKey } from '@brainstrike/assistant-contract/provider-key-resolution';
import {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  type HostedProviderType,
  hostedProviderRequiresApiKey,
  OpenAIEmbeddingProvider,
  resolveHostedProviderApiKey,
  VoyageEmbeddingProvider,
} from '@brainstrike/embeddings/provider-core';
import {
  assertSafeBearerToken,
  buildRuntimeEndpoint,
  normalizeRuntimeBaseUrl,
  resolveRuntimeBaseUrl,
} from '@brainstrike/local-runtime';
import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { getSecretsService } from './secrets';

const logger = createLogger('DesktopHostedEmbeddings');
const ERROR_MESSAGES = {
  missingApiKey: 'No API key configured for the embedding provider.',
  unsupportedProvider: 'Embedding provider is not supported by assistant retrieval.',
};
type HostedEmbeddingProvider =
  | OpenAIEmbeddingProvider
  | GoogleEmbeddingProvider
  | CohereEmbeddingProvider
  | VoyageEmbeddingProvider;
export async function resolveEmbeddingApiKey(
  provider: HostedProviderType
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
  provider: HostedProviderType,
  modelId: string,
  dimensions: number,
  apiKey?: string,
  purpose: 'document' | 'query' = 'query',
  endpoint?: string
): HostedEmbeddingProvider {
  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider({
        modelId,
        provider: 'openai',
        targetDimensions: dimensions,
        ...(apiKey ? { apiKey } : {}),
      });
    case 'ollama':
      return new OpenAIEmbeddingProvider({
        endpoint:
          endpoint ??
          buildRuntimeEndpoint(resolveRuntimeBaseUrl('ollama', undefined), '/v1/embeddings'),
        modelId,
        provider: 'ollama',
        targetDimensions: dimensions,
        ...(apiKey ? { apiKey } : {}),
        includeDimensions: false,
        requiresApiKey: false,
      });
    case 'lmstudio':
      return new OpenAIEmbeddingProvider({
        endpoint:
          endpoint ??
          buildRuntimeEndpoint(resolveRuntimeBaseUrl('lmstudio', undefined), '/v1/embeddings'),
        modelId,
        provider: 'lmstudio',
        targetDimensions: dimensions,
        ...(apiKey ? { apiKey } : {}),
        includeDimensions: false,
        requiresApiKey: false,
      });
    case 'google':
      if (!apiKey) {
        throw new Error(ERROR_MESSAGES.missingApiKey);
      }
      return new GoogleEmbeddingProvider({ apiKey, modelId, outputDimensions: dimensions });
    case 'cohere':
      if (!apiKey) {
        throw new Error(ERROR_MESSAGES.missingApiKey);
      }
      return new CohereEmbeddingProvider({
        apiKey,
        inputType: purpose === 'document' ? 'search_document' : 'search_query',
        modelId,
      });
    case 'voyage':
      if (!apiKey) {
        throw new Error(ERROR_MESSAGES.missingApiKey);
      }
      return new VoyageEmbeddingProvider({ apiKey, inputType: purpose, modelId });
    default:
      throw new Error(ERROR_MESSAGES.unsupportedProvider);
  }
}

/** Existing provider and credential owners, shared by canonical documents and native queries. */
export async function generateHostedEmbeddings(input: {
  readonly provider: HostedProviderType;
  readonly modelId: string;
  readonly dimensions: number;
  readonly texts: readonly string[];
  readonly purpose: 'document' | 'query';
  readonly signal: AbortSignal;
  readonly storage?: Pick<ElectronStorageAdapter, 'getItem'>;
}): Promise<number[][]> {
  input.signal.throwIfAborted();
  const apiKey = await resolveEmbeddingApiKey(input.provider);
  input.signal.throwIfAborted();
  if (hostedProviderRequiresApiKey(input.provider) && !apiKey) {
    throw new Error(ERROR_MESSAGES.missingApiKey);
  }
  const endpoint =
    input.provider === 'ollama' || input.provider === 'lmstudio'
      ? await resolveConfiguredRuntimeEmbeddingEndpoint(input.provider, input.storage)
      : undefined;
  input.signal.throwIfAborted();
  const provider = createHostedProvider(
    input.provider,
    input.modelId,
    input.dimensions,
    apiKey ? assertSafeBearerToken(apiKey) : undefined,
    input.purpose,
    endpoint
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
    throw new Error(`Embedding provider ${input.provider} failed: ${result.error.type}`, {
      cause: result.error,
    });
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
    throw new Error(
      'Hosted embedding response does not match its authorized model, provider, dimensions or batch.'
    );
  }
  return vectors;
}

/** Read the existing runtime settings record used by discovery; malformed choices stay visible. */
async function resolveConfiguredRuntimeEmbeddingEndpoint(
  provider: 'ollama' | 'lmstudio',
  storage?: Pick<ElectronStorageAdapter, 'getItem'>
): Promise<string> {
  const serialized = storage ? await storage.getItem(ASSISTANT_PREFERENCES_STORE_NAME) : null;
  let configured: string | undefined;
  if (serialized !== null) {
    const envelope: unknown = JSON.parse(serialized);
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('Runtime preferences are invalid.');
    }
    const state: unknown = Reflect.get(envelope, 'state');
    if (!state || typeof state !== 'object') {
      throw new Error('Runtime preferences have no state.');
    }
    const raw = readConfiguredRuntimeUrl(state, provider);
    if (typeof raw === 'string' && raw.trim()) {
      const normalized = normalizeRuntimeBaseUrl(raw);
      if (!normalized) {
        throw new Error('Selected runtime URL is unsupported.');
      }
      configured = normalized;
    }
  }
  return buildRuntimeEndpoint(resolveRuntimeBaseUrl(provider, configured), '/v1/embeddings');
}

function readConfiguredRuntimeUrl(
  state: object,
  provider: 'ollama' | 'lmstudio'
): string | undefined {
  const settings: unknown = Reflect.get(state, 'providerSettings');
  if (settings !== undefined && (!settings || typeof settings !== 'object')) {
    throw new Error('Runtime provider settings are invalid.');
  }
  const selected: unknown = settings ? Reflect.get(settings, provider) : undefined;
  if (selected !== undefined && (!selected || typeof selected !== 'object')) {
    throw new Error('Selected runtime settings are invalid.');
  }
  const raw: unknown = selected ? Reflect.get(selected, 'localRuntimeBaseUrl') : undefined;
  if (raw !== undefined && typeof raw !== 'string') {
    throw new Error('Selected runtime URL is invalid.');
  }
  return raw as string | undefined;
}
