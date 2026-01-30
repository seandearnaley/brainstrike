import type { SimilarityResult } from './types';

/**
 * Calculate cosine similarity between two embeddings.
 *
 * @param embedding1 - Dense array of numbers (no holes/undefined values)
 * @param embedding2 - Dense array of numbers (no holes/undefined values)
 * @throws {Error} If embeddings have different dimensions or are empty
 */
export function calculateCosineSimilarity(
  embedding1: number[],
  embedding2: number[]
): SimilarityResult {
  if (embedding1.length === 0 || embedding2.length === 0) {
    throw new Error('Embeddings must not be empty');
  }
  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  // Calculate cosine similarity
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    // Non-null assertion is safe as we checked lengths and arrays are dense
    // biome-ignore lint/style/noNonNullAssertion: Performance optimization
    const val1 = embedding1[i]!;
    // biome-ignore lint/style/noNonNullAssertion: Performance optimization
    const val2 = embedding2[i]!;
    dotProduct += val1 * val2;
    norm1 += val1 * val1;
    norm2 += val2 * val2;
  }

  // Guard against zero-norm vectors to prevent NaN
  if (norm1 === 0 || norm2 === 0) {
    return {
      similarity: 0,
      distance: 1,
      method: 'cosine',
    };
  }

  const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

  return {
    similarity,
    distance: 1 - similarity, // Convert to distance
    method: 'cosine',
  };
}

/**
 * Calculate L2 (Euclidean) distance between two embeddings.
 *
 * @param embedding1 - Dense array of numbers (no holes/undefined values)
 * @param embedding2 - Dense array of numbers (no holes/undefined values)
 * @throws {Error} If embeddings have different dimensions or are empty
 */
export function calculateL2Distance(embedding1: number[], embedding2: number[]): SimilarityResult {
  if (embedding1.length === 0 || embedding2.length === 0) {
    throw new Error('Embeddings must not be empty');
  }
  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let squaredDistance = 0;
  for (let i = 0; i < embedding1.length; i++) {
    // Non-null assertion is safe as we checked lengths and arrays are dense
    // biome-ignore lint/style/noNonNullAssertion: Performance optimization
    const val1 = embedding1[i]!;
    // biome-ignore lint/style/noNonNullAssertion: Performance optimization
    const val2 = embedding2[i]!;
    const diff = val1 - val2;
    squaredDistance += diff * diff;
  }

  const distance = Math.sqrt(squaredDistance);
  // Convert distance to similarity (0 = identical, higher = less similar)
  const similarity = 1 / (1 + distance);

  return {
    similarity,
    distance,
    method: 'l2',
  };
}

/**
 * Calculate dot product similarity between two embeddings.
 *
 * @param embedding1 - Dense array of numbers (no holes/undefined values)
 * @param embedding2 - Dense array of numbers (no holes/undefined values)
 * @throws {Error} If embeddings have different dimensions or are empty
 */
export function calculateDotProduct(embedding1: number[], embedding2: number[]): SimilarityResult {
  if (embedding1.length === 0 || embedding2.length === 0) {
    throw new Error('Embeddings must not be empty');
  }
  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let dotProduct = 0;
  for (let i = 0; i < embedding1.length; i++) {
    // Non-null assertion is safe as we checked lengths and arrays are dense
    // biome-ignore lint/style/noNonNullAssertion: Performance optimization
    const val1 = embedding1[i]!;
    // biome-ignore lint/style/noNonNullAssertion: Performance optimization
    const val2 = embedding2[i]!;
    dotProduct += val1 * val2;
  }

  return {
    similarity: dotProduct,
    distance: -dotProduct, // Negative for consistency (higher similarity = lower distance)
    method: 'dot_product',
  };
}

/**
 * Normalize an embedding vector to unit length
 */
export function normalize(embedding: number[]): number[] {
  let norm = 0;
  for (const value of embedding) {
    norm += value * value;
  }

  if (norm === 0) {
    return embedding; // Return as-is if zero vector
  }

  const normSqrt = Math.sqrt(norm);
  return embedding.map((value) => value / normSqrt);
}

/**
 * Calculate the magnitude (L2 norm) of an embedding vector
 */
export function magnitude(embedding: number[]): number {
  let sum = 0;
  for (const value of embedding) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}
