import type { SimilarityResult } from './types';

/**
 * Calculate cosine similarity between two embeddings.
 *
 * Implementation notes:
 * - Uses 4x loop unrolling with inline validation for fail-fast behavior
 * - Inline validation catches sparse arrays and NaN/Infinity values early
 * - Trade-off: validation overhead vs fail-fast behavior
 *
 * Run `pnpm bench` in packages/embeddings to see performance characteristics.
 *
 * @param embedding1 - Dense array of numbers (no holes/undefined values)
 * @param embedding2 - Dense array of numbers (no holes/undefined values)
 * @throws {Error} If embeddings have different dimensions, are empty, or contain invalid values.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Unrolled loop with inline validation for fail-fast error detection - see benchmark in __benchmarks__/embedding-math.bench.ts
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

  const remainder = len % 4;
  const loopEnd = len - remainder;

  for (let i = 0; i < loopEnd; i += 4) {
    const v10 = embedding1[i];
    const v20 = embedding2[i];
    if (v10 === undefined || !Number.isFinite(v10) || v20 === undefined || !Number.isFinite(v20)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    dotProduct += v10 * v20;
    norm1 += v10 * v10;
    norm2 += v20 * v20;

    const v11 = embedding1[i + 1];
    const v21 = embedding2[i + 1];
    if (v11 === undefined || !Number.isFinite(v11) || v21 === undefined || !Number.isFinite(v21)) {
      throw new Error(`Invalid value at index ${i + 1}`);
    }
    dotProduct += v11 * v21;
    norm1 += v11 * v11;
    norm2 += v21 * v21;

    const v12 = embedding1[i + 2];
    const v22 = embedding2[i + 2];
    if (v12 === undefined || !Number.isFinite(v12) || v22 === undefined || !Number.isFinite(v22)) {
      throw new Error(`Invalid value at index ${i + 2}`);
    }
    dotProduct += v12 * v22;
    norm1 += v12 * v12;
    norm2 += v22 * v22;

    const v13 = embedding1[i + 3];
    const v23 = embedding2[i + 3];
    if (v13 === undefined || !Number.isFinite(v13) || v23 === undefined || !Number.isFinite(v23)) {
      throw new Error(`Invalid value at index ${i + 3}`);
    }
    dotProduct += v13 * v23;
    norm1 += v13 * v13;
    norm2 += v23 * v23;
  }

  // Handle remainder
  for (let i = loopEnd; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    if (v1 === undefined || !Number.isFinite(v1) || v2 === undefined || !Number.isFinite(v2)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    dotProduct += v1 * v2;
    norm1 += v1 * v1;
    norm2 += v2 * v2;
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
    const v10 = embedding1[i];
    const v20 = embedding2[i];
    if (v10 === undefined || !Number.isFinite(v10) || v20 === undefined || !Number.isFinite(v20)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    const d0 = v10 - v20;
    squaredDistance += d0 * d0;

    const v11 = embedding1[i + 1];
    const v21 = embedding2[i + 1];
    if (v11 === undefined || !Number.isFinite(v11) || v21 === undefined || !Number.isFinite(v21)) {
      throw new Error(`Invalid value at index ${i + 1}`);
    }
    const d1 = v11 - v21;
    squaredDistance += d1 * d1;

    const v12 = embedding1[i + 2];
    const v22 = embedding2[i + 2];
    if (v12 === undefined || !Number.isFinite(v12) || v22 === undefined || !Number.isFinite(v22)) {
      throw new Error(`Invalid value at index ${i + 2}`);
    }
    const d2 = v12 - v22;
    squaredDistance += d2 * d2;

    const v13 = embedding1[i + 3];
    const v23 = embedding2[i + 3];
    if (v13 === undefined || !Number.isFinite(v13) || v23 === undefined || !Number.isFinite(v23)) {
      throw new Error(`Invalid value at index ${i + 3}`);
    }
    const d3 = v13 - v23;
    squaredDistance += d3 * d3;
  }

  for (let i = loopEnd; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    if (v1 === undefined || !Number.isFinite(v1) || v2 === undefined || !Number.isFinite(v2)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    const diff = v1 - v2;
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
    const v10 = embedding1[i];
    const v20 = embedding2[i];
    if (v10 === undefined || !Number.isFinite(v10) || v20 === undefined || !Number.isFinite(v20)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    dotProduct += v10 * v20;

    const v11 = embedding1[i + 1];
    const v21 = embedding2[i + 1];
    if (v11 === undefined || !Number.isFinite(v11) || v21 === undefined || !Number.isFinite(v21)) {
      throw new Error(`Invalid value at index ${i + 1}`);
    }
    dotProduct += v11 * v21;

    const v12 = embedding1[i + 2];
    const v22 = embedding2[i + 2];
    if (v12 === undefined || !Number.isFinite(v12) || v22 === undefined || !Number.isFinite(v22)) {
      throw new Error(`Invalid value at index ${i + 2}`);
    }
    dotProduct += v12 * v22;

    const v13 = embedding1[i + 3];
    const v23 = embedding2[i + 3];
    if (v13 === undefined || !Number.isFinite(v13) || v23 === undefined || !Number.isFinite(v23)) {
      throw new Error(`Invalid value at index ${i + 3}`);
    }
    dotProduct += v13 * v23;
  }

  for (let i = loopEnd; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    if (v1 === undefined || !Number.isFinite(v1) || v2 === undefined || !Number.isFinite(v2)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    dotProduct += v1 * v2;
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Unrolled loop with inline validation for fail-fast error detection
export function normalize(embedding: number[]): number[] {
  const len = embedding.length;
  if (len === 0) {
    throw new Error('Embeddings must not be empty');
  }

  let norm = 0;
  const remainder = len % 4;
  const loopEnd = len - remainder;

  for (let i = 0; i < loopEnd; i += 4) {
    const v0 = embedding[i];
    if (v0 === undefined || !Number.isFinite(v0)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    norm += v0 * v0;

    const v1 = embedding[i + 1];
    if (v1 === undefined || !Number.isFinite(v1)) {
      throw new Error(`Invalid value at index ${i + 1}`);
    }
    norm += v1 * v1;

    const v2 = embedding[i + 2];
    if (v2 === undefined || !Number.isFinite(v2)) {
      throw new Error(`Invalid value at index ${i + 2}`);
    }
    norm += v2 * v2;

    const v3 = embedding[i + 3];
    if (v3 === undefined || !Number.isFinite(v3)) {
      throw new Error(`Invalid value at index ${i + 3}`);
    }
    norm += v3 * v3;
  }

  for (let i = loopEnd; i < len; i++) {
    const val = embedding[i];
    if (val === undefined || !Number.isFinite(val)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    norm += val * val;
  }

  if (norm === 0) {
    return embedding; // Return as-is if zero vector
  }

  const normSqrt = Math.sqrt(norm);
  // Use for loop to preserve optimization (avoid .map() overhead)
  const result = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    // biome-ignore lint/style/noNonNullAssertion: Values guaranteed valid from validation loop above
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
  const remainder = len % 4;
  const loopEnd = len - remainder;

  for (let i = 0; i < loopEnd; i += 4) {
    const v0 = embedding[i];
    if (v0 === undefined || !Number.isFinite(v0)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    sum += v0 * v0;

    const v1 = embedding[i + 1];
    if (v1 === undefined || !Number.isFinite(v1)) {
      throw new Error(`Invalid value at index ${i + 1}`);
    }
    sum += v1 * v1;

    const v2 = embedding[i + 2];
    if (v2 === undefined || !Number.isFinite(v2)) {
      throw new Error(`Invalid value at index ${i + 2}`);
    }
    sum += v2 * v2;

    const v3 = embedding[i + 3];
    if (v3 === undefined || !Number.isFinite(v3)) {
      throw new Error(`Invalid value at index ${i + 3}`);
    }
    sum += v3 * v3;
  }

  for (let i = loopEnd; i < len; i++) {
    const val = embedding[i];
    if (val === undefined || !Number.isFinite(val)) {
      throw new Error(`Invalid value at index ${i}`);
    }
    sum += val * val;
  }
  return Math.sqrt(sum);
}
