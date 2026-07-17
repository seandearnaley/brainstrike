import type { IDatabase } from '@brainstrike/db';
import { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import { SimpleEmbeddingService, type SimpleEmbeddingServiceOptions } from '../bge-m3-service';
import { EmbeddingProviderFactory } from '../factory';
import type {
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  EmbeddingProviderType,
  LocalProviderType,
} from '../provider-types';
import { isLocalProviderType } from '../provider-types';
import { formatProviderModelKey, isHostedProvider, parseProviderModelKey } from '../provider-utils';
import type { EmbeddingService, ModelConfig } from '../types';
import { FALLBACK_MODEL_CONFIG } from '../types';
import { getModelConfigFromDb } from './embedding-model-config';

const runtimeLogger = createLogger('EmbeddingWorkerProviderRuntime');

export type SupportedHostedProvider = Extract<
  EmbeddingProviderType,
  'openai' | 'google' | 'ollama' | 'lmstudio'
>;
type HostedProviderConfig = Extract<
  EmbeddingProviderConfig,
  { runtime: 'hosted'; provider: SupportedHostedProvider }
>;

export class WorkerRateLimitError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'WorkerRateLimitError';
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

export interface WorkerModelResolution {
  compositeKey: string;
  modelId: string;
  provider: EmbeddingProviderType;
}

export interface EmbeddingServiceInitializationOptions {
  cacheDir?: string;
  db: IDatabase;
  device?: 'webgpu' | 'wasm';
  onDownloadProgress?: (modelId: string, progress: number) => void;
  service?: EmbeddingService;
  streamBatchSize?: number;
  streamingWorkerUrl?: string;
}

function createSimpleEmbeddingServiceOptions(
  options: Pick<EmbeddingServiceInitializationOptions, 'streamBatchSize' | 'streamingWorkerUrl'>
): SimpleEmbeddingServiceOptions | undefined {
  if (!(options.streamingWorkerUrl || options.streamBatchSize)) {
    return;
  }
  return {
    ...(options.streamBatchSize ? { streamBatchSize: options.streamBatchSize } : {}),
    ...(options.streamingWorkerUrl ? { streamingWorkerUrl: options.streamingWorkerUrl } : {}),
  };
}

export function resolveWorkerModel(fromOptions?: string): WorkerModelResolution {
  const envValue = (() => {
    try {
      if (process?.env?.['EMBED_MODEL_KEY']) {
        return String(process.env['EMBED_MODEL_KEY']);
      }
      return '';
    } catch (error) {
      runtimeLogger.debug('Unable to read EMBED_MODEL_KEY from environment', { error });
      return '';
    }
  })();

  const candidate = fromOptions || envValue || FALLBACK_MODEL_CONFIG.id;
  const parsed = parseProviderModelKey(candidate);

  if (parsed) {
    return {
      compositeKey: formatProviderModelKey(parsed.provider, parsed.modelId),
      modelId: parsed.modelId,
      provider: parsed.provider,
    };
  }

  return {
    compositeKey: formatProviderModelKey('local', candidate),
    modelId: candidate,
    provider: 'local',
  };
}

function isNodejsMainProcess(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      typeof process.versions?.node !== 'undefined' &&
      typeof window === 'undefined'
    );
  } catch (error) {
    runtimeLogger.debug(
      'Failed to detect Node.js runtime while checking embedding worker context',
      {
        error,
      }
    );
    return false;
  }
}

export function isElectronMainProcess(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      Boolean((process as { type?: string } | undefined)?.type === 'browser')
    );
  } catch (error) {
    runtimeLogger.debug('Failed to detect Electron main process while checking embedding context', {
      error,
    });
    return false;
  }
}

export function readBooleanEnv(key: string): boolean | undefined {
  try {
    const raw = (process as { env?: Record<string, string | undefined> } | undefined)?.env?.[key];
    if (raw === undefined) {
      return;
    }
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  } catch (error) {
    runtimeLogger.debug('Failed to read boolean env flag', { error, key });
  }
  return;
}

