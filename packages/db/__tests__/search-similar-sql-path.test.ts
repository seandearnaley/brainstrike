import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('searchSimilar SQL path guards', () => {
  it('requires embeddingSetId when vectorEnabled', async () => {
    const db: PGlite = await wasmLoader.createPGlite('memory://sql-guard');
    await migrate(db);
    const repo = new FileChunkRepository(db);
    await expect(repo.searchSimilar([0.1, 0.2, 0.3], { limit: 5 })).rejects.toThrowError(
      /requires embeddingSetId/
    );
  });
});
