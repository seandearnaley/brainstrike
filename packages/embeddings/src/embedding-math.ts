import type { SimilarityResult } from './types';

/**
 * Calculate cosine similarity between two embeddings.
 *
 * @param embedding1 - Array of numbers
 * @param embedding2 - Array of numbers
 * @throws {Error} If embeddings have different dimensions or are empty.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: performance optimization
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

  let i = 0;
  // Unrolled loop (stride 4) for performance
  // Optimistic execution: assume dense arrays.
  // If undefined is encountered, multiplication yields NaN, which propagates.
  // We check for NaN at the end and fall back to slow validation if needed.
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    const v3 = embedding1[i + 1];
    const v4 = embedding2[i + 1];
    const v5 = embedding1[i + 2];
    const v6 = embedding2[i + 2];
    const v7 = embedding1[i + 3];
    const v8 = embedding2[i + 3];

    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    dotProduct += v1! * v2! + v3! * v4! + v5! * v6! + v7! * v8!;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    norm1 += v1! * v1! + v3! * v3! + v5! * v5! + v7! * v7!;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    norm2 += v2! * v2! + v4! * v4! + v6! * v6! + v8! * v8!;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    dotProduct += v1! * v2!;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    norm1 += v1! * v1!;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    norm2 += v2! * v2!;
  }

  // Check for NaN which indicates either sparse array (undefined * number = NaN)
  // or invalid input (NaN in input)
  if (Number.isNaN(dotProduct) || Number.isNaN(norm1) || Number.isNaN(norm2)) {
    for (let k = 0; k < len; k++) {
      if (embedding1[k] === undefined || embedding2[k] === undefined) {
        throw new Error('Sparse arrays are not supported');
      }
    }
  }

  if (norm1 === 0 || norm2 === 0) {
    return {
      similarity: 0,
      distance: 1,
      method: 'cosine',
    };
  }

  const similarity = dotProduct / Math.sqrt(norm1 * norm2);

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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: performance optimization
export function calculateL2Distance(embedding1: number[], embedding2: number[]): SimilarityResult {
  const len = embedding1.length;
  if (len === 0 || embedding2.length === 0) {
    throw new Error('Embeddings must not be empty');
  }
  if (len !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let squaredDistance = 0;

  let i = 0;
  // Unrolled loop (stride 4)
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    const v3 = embedding1[i + 1];
    const v4 = embedding2[i + 1];
    const v5 = embedding1[i + 2];
    const v6 = embedding2[i + 2];
    const v7 = embedding1[i + 3];
    const v8 = embedding2[i + 3];

    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    const diff1 = v1! - v2!;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    const diff2 = v3! - v4!;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    const diff3 = v5! - v6!;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    const diff4 = v7! - v8!;

    squaredDistance += diff1 * diff1 + diff2 * diff2 + diff3 * diff3 + diff4 * diff4;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    const diff = v1! - v2!;
    squaredDistance += diff * diff;
  }

  if (Number.isNaN(squaredDistance)) {
    for (let k = 0; k < len; k++) {
      if (embedding1[k] === undefined || embedding2[k] === undefined) {
        throw new Error('Sparse arrays are not supported');
      }
    }
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: performance optimization
export function calculateDotProduct(embedding1: number[], embedding2: number[]): SimilarityResult {
  const len = embedding1.length;
  if (len === 0 || embedding2.length === 0) {
    throw new Error('Embeddings must not be empty');
  }
  if (len !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let dotProduct = 0;

  let i = 0;
  // Unrolled loop (stride 4)
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    const v3 = embedding1[i + 1];
    const v4 = embedding2[i + 1];
    const v5 = embedding1[i + 2];
    const v6 = embedding2[i + 2];
    const v7 = embedding1[i + 3];
    const v8 = embedding2[i + 3];

    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    dotProduct += v1! * v2! + v3! * v4! + v5! * v6! + v7! * v8!;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    dotProduct += v1! * v2!;
  }

  if (Number.isNaN(dotProduct)) {
    for (let k = 0; k < len; k++) {
      if (embedding1[k] === undefined || embedding2[k] === undefined) {
        throw new Error('Sparse arrays are not supported');
      }
    }
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: performance optimization
export function normalize(embedding: number[]): number[] {
  const len = embedding.length;
  if (len === 0) {
    throw new Error('Embeddings must not be empty');
  }

  let norm = 0;
  let i = 0;
  const len4 = len - (len % 4);

  // Unrolled loop (stride 4)
  for (; i < len4; i += 4) {
    const v1 = embedding[i];
    const v2 = embedding[i + 1];
    const v3 = embedding[i + 2];
    const v4 = embedding[i + 3];
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    norm += v1! * v1! + v2! * v2! + v3! * v3! + v4! * v4!;
  }

  for (; i < len; i++) {
    const val = embedding[i];
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    norm += val! * val!;
  }

  if (Number.isNaN(norm)) {
    for (let k = 0; k < len; k++) {
      if (embedding[k] === undefined) {
        throw new Error('Sparse arrays are not supported');
      }
    }
  }

  if (norm === 0) {
    return embedding;
  }

  const normSqrt = Math.sqrt(norm);
  const result = new Array<number>(len);

  i = 0;
  for (; i < len4; i += 4) {
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    result[i] = embedding[i]! / normSqrt;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    result[i + 1] = embedding[i + 1]! / normSqrt;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    result[i + 2] = embedding[i + 2]! / normSqrt;
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    result[i + 3] = embedding[i + 3]! / normSqrt;
  }

  for (; i < len; i++) {
    const val = embedding[i];
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    result[i] = val! / normSqrt;
  }
  return result;
}

/**
 * Calculate the magnitude (L2 norm) of an embedding vector
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: performance optimization
export function magnitude(embedding: number[]): number {
  const len = embedding.length;
  if (len === 0) {
    throw new Error('Embeddings must not be empty');
  }

  let sum = 0;
  let i = 0;
  // Unrolled loop (stride 4)
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding[i];
    const v2 = embedding[i + 1];
    const v3 = embedding[i + 2];
    const v4 = embedding[i + 3];

    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    sum += v1! * v1! + v2! * v2! + v3! * v3! + v4! * v4!;
  }

  for (; i < len; i++) {
    const val = embedding[i];
    // biome-ignore lint/style/noNonNullAssertion: performance optimization
    sum += val! * val!;
  }

  if (Number.isNaN(sum)) {
    for (let k = 0; k < len; k++) {
      if (embedding[k] === undefined) {
        throw new Error('Sparse arrays are not supported');
      }
    }
  }

  return Math.sqrt(sum);
}