export function ensureLocalRuntime(modelResolution: { provider: EmbeddingProviderType }): void {
  if (!isLocalProviderType(modelResolution.provider)) {
    return;
  }

  const allowMainRuntime = readBooleanEnv('EMBED_ALLOW_LOCAL_IN_MAIN') === true;

  if (isElectronMainProcess() && process.env['NODE_ENV'] !== 'test' && !allowMainRuntime) {
    throw new Error(
      'Cannot use local embedding models in Electron main process. ' +
        'TransformersBackend requires Web Workers which are only available in browser contexts. ' +
        'Use a hosted provider (openai, google) or process embeddings in the renderer.'
    );
  }

  if (isNodejsMainProcess() && !allowMainRuntime) {
    runtimeLogger.warn(
      'Running local embeddings in a Node.js main process. This may block event loop if Web Workers are unavailable. ' +
        'Set EMBED_ALLOW_LOCAL_IN_MAIN=true to acknowledge this risk.'
    );
  }
}

export function shouldStartWorker(
  options: { enable?: boolean },
  log: (msg: string, meta?: unknown) => void
): boolean {
  if (options.enable === false) {
    log('Embedding worker disabled via options.enable=false');
    return false;
  }

  const envEnabled = readBooleanEnv('EMBED_WORKER_ENABLED');
  if (envEnabled === false) {
    log('Embedding worker disabled via EMBED_WORKER_ENABLED=false');
    return false;
  }
  if (envEnabled === true) {
    return true;
  }

  return true;
}

export function toSupportedHostedProvider(
  provider: Exclude<EmbeddingProviderType, LocalProviderType>
): SupportedHostedProvider {
  if (
    provider === 'openai' ||
    provider === 'google' ||
    provider === 'ollama' ||
    provider === 'lmstudio'
  ) {
    return provider;
  }
  throw new Error(`Hosted provider "${provider}" is not supported yet.`);
}

export function buildHostedProviderConfig(
  provider: SupportedHostedProvider,
  modelId: string,
  expectedDimension: number
): HostedProviderConfig {
  switch (provider) {
    case 'openai':
      return {
        dimensions: expectedDimension,
        modelId,
        provider: 'openai',
        runtime: 'hosted',
      };
    case 'google':
      return {
        modelId,
        outputDimensionality: expectedDimension,
        provider: 'google',
        runtime: 'hosted',
      };
    case 'ollama':
      return {
        dimensions: expectedDimension,
        modelId,
        provider: 'ollama',
        runtime: 'hosted',
      };
    case 'lmstudio':
      return {
        dimensions: expectedDimension,
        modelId,
        provider: 'lmstudio',
        runtime: 'hosted',
      };
    default:
      throw new Error(`Hosted provider "${provider}" is not supported yet.`);
  }
}

function formatHostedInitializationError(
  provider: SupportedHostedProvider,
  error: EmbeddingProviderError
): string {
  let reason = 'unavailable';
  if (error.type === 'missing_api_key') {
    reason = 'missing API key';
  } else if (error.type === 'validation_error') {
    reason = error.message;
  }
  return `Failed to initialize provider "${provider}" (${reason}).`;
}

export async function createHostedProviderInstance(
  provider: SupportedHostedProvider,
  config: HostedProviderConfig
) {
  const providerResult = await EmbeddingProviderFactory.createProvider(config);
  if (!providerResult.ok) {
    throw new Error(formatHostedInitializationError(provider, providerResult.error));
  }
  return providerResult.value;
}

export function formatHostedEmbedError(
  provider: SupportedHostedProvider,
  error: EmbeddingProviderError
): string {
  switch (error.type) {
    case 'api_error':
      return `Hosted provider "${provider}" API error (${error.statusCode}): ${error.message}`;
    case 'rate_limit_exceeded':
      return `Hosted provider "${provider}" rate limit exceeded.`;
    case 'missing_api_key':
      return `Hosted provider "${provider}" missing API key.`;
    case 'network_error':
      return `Hosted provider "${provider}" network error: ${error.originalError.message}`;
    default:
      return `Hosted provider "${provider}" error: ${error.type}.`;
  }
}

