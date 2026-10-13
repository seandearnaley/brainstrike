import { ASSISTANT_PREFERENCES_STORE_NAME } from '@brainstrike/app-state/stores/assistant-preferences-store-name';
import { resolveHostedProviderKey } from '@brainstrike/assistant-contract/provider-key-resolution';
import {
  CohereEmbeddingProvider,
  type EmbeddingProviderError,
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
import { HostedEmbeddingError } from './hosted-embedding-error';
import { getSecretsService } from './secrets';

const logger = createLogger('DesktopHostedEmbeddings');

export { HostedEmbeddingError, type HostedEmbeddingErrorKind } from './hosted-embedding-error';

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
        throw missingKey();
      }
      return new GoogleEmbeddingProvider({ apiKey, modelId, outputDimensions: dimensions });
    case 'cohere':
      if (!apiKey) {
        throw missingKey();
      }
      return new CohereEmbeddingProvider({
        apiKey,
        inputType: purpose === 'document' ? 'search_document' : 'search_query',
        modelId,
      });
    case 'voyage':
      if (!apiKey) {
        throw missingKey();
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
    throw missingKey();
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

function missingKey(): HostedEmbeddingError {
  return new HostedEmbeddingError('missing-key', ERROR_MESSAGES.missingApiKey);
}

/**
 * A provider's typed failure as the refusal BST-1996 maps. Only typed facts choose the
 * kind (no message text is parsed), and the message never repeats the provider's body.
 */
function hostedRefusal(provider: HostedProviderType, error: EmbeddingProviderError): Error {
  switch (error.type) {
    case 'missing_api_key':
      return new HostedEmbeddingError('missing-key', ERROR_MESSAGES.missingApiKey, {
        cause: error,
      });
    case 'rate_limit_exceeded':
      return new HostedEmbeddingError(
        'rate-limit',
        `Embedding provider ${provider} is rate limiting requests; try again later.`,
        { cause: error }
      );
    case 'network_error':
      return new HostedEmbeddingError(
        'network',
        `Embedding provider ${provider} could not be reached.`,
        { cause: error }
      );
    case 'api_error':
      return error.statusCode === 413
        ? new HostedEmbeddingError(
            'input-too-long',
            `Embedding provider ${provider} refused the input as too large (HTTP 413).`,
            { cause: error }
          )
        : new HostedEmbeddingError(
            'provider-status',
            `Embedding provider ${provider} refused the request (HTTP ${error.statusCode}).`,
            { cause: error }
          );
    case 'dimension_mismatch':
      return new HostedEmbeddingError(
        'provider-status',
        `Embedding provider ${provider} returned ${error.received}-dimensional vectors; ${error.expected} were requested.`,
        { cause: error }
      );
    // Our own input or a local model: not a hosted provider refusal.
    case 'validation_error':
    case 'model_load_failed':
      return new Error(`Embedding provider ${provider} failed: ${error.type}`, { cause: error });
    default:
      return assertNever(error);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled embedding provider error: ${JSON.stringify(value)}`);
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
