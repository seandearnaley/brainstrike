import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { FTSSearchOptions } from '../src/models/file-chunk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');

function read(relative: string): string {
  return readFileSync(path.join(SRC, relative), 'utf8');
}

/** Every TypeScript source under `packages/db/src`, so a new read site cannot escape the guard. */
function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
    } else if (/\.tsx?$/u.test(entry.name)) {
      yield full;
    }
  }
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
  });

  it('nothing under packages/db/src declares or reads rankNormalization', () => {
    let scanned = 0;
    for (const file of sourceFiles(SRC)) {
      scanned += 1;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/rankNormalization/u);
    }
    // The walk must actually have covered the models + repositories tree.
    expect(scanned).toBeGreaterThan(50);
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
      // Spans a comment wrap: the fact is one statement, its line break is not.
      expect(source, file).toMatch(/BM25\s+(orders|ranks)[\s\S]{0,80}?never\s+matches/u);
    }
  });
});
