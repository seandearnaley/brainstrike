import { createCohere } from '@ai-sdk/cohere';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { listProviderEmbeddingModels } from '@brainstrike/assistant-contract/provider-registry';
import { resolveProviderBaseUrl } from '@brainstrike/host-capabilities/provider-base-url';
import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { type EmbeddingModel, embedMany } from 'ai';
import { createVoyage } from 'voyage-ai-provider';
import {
  HOSTED_EMBEDDING_MISSING_KEY_MESSAGE,
  HostedEmbeddingError,
  hostedRefusal,
} from './hosted-embedding-error';
import { readProviderApiKey } from './provider-api-key';

const logger = createLogger('DesktopHostedEmbeddings');

function embeddingModel(
  provider: EmbeddingProviderType,
  modelId: string,
  apiKey: string
): EmbeddingModel {
  switch (provider) {
    case 'openai':
      // Wherever a real OpenAI turn goes (`OPENAI_BASE_URL`), so indexing and chat share one origin.
      return createOpenAI({ apiKey, baseURL: resolveProviderBaseUrl('openai') }).embeddingModel(
        modelId
      );
    case 'google':
      return createGoogle({ apiKey }).embeddingModel(modelId);
    case 'cohere':
      return createCohere({ apiKey }).embeddingModel(modelId);
    case 'voyage':
      return createVoyage({ apiKey }).embeddingModel(modelId);
  }
}

/** Embeds the index's documents through the existing provider and credential owners. */
export async function generateHostedEmbeddings(input: {
  readonly provider: EmbeddingProviderType;
  readonly modelId: string;
  readonly dimensions: number;
  readonly texts: readonly string[];
  readonly purpose: 'document';
  readonly signal: AbortSignal;
}): Promise<number[][]> {
  input.signal.throwIfAborted();
  // The chat credential order: the environment is authoritative, the keychain
  // is the fallback, and an unreadable keychain entry stays visible.
  const apiKey = await readProviderApiKey(input.provider);
  input.signal.throwIfAborted();
  if (!apiKey) {
    throw new HostedEmbeddingError('missing-key', HOSTED_EMBEDDING_MISSING_KEY_MESSAGE);
  }
  // Only a model the catalog marks as tunable is sent a dimension; the others
  // have one fixed size, checked below.
  const tunable = listProviderEmbeddingModels(input.provider).some(
    (model) => model.id === input.modelId && model.supportsCustomDimensions === true
  );
  let embeddings: number[][];
  try {
    ({ embeddings } = await embedMany({
      abortSignal: input.signal,
      // Report a refusal as it happened instead of retrying it.
      maxRetries: 0,
      model: embeddingModel(input.provider, input.modelId, apiKey),
      // Each provider reads only its own key: the text is a document to index.
      providerOptions: {
        cohere: { inputType: 'search_document' },
        voyage: { inputType: input.purpose },
      },
      values: [...input.texts],
      ...(tunable ? { dimensions: input.dimensions } : {}),
    }));
  } catch (error) {
    // Our own cancellation, as the SDK rethrows it; a provider failure that
    // settles after cancellation is still reported as that failure.
    if (input.signal.aborted && error === input.signal.reason) {
      throw error;
    }
    const refusal = hostedRefusal(input.provider, error);
    // Keep the provider diagnostic in Main before the utility fault channel
    // projects causes to Error text.
    logger.error('Hosted embedding request failed', {
      error: refusal ? refusal.cause : error,
      provider: input.provider,
    });
    throw refusal ?? error;
  }
  input.signal.throwIfAborted();
  if (
    embeddings.length !== input.texts.length ||
    embeddings.some(
      (vector) => vector.length !== input.dimensions || !vector.every(Number.isFinite)
    )
  ) {
    throw new HostedEmbeddingError(
      'provider-status',
      `Embedding provider ${input.provider} returned vectors that do not match the requested dimensions or batch.`
    );
  }
  return embeddings;
}
