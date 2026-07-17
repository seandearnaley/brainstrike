/**
 * Performance benchmarks for embedding-math.ts
 *
 * Run with: pnpm bench
 *
 * These benchmarks validate the performance of the embedding math functions.
 */
import { bench, describe } from 'vitest';
import {
  calculateCosineSimilarity,
  calculateDotProduct,
  calculateL2Distance,
  magnitude,
  normalize,
} from '../embedding-math';

// Generate random embeddings of various sizes (common model dimensions)
function generateEmbedding(size: number): number[] {
  const result = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    result[i] = Math.random() * 2 - 1;
  }
  return result;
}

// Embedding sizes based on common models
const EMBEDDING_SIZES = {
  'bert-768': 768,
  'openai-1536': 1536,
  'openai-3072': 3072,
  'sentence-bert-384': 384,
};

describe('Cosine Similarity', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);
    const b = generateEmbedding(size);

    bench(`cosine (${name})`, () => {
      calculateCosineSimilarity(a, b);
    });
  }
});

describe('L2 Distance', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);
    const b = generateEmbedding(size);

    bench(`l2 (${name})`, () => {
      calculateL2Distance(a, b);
    });
  }
});

describe('Dot Product', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);
    const b = generateEmbedding(size);

    bench(`dot (${name})`, () => {
      calculateDotProduct(a, b);
    });
  }
});

describe('Magnitude', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);

    bench(`magnitude (${name})`, () => {
      magnitude(a);
    });
  }
});

describe('Normalize', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);

    bench(`normalize (${name})`, () => {
      normalize(a);
    });
  }
});
