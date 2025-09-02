import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';

describe('EmbeddingSetsRepository', () => {
  let db: PGlite;
  let repo: EmbeddingSetsRepository;

  beforeEach(async () => {
    db = new PGlite('memory://');
    await migrate(db);
    repo = new EmbeddingSetsRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('getOrCreateSet returns stable set for same composite key', async () => {
    const set1 = await repo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 1024, 'cosine');
    const set2 = await repo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 1024, 'cosine');
    expect(set1.id).toBe(set2.id);
    expect(set1.dimensions).toBe(1024);
    expect(set1.distance).toBe('cosine');
  });

  it('getByModelKey lists sets for a key', async () => {
    await repo.getOrCreateSet('miniLM', 'Xenova/all-MiniLM-L6-v2', 384, 'cosine');
    await repo.getOrCreateSet('miniLM', 'Xenova/all-MiniLM-L6-v2', 384, 'ip');
    const sets = await repo.getByModelKey('miniLM');
    const distances = new Set(sets.map((s) => s.distance));
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(distances.has('cosine')).toBe(true);
    expect(distances.has('ip')).toBe(true);
  });

  it('getById returns specific set', async () => {
    const created = await repo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 1024, 'cosine');
    const fetched = await repo.getById(created.id);
    expect(fetched?.id).toBe(created.id);
  });
});
