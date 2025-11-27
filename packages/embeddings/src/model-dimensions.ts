import { LEGACY_DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { getModel } from './model-registry';

export interface GetModelDimensionsOptions {
  /**
   * When true, falls back to LEGACY_DEFAULT_EMBEDDING_DIMENSION instead of throwing.
   * Use with caution - this should only be needed for backward compatibility.
   */
  fallbackToLegacy?: boolean;
}

/**
 * Get the dimension count for a model from the registry with validation.
 *
 * @param modelKey - The model key (e.g., "xenova/bge-m3", "openai::text-embedding-3-small")
 * @param opts - Options for fallback behavior
 * @returns The validated dimension count
 * @throws Error if model not found, has no dimensions, or dimensions are out of range
 *
 * @example
 * ```ts
 * const dims = getModelDimensionsSafe('xenova/bge-m3');
 * // Returns 1024 for BGE-M3
 *
 * const dims = getModelDimensionsSafe('unknown-model', { fallbackToLegacy: true });
 * // Returns 768 (LEGACY_DEFAULT_EMBEDDING_DIMENSION)
 * ```
 */
export function getModelDimensionsSafe(modelKey: string, opts?: GetModelDimensionsOptions): number {
  const cfg = getModel(modelKey);

  if (!cfg?.dimensions || !Number.isFinite(cfg.dimensions)) {
    if (opts?.fallbackToLegacy) {
      return LEGACY_DEFAULT_EMBEDDING_DIMENSION;
    }
    throw new Error(`Model "${modelKey}" has no valid dimensions in registry`);
  }

  const dim = Math.floor(cfg.dimensions);
  if (dim <= 0) {
    throw new Error(`Model "${modelKey}" has invalid dimensions: ${dim} (must be positive)`);
  }

  if (dim > MAX_EMBEDDING_DIMENSION) {
    throw new Error(
      `Model "${modelKey}" dimensions ${dim} exceed pgvector limit (${MAX_EMBEDDING_DIMENSION})`
    );
  }

  return dim;
}

/**
 * Check if a dimension value is valid for pgvector storage.
 *
 * @param dimensions - The dimension count to validate
 * @returns true if dimensions are within valid range
 */
export function isValidDimension(dimensions: number): boolean {
  return (
    Number.isFinite(dimensions) &&
    Number.isInteger(dimensions) &&
    dimensions > 0 &&
    dimensions <= MAX_EMBEDDING_DIMENSION
  );
}

/**
 * Validate dimensions and throw a descriptive error if invalid.
 *
 * @param dimensions - The dimension count to validate
 * @param context - Optional context for error messages (e.g., model name)
 * @throws Error if dimensions are invalid
 */
export function validateDimensions(dimensions: number, context?: string): void {
  const prefix = context ? `${context}: ` : '';

  if (!Number.isFinite(dimensions)) {
    throw new Error(`${prefix}Dimensions must be a finite number, got: ${dimensions}`);
  }

  if (!Number.isInteger(dimensions)) {
    throw new Error(`${prefix}Dimensions must be an integer, got: ${dimensions}`);
  }

  if (dimensions <= 0) {
    throw new Error(`${prefix}Dimensions must be positive, got: ${dimensions}`);
  }

  if (dimensions > MAX_EMBEDDING_DIMENSION) {
    throw new Error(
      `${prefix}Dimensions ${dimensions} exceed pgvector limit (${MAX_EMBEDDING_DIMENSION})`
    );
  }
}
