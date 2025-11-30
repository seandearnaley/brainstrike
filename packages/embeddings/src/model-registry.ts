import type { ModelConfig, ModelRegistry } from './types';

/**
 * Default fallback registry to allow service initialization without external config.
 * This replaces the static model-registry.json.
 */
const DEFAULT_REGISTRY: ModelRegistry = {
  default: 'jinaai/jina-embeddings-v2-base-code',
  models: {
    'jinaai/jina-embeddings-v2-base-code': {
      id: 'jinaai/jina-embeddings-v2-base-code',
      name: 'Jina Code v2 (default)',
      dimensions: 768,
      quantized: false,
      description: 'Code-aware embeddings (30+ languages, 8k ctx)',
      tags: ['code', 'multilingual', 'open-source', 'local'],
      origin: 'Code-aware',
      size: '~300MB',
      contextWindow: 8192,
    },
    'Xenova/jina-embeddings-v2-base-en': {
      id: 'Xenova/jina-embeddings-v2-base-en',
      name: 'Jina English v2',
      dimensions: 768,
      quantized: false,
      description: 'General English embeddings with long context (8k tokens)',
      tags: ['english', 'long-context', 'open-source', 'local'],
      origin: 'General text',
      size: '~130MB',
      contextWindow: 8192,
    },
    'jinaai/jina-embeddings-v3': {
      id: 'jinaai/jina-embeddings-v3',
      name: 'Jina v3 (experimental)',
      dimensions: 1024,
      quantized: false,
      description:
        'Latest Jina model with task-specific adapters (89 languages). Note: transformers.js support may be limited.',
      tags: ['multilingual', 'flexible-dimensions', 'open-source', 'local', 'experimental'],
      origin: 'General text',
      size: '~570MB',
      contextWindow: 8192,
    },
    'Xenova/all-MiniLM-L6-v2': {
      id: 'Xenova/all-MiniLM-L6-v2',
      name: 'all-MiniLM-L6-v2',
      dimensions: 384,
      quantized: false,
      description: 'Fast and efficient English embeddings',
      tags: ['english', 'fast', 'general', 'local'],
      origin: 'General text',
      size: '~23MB',
      contextWindow: 512,
    },
    'Xenova/bge-small-en-v1.5': {
      id: 'Xenova/bge-small-en-v1.5',
      name: 'BGE-Small-EN-v1.5',
      dimensions: 384,
      quantized: false,
      description: 'Balanced English embeddings',
      tags: ['english', 'balanced', 'bge', 'local'],
      origin: 'General text',
      size: '~67MB',
      contextWindow: 512,
    },
    'Xenova/bge-base-en-v1.5': {
      id: 'Xenova/bge-base-en-v1.5',
      name: 'BGE-Base-EN-v1.5',
      dimensions: 768,
      quantized: false,
      description: 'High-quality English embeddings',
      tags: ['english', 'high-quality', 'bge', 'local'],
      origin: 'General text',
      size: '~130MB',
      contextWindow: 512,
    },
    'Xenova/bge-large-en-v1.5': {
      id: 'Xenova/bge-large-en-v1.5',
      name: 'BGE-Large-EN-v1.5',
      dimensions: 1024,
      quantized: false,
      description: 'SOTA English text embeddings',
      tags: ['english', 'sota', 'bge', 'local'],
      origin: 'General text',
      size: '~330MB',
      contextWindow: 512,
    },
  },
  hosted: {
    openai: {
      'text-embedding-3-small': {
        name: 'OpenAI Embedding 3 Small',
        dimensions: 1536,
        description: 'Cost-effective OpenAI model with flexible dimensions',
        tags: ['openai', 'hosted', 'cost-optimized', 'flexible-dimensions'],
        contextWindow: 8191,
        pricePer1MTokens: 0.02,
        supportedDimensions: '256-1536',
      },
      'text-embedding-3-large': {
        name: 'OpenAI Embedding 3 Large',
        dimensions: 3072,
        description: 'Best-performing OpenAI model with flexible dimensions',
        tags: ['openai', 'hosted', 'high-performance', 'flexible-dimensions'],
        contextWindow: 8191,
        pricePer1MTokens: 0.13,
        supportedDimensions: '256-3072',
      },
    },
    voyage: {
      'voyage-3': {
        name: 'Voyage 3',
        dimensions: 1024,
        description: 'General-purpose multilingual retrieval (32k context)',
        tags: ['voyage', 'hosted', 'multilingual', 'long-context'],
        contextWindow: 32_000,
        pricePer1MTokens: 0.06,
      },
      'voyage-3-lite': {
        name: 'Voyage 3 Lite',
        dimensions: 512,
        description: 'Latency-optimized retrieval model',
        tags: ['voyage', 'hosted', 'fast', 'cost-optimized'],
        contextWindow: 32_000,
        pricePer1MTokens: 0.02,
      },
      'voyage-code-3': {
        name: 'Voyage Code 3',
        dimensions: 1024,
        description: 'Optimized for code retrieval (32k context)',
        tags: ['voyage', 'hosted', 'code'],
        contextWindow: 32_000,
        pricePer1MTokens: 0.18,
      },
    },
    cohere: {
      'embed-english-v3.0': {
        name: 'Cohere Embed English v3.0',
        dimensions: 1024,
        description: 'Best English embedding model from Cohere',
        tags: ['cohere', 'hosted', 'english', 'high-performance'],
        contextWindow: 512,
        pricePer1MTokens: 0.1,
      },
      'embed-multilingual-v3.0': {
        name: 'Cohere Embed Multilingual v3.0',
        dimensions: 1024,
        description: 'Multilingual embedding model from Cohere (100+ languages)',
        tags: ['cohere', 'hosted', 'multilingual'],
        contextWindow: 512,
        pricePer1MTokens: 0.1,
      },
    },
    google: {
      'text-embedding-004': {
        name: 'Google Text Embedding 004',
        dimensions: 768,
        description: 'Google latest text embedding model',
        tags: ['google', 'hosted', 'general'],
        contextWindow: 2048,
        pricePer1MTokens: 0.0001,
      },
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
 * Local provider types that should be looked up in the local models registry
 */
const LOCAL_PROVIDER_PREFIXES = ['local', 'transformers'] as const;

/**
 * Get a specific model configuration
 * Supports:
 * - Local models by registry key (e.g., "jina-code", "all-MiniLM-L6-v2")
 * - Local models by HuggingFace ID (e.g., "Xenova/all-MiniLM-L6-v2")
 * - Local provider composite keys (e.g., "transformers::Xenova/all-MiniLM-L6-v2", "local::jina-code")
 * - Hosted providers (e.g., "openai::text-embedding-3-small")
 * @deprecated Use database lookup for model configuration
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multiple lookup strategies require branching
export function getModel(key: string): ModelConfig | null {
  // Check local models by key first
  if (registry.models[key]) {
    return registry.models[key];
  }

  // Check local models by their HuggingFace ID (the `id` field)
  // This handles cases where the full model ID is used instead of the registry key
  for (const [_registryKey, model] of Object.entries(registry.models)) {
    if (model.id === key) {
      return model;
    }
  }

  // Check composite keys (format: "provider::modelId")
  if (key.includes('::')) {
    const [provider, modelId] = key.split('::');

    // Handle local provider composite keys (e.g., "transformers::Xenova/all-MiniLM-L6-v2")
    if (
      provider &&
      LOCAL_PROVIDER_PREFIXES.includes(provider as (typeof LOCAL_PROVIDER_PREFIXES)[number])
    ) {
      // Look up by the modelId part (could be registry key or HuggingFace ID)
      if (modelId && registry.models[modelId]) {
        return registry.models[modelId];
      }
      // Also check by HuggingFace ID
      for (const [_registryKey, model] of Object.entries(registry.models)) {
        if (model.id === modelId) {
          return model;
        }
      }
    }

    // Handle hosted provider composite keys
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
 * Supports:
 * - Local models by registry key (e.g., "jina-code", "all-MiniLM-L6-v2")
 * - Local models by HuggingFace ID (e.g., "Xenova/all-MiniLM-L6-v2")
 * - Local provider composite keys (e.g., "transformers::Xenova/all-MiniLM-L6-v2", "local::jina-code")
 * - Hosted providers (e.g., "openai::text-embedding-3-small")
 * @deprecated Use database lookup for model existence check
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multiple lookup strategies require branching
export function hasModel(key: string): boolean {
  // Check local models by key first
  if (key in registry.models) {
    return true;
  }

  // Check local models by their HuggingFace ID (the `id` field)
  for (const model of Object.values(registry.models)) {
    if (model.id === key) {
      return true;
    }
  }

  // Check composite keys (format: "provider::modelId")
  if (key.includes('::')) {
    const [provider, modelId] = key.split('::');

    // Handle local provider composite keys (e.g., "transformers::Xenova/all-MiniLM-L6-v2")
    if (
      provider &&
      LOCAL_PROVIDER_PREFIXES.includes(provider as (typeof LOCAL_PROVIDER_PREFIXES)[number])
    ) {
      // Check by modelId (registry key)
      if (modelId && modelId in registry.models) {
        return true;
      }
      // Check by HuggingFace ID
      for (const model of Object.values(registry.models)) {
        if (model.id === modelId) {
          return true;
        }
      }
    }

    // Handle hosted provider composite keys
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
