/**
 * Legacy default dimension for backward compatibility with older embeddings.
 * New code should use model-aware dimensions from the registry.
 * - OpenAI text-embedding-3-small: 1536
 * - OpenAI text-embedding-3-large: 3072
 */
export const LEGACY_DEFAULT_EMBEDDING_DIMENSION = 768;

/**
 * @deprecated Use LEGACY_DEFAULT_EMBEDDING_DIMENSION instead.
 * Kept for backward compatibility with existing code.
 */
export const DEFAULT_EMBEDDING_DIMENSION = LEGACY_DEFAULT_EMBEDDING_DIMENSION;

/**
 * Hard limit based on pgvector's vector type (2000 max dimensions).
 * halfvec supports more (16000) but we're using standard vector type.
 * See: https://github.com/pgvector/pgvector#vector
 */
export const MAX_EMBEDDING_DIMENSION = 2000;
