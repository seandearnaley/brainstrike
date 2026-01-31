import type { SimilarityResult } from './types';

/**
 * Validates that a value is a finite number.
 * @internal
 */
function checkValue(val: number | undefined, index: number): number {
  if (val === undefined) {
    throw new Error(`Sparse array detected at index ${index}`);
  }
  if (!Number.isFinite(val)) {
    throw new Error(`Invalid value (${val}) at index ${index}`);
  }
  return val;
}

/**
 * Calculate cosine similarity between two embeddings.
 *
 * @param embedding1 - Dense array of numbers (no holes/undefined values)
 * @param embedding2 - Dense array of numbers (no holes/undefined values)
 * @throws {Error} If embeddings have different dimensions, are empty, or contain invalid values.
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

  // Calculate cosine similarity
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  // Unrolled loop (stride 4)
  const remainder = len % 4;
  const loopEnd = len - remainder;

  for (let i = 0; i < loopEnd; i += 4) {
    // Index i
    const v10 = checkValue(embedding1[i], i);
    const v20 = checkValue(embedding2[i], i);
    dotProduct += v10 * v20;
    norm1 += v10 * v10;
    norm2 += v20 * v20;

    // Index i+1
    const v11 = checkValue(embedding1[i + 1], i + 1);
    const v21 = checkValue(embedding2[i + 1], i + 1);
    dotProduct += v11 * v21;
    norm1 += v11 * v11;
    norm2 += v21 * v21;

    // Index i+2
    const v12 = checkValue(embedding1[i + 2], i + 2);
    const v22 = checkValue(embedding2[i + 2], i + 2);
    dotProduct += v12 * v22;
    norm1 += v12 * v12;
    norm2 += v22 * v22;

    // Index i+3
    const v13 = checkValue(embedding1[i + 3], i + 3);
    const v23 = checkValue(embedding2[i + 3], i + 3);
    dotProduct += v13 * v23;
    norm1 += v13 * v13;
    norm2 += v23 * v23;
  }

  // Handle remainder
  for (let i = loopEnd; i < len; i++) {
    const val1 = checkValue(embedding1[i], i);
    const val2 = checkValue(embedding2[i], i);
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
 * @throws {Error} If embeddings have different dimensions, are empty, or contain invalid values.
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
  const remainder = len % 4;
  const loopEnd = len - remainder;

  for (let i = 0; i < loopEnd; i += 4) {
    const v10 = checkValue(embedding1[i], i);
    const v20 = checkValue(embedding2[i], i);
    const d0 = v10 - v20;
    squaredDistance += d0 * d0;

    const v11 = checkValue(embedding1[i + 1], i + 1);
    const v21 = checkValue(embedding2[i + 1], i + 1);
    const d1 = v11 - v21;
    squaredDistance += d1 * d1;

    const v12 = checkValue(embedding1[i + 2], i + 2);
    const v22 = checkValue(embedding2[i + 2], i + 2);
    const d2 = v12 - v22;
    squaredDistance += d2 * d2;

    const v13 = checkValue(embedding1[i + 3], i + 3);
    const v23 = checkValue(embedding2[i + 3], i + 3);
    const d3 = v13 - v23;
    squaredDistance += d3 * d3;
  }

  for (let i = loopEnd; i < len; i++) {
    const val1 = checkValue(embedding1[i], i);
    const val2 = checkValue(embedding2[i], i);
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
 * @throws {Error} If embeddings have different dimensions, are empty, or contain invalid values.
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
  const remainder = len % 4;
  const loopEnd = len - remainder;

  for (let i = 0; i < loopEnd; i += 4) {
    dotProduct += checkValue(embedding1[i], i) * checkValue(embedding2[i], i);
    dotProduct += checkValue(embedding1[i + 1], i + 1) * checkValue(embedding2[i + 1], i + 1);
    dotProduct += checkValue(embedding1[i + 2], i + 2) * checkValue(embedding2[i + 2], i + 2);
    dotProduct += checkValue(embedding1[i + 3], i + 3) * checkValue(embedding2[i + 3], i + 3);
  }

  for (let i = loopEnd; i < len; i++) {
    const val1 = checkValue(embedding1[i], i);
    const val2 = checkValue(embedding2[i], i);
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
