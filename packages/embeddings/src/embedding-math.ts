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

    if (v1 === undefined || v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v3 === undefined || v4 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v5 === undefined || v6 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v7 === undefined || v8 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }

    dotProduct += v1 * v2 + v3 * v4 + v5 * v6 + v7 * v8;
    norm1 += v1 * v1 + v3 * v3 + v5 * v5 + v7 * v7;
    norm2 += v2 * v2 + v4 * v4 + v6 * v6 + v8 * v8;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    if (v1 === undefined || v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
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

    if (v1 === undefined || v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v3 === undefined || v4 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v5 === undefined || v6 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v7 === undefined || v8 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }

    const diff1 = v1 - v2;
    const diff2 = v3 - v4;
    const diff3 = v5 - v6;
    const diff4 = v7 - v8;

    squaredDistance += diff1 * diff1 + diff2 * diff2 + diff3 * diff3 + diff4 * diff4;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    if (v1 === undefined || v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    const diff = v1 - v2;
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

    if (v1 === undefined || v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v3 === undefined || v4 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v5 === undefined || v6 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v7 === undefined || v8 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }

    dotProduct += v1 * v2 + v3 * v4 + v5 * v6 + v7 * v8;
  }

  for (; i < len; i++) {
    const v1 = embedding1[i];
    const v2 = embedding2[i];
    if (v1 === undefined || v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    dotProduct += v1 * v2;
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

    if (v1 === undefined || v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v3 === undefined || v4 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }

    norm += v1 * v1 + v2 * v2 + v3 * v3 + v4 * v4;
  }

  for (; i < len; i++) {
    const val = embedding[i];
    if (val === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    norm += val * val;
  }

  if (norm === 0) {
    return embedding;
  }

  const normSqrt = Math.sqrt(norm);
  const result = new Array<number>(len);

  i = 0;
  // Unrolled loop (stride 4)
  for (; i < len4; i += 4) {
    const v1 = embedding[i];
    const v2 = embedding[i + 1];
    const v3 = embedding[i + 2];
    const v4 = embedding[i + 3];

    if (v1 === undefined || v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v3 === undefined || v4 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }

    result[i] = v1 / normSqrt;
    result[i + 1] = v2 / normSqrt;
    result[i + 2] = v3 / normSqrt;
    result[i + 3] = v4 / normSqrt;
  }

  for (; i < len; i++) {
    const val = embedding[i];
    if (val === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    result[i] = val / normSqrt;
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
  let i = 0;
  // Unrolled loop (stride 4)
  const len4 = len - (len % 4);
  for (; i < len4; i += 4) {
    const v1 = embedding[i];
    const v2 = embedding[i + 1];
    const v3 = embedding[i + 2];
    const v4 = embedding[i + 3];

    if (v1 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v2 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v3 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    if (v4 === undefined) {
      throw new Error('Sparse arrays are not supported');
    }

    sum += v1 * v1 + v2 * v2 + v3 * v3 + v4 * v4;
  }

  for (; i < len; i++) {
    const val = embedding[i];
    if (val === undefined) {
      throw new Error('Sparse arrays are not supported');
    }
    sum += val * val;
  }
  return Math.sqrt(sum);
}
