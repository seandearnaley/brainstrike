/**
 * Performance benchmarks for embedding-math.ts
 *
 * Run with: pnpm bench
 *
 * These benchmarks validate the performance of the embedding math functions.
 */
import { describe, test } from 'vitest';
import {
  calculateCosineSimilarity,
  calculateDotProduct,
  calculateL2Distance,
  magnitude,
  normalize,
} from '../embedding-math.js';

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

    test(`cosine (${name})`, async ({ bench }) => {
      await bench(`cosine (${name})`, () => {
        calculateCosineSimilarity(a, b);
      }).run();
    });
  }
});

describe('L2 Distance', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);
    const b = generateEmbedding(size);

    test(`l2 (${name})`, async ({ bench }) => {
      await bench(`l2 (${name})`, () => {
        calculateL2Distance(a, b);
      }).run();
    });
  }
});

describe('Dot Product', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);
    const b = generateEmbedding(size);

    test(`dot (${name})`, async ({ bench }) => {
      await bench(`dot (${name})`, () => {
        calculateDotProduct(a, b);
      }).run();
    });
  }
});

describe('Magnitude', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);

    test(`magnitude (${name})`, async ({ bench }) => {
      await bench(`magnitude (${name})`, () => {
        magnitude(a);
      }).run();
    });
  }
});

describe('Normalize', () => {
  for (const [name, size] of Object.entries(EMBEDDING_SIZES)) {
    const a = generateEmbedding(size);

    test(`normalize (${name})`, async ({ bench }) => {
      await bench(`normalize (${name})`, () => {
        normalize(a);
      }).run();
    });
  }
});
