import type { ModelConfig, ModelRegistry } from './types';

/**
 * Default fallback registry to allow service initialization without external config.
 * This replaces the static model-registry.json.
 */
const DEFAULT_REGISTRY: ModelRegistry = {
  default: 'jina-code',
  models: {
    'jina-code': {
      id: 'jinaai/jina-embeddings-v2-base-code',
      name: 'Jina Code (default)',
      dimensions: 768,
      quantized: false,
      description: 'Code-aware embeddings (30+ languages, 8k ctx)',
      tags: ['code', 'multilingual', 'open-source', 'local'],
      origin: 'Code-aware',
      size: '~300MB',
      contextWindow: 8192,
    },
  },
};

/**
 * Model registry for embedding models
 */
let registry: ModelRegistry = DEFAULT_REGISTRY;

/**
 * Get the complete model registry
 */
export function getRegistry(): ModelRegistry {
  return registry;
}

/**
 * Get all available models (both local and hosted)
 */
export function listModels(): Record<string, ModelConfig> {
  const result: Record<string, ModelConfig> = { ...registry.models };

  // Add hosted providers with proper model keys
  if (registry.hosted) {
    for (const [provider, models] of Object.entries(registry.hosted)) {
      if (models) {
        for (const [modelId, config] of Object.entries(models)) {
          const modelKey = `${provider}::${modelId}`;
          // Convert HostedModelConfig to ModelConfig by adding required fields
          result[modelKey] = {
            ...config,
            id: modelId,
            quantized: false, // Hosted models don't use quantization
          } as ModelConfig;
        }
      }
    }
  }

  return result;
}

/**
 * Get a specific model configuration
 * Supports both local models (e.g., "xenova/bge-small") and hosted providers (e.g., "openai::text-embedding-3-small")
 */
export function getModel(key: string): ModelConfig | null {
  // Check local models first
  if (registry.models[key]) {
    return registry.models[key];
  }

  // Check hosted providers (format: "provider::modelId")
  if (key.includes('::')) {
    const [provider, modelId] = key.split('::');
    const hostedProvider = registry.hosted?.[provider as keyof typeof registry.hosted];
    if (hostedProvider && modelId && hostedProvider[modelId]) {
      const config = hostedProvider[modelId];
      // Convert HostedModelConfig to ModelConfig
      return {
        ...config,
        id: modelId,
        quantized: false, // Hosted models don't use quantization
      } as ModelConfig;
    }
  }

  return null;
}

/**
 * Get the default model key
 */
export function getDefaultModelKey(): string {
  return registry.default;
}

/**
 * Get the default model configuration
 */
export function getDefaultModel(): ModelConfig {
  const defaultKey = getDefaultModelKey();
  const model = getModel(defaultKey);
  if (!model) {
    throw new Error(`Default model '${defaultKey}' not found in registry`);
  }
  return model;
}

/**
 * Check if a model exists in the registry
 * Supports both local models and hosted providers (format: "provider::modelId")
 */
export function hasModel(key: string): boolean {
  // Check local models first
  if (key in registry.models) {
    return true;
  }

  // Check hosted providers (format: "provider::modelId")
  if (key.includes('::')) {
    const [provider, modelId] = key.split('::');
    const hostedProvider = registry.hosted?.[provider as keyof typeof registry.hosted];
    return !!(hostedProvider && modelId && hostedProvider[modelId]);
  }

  return false;
}

/**
 * Get models by tag
 */
export function getModelsByTag(tag: string): Record<string, ModelConfig> {
  const result: Record<string, ModelConfig> = {};
  for (const [key, model] of Object.entries(registry.models)) {
    if (model.tags.includes(tag)) {
      result[key] = model;
    }
  }
  return result;
}

/**
 * Update the registry (for testing or dynamic loading)
 */
export function updateRegistry(newRegistry: ModelRegistry): void {
  registry = newRegistry;
}

/**
 * Auto-determine quantization based on model dimensions
 * Prefer quantization for smaller models for better performance
 */
export function shouldQuantize(model: ModelConfig): boolean {
  // Respect explicit quantization signals from the registry
  if (typeof model.quantized === 'boolean') {
    return model.quantized;
  }

  // Auto-quantize smaller models when no explicit guidance is present
  return model.dimensions <= 1024;
}

// Export all functions as a namespace for backward compatibility
export const ModelRegistryManager = {
  getRegistry,
  listModels,
  getModel,
  getDefaultModelKey,
  getDefaultModel,
  hasModel,
  getModelsByTag,
  updateRegistry,
  shouldQuantize,
};
