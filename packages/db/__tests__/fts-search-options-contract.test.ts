import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { FTSSearchOptions } from '../src/models/file-chunk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');

function read(relative: string): string {
  return readFileSync(path.join(SRC, relative), 'utf8');
}

/**
 * BST-908: `rankNormalization` was a ts_rank-era knob that became a silent
 * no-op once ordering moved to BM25 (migration 066). A public option that
 * callers can set and that changes nothing is exactly the silent-fallback
 * class the repo forbids, so the field is gone and must stay gone.
 */
describe('FTSSearchOptions contract (BST-908)', () => {
  it('does not declare the inert rankNormalization option', () => {
    expectTypeOf<FTSSearchOptions>().not.toHaveProperty('rankNormalization');
    expect(read('models/file-chunk.ts')).not.toMatch(/rankNormalization/u);
  });

  it('no repository reads a rankNormalization option', () => {
    for (const file of [
      'repositories/file-chunk-repository.ts',
      'repositories/drizzle/file-chunk-repository.ts',
      'repositories/electron-file-chunk-repository.ts',
      'search/hybrid-search-service.ts',
    ]) {
      expect(read(file), file).not.toMatch(/rankNormalization/u);
    }
  });

  it('documents at every BM25 ranking site that BM25 orders but never matches', () => {
    // Recall is bounded by the tsvector arm: a row BM25 would score but
    // `@@ tsquery` rejects is invisible to fusion. Anyone tuning ftsWeight
    // needs that stated where the ranking expression lives.
    for (const file of [
      'repositories/_shared.ts',
      'repositories/drizzle/file-chunk-repository.ts',
    ]) {
      const source = read(file);
      expect(source, file).toMatch(/to_bm25query/u);
      expect(source, file).toMatch(/BM25 (orders|ranks)[^\n]*never matches/u);
    }
  });
});
