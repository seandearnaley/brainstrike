import { MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';

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