export function validateHostedEmbeddingDimensions(
  provider: SupportedHostedProvider,
  modelId: string,
  embedding: number[],
  expectedDimension: number
): void {
  if (!Array.isArray(embedding) || embedding.length !== expectedDimension) {
    throw new Error(
      `Embedding dimension mismatch for hosted provider '${provider}' model '${modelId}': received ${embedding.length}, expected ${expectedDimension}.`
    );
  }
}

export async function initializeEmbeddingService(
  options: EmbeddingServiceInitializationOptions,
  modelKey: string,
  mode?: { initializeLocalService?: boolean }
): Promise<{ service: EmbeddingService; modelConfig: ModelConfig }> {
  runtimeLogger.info('initializeEmbeddingService: START', { modelKey });

  const service =
    options.service ?? new SimpleEmbeddingService(createSimpleEmbeddingServiceOptions(options));
  const initializeLocalService = mode?.initializeLocalService ?? true;

  const parsedForRegistry = parseProviderModelKey(modelKey);
  const registryModelKey =
    parsedForRegistry && isLocalProviderType(parsedForRegistry.provider)
      ? parsedForRegistry.modelId
      : modelKey;

  runtimeLogger.info('initializeEmbeddingService: querying DB for model', {
    modelKey,
    parsedProvider: parsedForRegistry?.provider,
    registryModelKey,
  });

  let modelConfig = await getModelConfigFromDb(options.db, registryModelKey);

  runtimeLogger.info('initializeEmbeddingService: DB query complete', {
    configDimensions: modelConfig?.dimensions,
    configName: modelConfig?.name,
    foundConfig: !!modelConfig,
    registryModelKey,
  });

  if (!modelConfig && options.service) {
    const serviceConfig = service.getConfig();
    const testEmbedding = await service.generateEmbedding('test');
    modelConfig = {
      description: 'Custom embedding service model',
      dimensions: testEmbedding.embedding.length,
      id: serviceConfig.modelId || 'custom-model',
      name: 'Custom Service Model',
      origin: 'custom',
      quantized: false,
      size: 'unknown',
      tags: ['custom'],
    };
  }

  if (!modelConfig) {
    throw new Error(
      `Model '${registryModelKey}' not found in database. Add it via Settings > Models.`
    );
  }

  if (!options.service) {
    const parsed = parseProviderModelKey(modelKey);
    const isHosted = parsed && isHostedProvider(parsed.provider);

    if (!isHosted && initializeLocalService) {
      const simpleService = service as SimpleEmbeddingService;
      if (typeof simpleService.initializeWithModel === 'function') {
        await simpleService.initializeWithModel(
          modelConfig,
          (p) => {
            if (options.onDownloadProgress && p.progress !== undefined) {
              options.onDownloadProgress(registryModelKey, p.progress);
            }
          },
          options.device,
          options.cacheDir
        );
      } else {
        await service.initialize?.({}, undefined);
      }
    }
  }

  return { modelConfig, service };
}

export function ensureModelDimension(
  modelConfig: ModelConfig,
  modelKey: string,
  log: (msg: string, meta?: unknown) => void
): number {
  const dimensions = Number(modelConfig.dimensions);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    const errorMsg = `Model '${modelKey}' reported an invalid embedding dimension (${modelConfig.dimensions}).`;
    log('worker_model_dimension_invalid', {
      dimensions: modelConfig.dimensions,
      modelKey,
    });
    throw new Error(errorMsg);
  }

  if (dimensions > MAX_EMBEDDING_DIMENSION) {
    log('worker_model_dimension_warning', {
      dimensions,
      message: `pgvector supports up to ${MAX_EMBEDDING_DIMENSION} dimensions; verify provider settings.`,
      modelKey,
    });
    throw new Error(
      `Model '${modelKey}' exceeds the supported embedding dimension limit (${MAX_EMBEDDING_DIMENSION}). Received ${dimensions}.`
    );
  }

  if (dimensions !== DEFAULT_EMBEDDING_DIMENSION) {
    log('worker_model_dimension_notice', {
      default: DEFAULT_EMBEDDING_DIMENSION,
      dimensions,
      modelKey,
    });
  }

  return dimensions;
}
