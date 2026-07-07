import type { SimilarityResult } from './types';

const SPARSE_ARRAY_ERROR = 'Sparse arrays are not supported';
const NAN_INPUT_ERROR = 'Embeddings must not contain NaN';
const NON_FINITE_INPUT_ERROR = 'Embeddings must contain only finite numbers';
const NON_FINITE_ACCUMULATOR_ERROR = 'Embedding operation produced non-finite intermediate values';

/**
 * Safety contract for hot-path loops:
 * `as number` casts avoid per-element branching in tight loops and intentionally bypass
 * `noUncheckedIndexedAccess` in these hot paths.
 * Sparse/NaN/non-finite inputs poison accumulators and are diagnosed by post-loop finite checks.
 */

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
    // Keep this check before isFinite() so NaN receives a specific diagnostic.
    if (Number.isNaN(value)) {
      throw new Error(NAN_INPUT_ERROR);
    }
    if (!Number.isFinite(value)) {
      throw new Error(NON_FINITE_INPUT_ERROR);
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
    // Keep this check before isFinite() so NaN receives a specific diagnostic.
    if (Number.isNaN(value1) || Number.isNaN(value2)) {
      throw new Error(NAN_INPUT_ERROR);
    }
    if (!(Number.isFinite(value1) && Number.isFinite(value2))) {
      throw new Error(NON_FINITE_INPUT_ERROR);
    }
  }
}

/**
 * Calculate cosine similarity between two embeddings.
 *
 * @param embedding1 - Array of numbers
 * @param embedding2 - Array of numbers
 * @throws {Error} If embeddings have different dimensions, are empty, sparse, or contain non-finite values.
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
    // Casts are intentional: sparse/non-finite checks are deferred to the fallback validation path.
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

  if (!(Number.isFinite(dotProduct) && Number.isFinite(norm1) && Number.isFinite(norm2))) {
    validatePairedArrayValues(embedding1, embedding2, len);
    throw new Error(NON_FINITE_ACCUMULATOR_ERROR);
  }

  if (norm1 === 0 || norm2 === 0) {
    return {
      distance: 1,
      method: 'cosine',
      similarity: 0,
    };
  }

  const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

  return {
    distance: 1 - similarity,
    method: 'cosine',
    similarity,
  };
}

/**
 * Calculate L2 (Euclidean) distance between two embeddings.
 *
 * @param embedding1 - Array of numbers
 * @param embedding2 - Array of numbers
 * @throws {Error} If embeddings have different dimensions, are empty, sparse, or contain non-finite values.
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

  if (!Number.isFinite(squaredDistance)) {
    validatePairedArrayValues(embedding1, embedding2, len);
    throw new Error(NON_FINITE_ACCUMULATOR_ERROR);
  }

  const distance = Math.sqrt(squaredDistance);
  const similarity = 1 / (1 + distance);

  return {
    distance,
    method: 'l2',
    similarity,
  };
}

/**
 * Calculate dot product similarity between two embeddings.
 *
 * @param embedding1 - Array of numbers
 * @param embedding2 - Array of numbers
 * @throws {Error} If embeddings have different dimensions, are empty, sparse, or contain non-finite values.
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

  if (!Number.isFinite(dotProduct)) {
    validatePairedArrayValues(embedding1, embedding2, len);
    throw new Error(NON_FINITE_ACCUMULATOR_ERROR);
  }

  return {
    distance: -dotProduct,
    method: 'dot_product',
    similarity: dotProduct,
  };
}

/**
 * Normalize an embedding vector to unit length
 *
 * @throws {Error} If embedding is empty, sparse, or contains non-finite values.
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

  if (!Number.isFinite(norm)) {
    validateArrayValues(embedding, len);
    throw new Error(NON_FINITE_ACCUMULATOR_ERROR);
  }

  if (norm === 0) {
    return embedding.slice();
  }

  // Optimization: Multiplication is faster than division
  const invNormSqrt = 1 / Math.sqrt(norm);
  const result = new Array<number>(len);

  i = 0;
  for (; i < len4; i += 4) {
    result[i] = (embedding[i] as number) * invNormSqrt;
    result[i + 1] = (embedding[i + 1] as number) * invNormSqrt;
    result[i + 2] = (embedding[i + 2] as number) * invNormSqrt;
    result[i + 3] = (embedding[i + 3] as number) * invNormSqrt;
  }

  for (; i < len; i++) {
    const val = embedding[i] as number;
    result[i] = val * invNormSqrt;
  }
  return result;
}

/**
 * Calculate the magnitude (L2 norm) of an embedding vector
 *
 * @throws {Error} If embedding is empty, sparse, or contains non-finite values.
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

  if (!Number.isFinite(sum)) {
    validateArrayValues(embedding, len);
    throw new Error(NON_FINITE_ACCUMULATOR_ERROR);
  }

  return Math.sqrt(sum);
}
