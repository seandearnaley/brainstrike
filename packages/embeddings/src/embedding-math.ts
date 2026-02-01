import type { SimilarityResult } from './types';

/**
 * Calculate cosine similarity between two embeddings.
 *
 * @param embedding1 - Array of numbers
 * @param embedding2 - Array of numbers
 * @throws {Error} If embeddings have different dimensions or are empty.
 */
export function calculateCosineSimilarity(
  embedding1: number[],
  embedding2: number[]
): SimilarityResult {
  const len = embedding1.length;
  if (len === 0 || embedding2.length === 0) {
    throw new Error('Embeddings must not be empty');
  }
  if (len !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < len; i++) {
    // biome-ignore lint/style/noNonNullAssertion: Index is within bounds after length check
    const v1 = embedding1[i]!;
    // biome-ignore lint/style/noNonNullAssertion: Index is within bounds after length check
    const v2 = embedding2[i]!;
    dotProduct += v1 * v2;
    norm1 += v1 * v1;
    norm2 += v2 * v2;
  }

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
    distance: 1 - similarity,
    method: 'cosine',
  };
}

/**
 * Calculate L2 (Euclidean) distance between two embeddings.
 *
 * @param embedding1 - Array of numbers
 * @param embedding2 - Array of numbers
 * @throws {Error} If embeddings have different dimensions or are empty.
 */
export function calculateL2Distance(embedding1: number[], embedding2: number[]): SimilarityResult {
  const len = embedding1.length;
  if (len === 0 || embedding2.length === 0) {
    throw new Error('Embeddings must not be empty');
  }
  if (len !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let squaredDistance = 0;

  for (let i = 0; i < len; i++) {
    // biome-ignore lint/style/noNonNullAssertion: Index is within bounds after length check
    const diff = embedding1[i]! - embedding2[i]!;
    squaredDistance += diff * diff;
  }

  const distance = Math.sqrt(squaredDistance);
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
 * @param embedding1 - Array of numbers
 * @param embedding2 - Array of numbers
 * @throws {Error} If embeddings have different dimensions or are empty.
 */
export function calculateDotProduct(embedding1: number[], embedding2: number[]): SimilarityResult {
  const len = embedding1.length;
  if (len === 0 || embedding2.length === 0) {
    throw new Error('Embeddings must not be empty');
  }
  if (len !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let dotProduct = 0;

  for (let i = 0; i < len; i++) {
    // biome-ignore lint/style/noNonNullAssertion: Index is within bounds after length check
    dotProduct += embedding1[i]! * embedding2[i]!;
  }

  return {
    similarity: dotProduct,
    distance: -dotProduct,
    method: 'dot_product',
  };
}

/**
 * Normalize an embedding vector to unit length
 */
export function normalize(embedding: number[]): number[] {
  const len = embedding.length;
  if (len === 0) {
    throw new Error('Embeddings must not be empty');
  }

  let norm = 0;
  for (let i = 0; i < len; i++) {
    // biome-ignore lint/style/noNonNullAssertion: Index is within bounds after length check
    const val = embedding[i]!;
    norm += val * val;
  }

  if (norm === 0) {
    return embedding;
  }

  const normSqrt = Math.sqrt(norm);
  const result = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    // biome-ignore lint/style/noNonNullAssertion: Index is within bounds after length check
    result[i] = embedding[i]! / normSqrt;
  }
  return result;
}

/**
 * Calculate the magnitude (L2 norm) of an embedding vector
 */
export function magnitude(embedding: number[]): number {
  const len = embedding.length;
  if (len === 0) {
    throw new Error('Embeddings must not be empty');
  }

  let sum = 0;
  for (let i = 0; i < len; i++) {
    // biome-ignore lint/style/noNonNullAssertion: Index is within bounds after length check
    const val = embedding[i]!;
    sum += val * val;
  }
  return Math.sqrt(sum);
}
