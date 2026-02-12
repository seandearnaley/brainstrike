import type { SimilarityResult } from './types';

const SPARSE_ARRAY_ERROR = 'Sparse arrays are not supported';
const NAN_INPUT_ERROR = 'Embeddings must not contain NaN';

/**
 * Fast-path loops intentionally skip per-element validation.
 * This helper validates inputs only when a NaN accumulator indicates invalid data.
 */
function validateArrayValues(embedding: number[], len: number): void {
  for (let i = 0; i < len; i++) {
    const value = embedding[i];
    if (value === undefined) {
      throw new Error(SPARSE_ARRAY_ERROR);
    }
    if (Number.isNaN(value)) {
      throw new Error(NAN_INPUT_ERROR);
    }
  }
}

/**
 * Fast-path loops intentionally skip per-element validation.
 * This helper validates paired inputs only when a NaN accumulator indicates invalid data.
 */
function validatePairedArrayValues(embedding1: number[], embedding2: number[], len: number): void {
  for (let i = 0; i < len; i++) {
    const value1 = embedding1[i];
    const value2 = embedding2[i];
    if (value1 === undefined || value2 === undefined) {
      throw new Error(SPARSE_ARRAY_ERROR);
    }
    if (Number.isNaN(value1) || Number.isNaN(value2)) {
      throw new Error(NAN_INPUT_ERROR);
    }
  }
}

/**
 * Calculate cosine similarity between two embeddings.
 *
 * @param embedding1 - Array of numbers
 * @param embedding2 - Array of numbers
 * @throws {Error} If embeddings have different dimensions, are empty, sparse, or contain NaN.
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

  let i = 0;
  // Unrolled loop (stride 4) with optimistic execution for hot-path performance.
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding1[i] as number;
    const v2 = embedding2[i] as number;
    const v3 = embedding1[i + 1] as number;
    const v4 = embedding2[i + 1] as number;
    const v5 = embedding1[i + 2] as number;
    const v6 = embedding2[i + 2] as number;
    const v7 = embedding1[i + 3] as number;
    const v8 = embedding2[i + 3] as number;

    dotProduct += v1 * v2 + v3 * v4 + v5 * v6 + v7 * v8;
    norm1 += v1 * v1 + v3 * v3 + v5 * v5 + v7 * v7;
    norm2 += v2 * v2 + v4 * v4 + v6 * v6 + v8 * v8;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i] as number;
    const v2 = embedding2[i] as number;
    dotProduct += v1 * v2;
    norm1 += v1 * v1;
    norm2 += v2 * v2;
  }

  if (Number.isNaN(dotProduct) || Number.isNaN(norm1) || Number.isNaN(norm2)) {
    validatePairedArrayValues(embedding1, embedding2, len);
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
 * @throws {Error} If embeddings have different dimensions, are empty, sparse, or contain NaN.
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

  let i = 0;
  // Unrolled loop (stride 4) with optimistic execution for hot-path performance.
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding1[i] as number;
    const v2 = embedding2[i] as number;
    const v3 = embedding1[i + 1] as number;
    const v4 = embedding2[i + 1] as number;
    const v5 = embedding1[i + 2] as number;
    const v6 = embedding2[i + 2] as number;
    const v7 = embedding1[i + 3] as number;
    const v8 = embedding2[i + 3] as number;

    const diff1 = v1 - v2;
    const diff2 = v3 - v4;
    const diff3 = v5 - v6;
    const diff4 = v7 - v8;

    squaredDistance += diff1 * diff1 + diff2 * diff2 + diff3 * diff3 + diff4 * diff4;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i] as number;
    const v2 = embedding2[i] as number;
    const diff = v1 - v2;
    squaredDistance += diff * diff;
  }

  if (Number.isNaN(squaredDistance)) {
    validatePairedArrayValues(embedding1, embedding2, len);
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
 * @throws {Error} If embeddings have different dimensions, are empty, sparse, or contain NaN.
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

  let i = 0;
  // Unrolled loop (stride 4) with optimistic execution for hot-path performance.
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding1[i] as number;
    const v2 = embedding2[i] as number;
    const v3 = embedding1[i + 1] as number;
    const v4 = embedding2[i + 1] as number;
    const v5 = embedding1[i + 2] as number;
    const v6 = embedding2[i + 2] as number;
    const v7 = embedding1[i + 3] as number;
    const v8 = embedding2[i + 3] as number;

    dotProduct += v1 * v2 + v3 * v4 + v5 * v6 + v7 * v8;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i] as number;
    const v2 = embedding2[i] as number;
    dotProduct += v1 * v2;
  }

  if (Number.isNaN(dotProduct)) {
    validatePairedArrayValues(embedding1, embedding2, len);
  }

  return {
    similarity: dotProduct,
    distance: -dotProduct,
    method: 'dot_product',
  };
}

/**
 * Normalize an embedding vector to unit length
 *
 * @throws {Error} If embedding is empty, sparse, or contains NaN.
 */
export function normalize(embedding: number[]): number[] {
  const len = embedding.length;
  if (len === 0) {
    throw new Error('Embeddings must not be empty');
  }

  let norm = 0;
  let i = 0;
  const len4 = len - (len % 4);

  // Unrolled loop (stride 4) with optimistic execution for hot-path performance.
  for (; i < len4; i += 4) {
    const v1 = embedding[i] as number;
    const v2 = embedding[i + 1] as number;
    const v3 = embedding[i + 2] as number;
    const v4 = embedding[i + 3] as number;

    norm += v1 * v1 + v2 * v2 + v3 * v3 + v4 * v4;
  }

  for (; i < len; i++) {
    const val = embedding[i] as number;
    norm += val * val;
  }

  if (Number.isNaN(norm)) {
    validateArrayValues(embedding, len);
  }

  if (norm === 0) {
    return embedding;
  }

  const normSqrt = Math.sqrt(norm);
  const result = new Array<number>(len);

  i = 0;
  for (; i < len4; i += 4) {
    result[i] = (embedding[i] as number) / normSqrt;
    result[i + 1] = (embedding[i + 1] as number) / normSqrt;
    result[i + 2] = (embedding[i + 2] as number) / normSqrt;
    result[i + 3] = (embedding[i + 3] as number) / normSqrt;
  }

  for (; i < len; i++) {
    const val = embedding[i] as number;
    result[i] = val / normSqrt;
  }
  return result;
}

/**
 * Calculate the magnitude (L2 norm) of an embedding vector
 *
 * @throws {Error} If embedding is empty, sparse, or contains NaN.
 */
export function magnitude(embedding: number[]): number {
  const len = embedding.length;
  if (len === 0) {
    throw new Error('Embeddings must not be empty');
  }

  let sum = 0;
  let i = 0;
  // Unrolled loop (stride 4) with optimistic execution for hot-path performance.
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding[i] as number;
    const v2 = embedding[i + 1] as number;
    const v3 = embedding[i + 2] as number;
    const v4 = embedding[i + 3] as number;

    sum += v1 * v1 + v2 * v2 + v3 * v3 + v4 * v4;
  }

  for (; i < len; i++) {
    const val = embedding[i] as number;
    sum += val * val;
  }

  if (Number.isNaN(sum)) {
    validateArrayValues(embedding, len);
  }

  return Math.sqrt(sum);
}
