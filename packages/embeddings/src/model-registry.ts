import modelRegistryJson from '../model-registry.json';
import type { ModelConfig, ModelRegistry } from './types';

/**
 * Model registry for embedding models
 */
let registry: ModelRegistry = modelRegistryJson as ModelRegistry;

/**
 * Get the complete model registry
 */
export function getRegistry(): ModelRegistry {
  return registry;
}

/**
 * Get all available models
 */
export function listModels(): Record<string, ModelConfig> {
  return registry.models;
}

/**
 * Get a specific model configuration
 */
export function getModel(key: string): ModelConfig | null {
  return registry.models[key] || null;
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
 */
export function hasModel(key: string): boolean {
  return key in registry.models;
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
 * Force quantized: true when model.dimensions <= 768
 */
export function shouldQuantize(model: ModelConfig): boolean {
  return model.quantized || model.dimensions <= 768;
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
