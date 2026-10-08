import type Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { IndexFileBinding, VectorProfile } from '../src/contracts.js';
import { vectorProfileHash } from '../src/scope-authority.js';
import { scopeCoverageBatch } from '../src/scoped-proofs.js';
import { ScopedIndex } from '../src/scoped-store.js';

const profile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'fp16',
  modelId: 'model-a',
  provider: 'local',
  revision: 'a'.repeat(40),
  tokenCap: 256,
} as const;
const workspace = { kind: 'workspace', rootId: 'root' } as const;
const collection = { embeddingSetId: 'collection', kind: 'collection' } as const;
const binding: IndexFileBinding = {
  embeddingSetId: 'collection',
  fileId: 'file',
  profile,
  relativePath: 'file.txt',
  rootId: 'root',
  sourcePath: null,
};

/** Driver seam: every query must execute inside the owned transaction; validators are real. */
function fixture(secondProfile: VectorProfile = profile) {
  const files = [
    binding,
    {
      ...binding,
      embeddingSetId: 'imports',
      fileId: 'import',
      profile: secondProfile,
      relativePath: null,
      rootId: null,
      sourcePath: '/imports/file.txt',
    },
  ];
  const profiles = new Map(files.map((file) => [vectorProfileHash(file.profile!), file.profile!]));
  let active = false;
  let transactions = 0;
  let corruption: 'bytes' | 'ownership' | 'coarse' | 'profile' | 'binding' | 'chunks' | null = null;
  const scans: string[] = [];
  const bindingQueries: string[][] = [];
  const prepare = (sql: string) => {
    const assertSnapshot = () => {
      if (!active) {
        throw new Error('Read escaped its SQLite snapshot');
      }
    };
    const statement = {
      all: (value: string) => {
        assertSnapshot();
        if (sql.includes('FROM vector_profiles')) {
          const selected = profiles.get(value)!;
          return [
            {
              dimensions: corruption === 'profile' ? 8 : selected.dimensions,
              hash: value,
              json: JSON.stringify(selected),
            },
          ];
        }
        if (sql.includes('FROM file_records WHERE scoped=1')) {
          const ids = JSON.parse(value) as string[];
          bindingQueries.push(ids);
          return files
            .filter((file) => ids.includes(file.fileId))
            .map(({ profile: _profile, ...file }) => ({
              ...file,
              ...(corruption === 'binding' ? { sourcePath: '/changed' } : {}),
            }));
        }
        throw new Error(`Unexpected all: ${sql}`);
      },
      get: (_hash?: string, value?: string) => {
        assertSnapshot();
        if (sql.includes('count(DISTINCT f.id)')) {
          return {
            chunks: value === 'root' ? 2 : 3,
            indexedFiles: 1,
            vectors: value === 'root' ? 2 : 3,
          };
        }
        if (sql.includes('FROM index_metadata')) {
          return {
            indexMode: 'text-only',
            profileHash: null,
            profileJson: null,
            schemaVersion: 10,
            storeId: 'a'.repeat(64),
          };
        }
        if (sql.startsWith('SELECT epoch')) {
          return 'b'.repeat(64);
        }
        if (sql.startsWith('SELECT count(*)')) {
          if (
            corruption === 'ownership' &&
            sql.includes('FROM scoped_vectors v LEFT JOIN file_chunks')
          ) {
            return 1;
          }
          if (corruption === 'coarse' && sql.includes('vec_quantize_binary')) {
            return 1;
          }
          if (corruption === 'chunks' && sql.includes('FROM file_chunks c JOIN file_records')) {
            return 1;
          }
          return 0;
        }
        throw new Error(`Unexpected get: ${sql}`);
      },
      iterate: (hash: string) => {
        assertSnapshot();
        scans.push(hash);
        const emb = new Uint8Array(profiles.get(hash)!.dimensions * 4);
        new DataView(emb.buffer).setFloat32(0, corruption === 'bytes' ? Number.NaN : 1, true);
        return [{ dimensions: profiles.get(hash)!.dimensions, emb }];
      },
      pluck: () => statement,
    };
    return statement;
  };
  const db = {
    prepare,
    transaction:
      <T>(work: () => T) =>
      () => {
        if (active) {
          throw new Error('Unexpected nested transaction');
        }
        transactions += 1;
        active = true;
        try {
          return work();
        } finally {
          active = false;
        }
      },
  } as unknown as Database.Database;
  const index = new ScopedIndex(db, {
    dbPath: '/unused',
    embedding: { indexMode: 'text-only' },
    fileBindings: files,
    rootIds: ['root'],
    scopes: [collection, { embeddingSetId: 'imports', kind: 'collection' }],
  });
  return {
    bindingQueries,
    corrupt: (kind: Exclude<typeof corruption, null> = 'bytes') => {
      corruption = kind;
    },
    db,
    index,
    scans,
    transactions: () => transactions,
  };
}

it('validates a shared complete profile once inside one snapshot and retains independent scope counts', () => {
  const f = fixture();
  const results = f.index.coverageBatch([
    { profile, scope: workspace },
    { profile, scope: collection },
  ]);
  expect(results.map((result) => result.counts.chunks)).toEqual([2, 3]);
  expect(results.map((result) => result.scope)).toEqual([workspace, collection]);
  expect(results.every((result) => result.vectorCoverageComplete)).toBe(true);
  expect(f.transactions()).toBe(1);
  expect(f.scans).toEqual([vectorProfileHash(profile)]);
  expect(f.bindingQueries).toEqual([['file']]);
  expect(f.index.coverage({ profile, scope: workspace })).toEqual(results[0]);
  expect(f.scans).toHaveLength(2);
  expect(f.bindingQueries).toEqual([['file'], ['file']]);
});

it('does not reuse successful validation after vector bytes become corrupt', () => {
  const f = fixture();
  f.index.coverageBatch([
    { profile, scope: workspace },
    { profile, scope: collection },
  ]);
  f.corrupt();
  expect(() => f.index.coverageBatch([{ profile, scope: workspace }])).toThrow('finite');
  expect(f.transactions()).toBe(2);
  expect(f.scans).toHaveLength(2);
});

it('validates each distinct complete profile within the same snapshot', () => {
  const other = { ...profile, revision: 'b'.repeat(40) };
  const f = fixture(other);
  const results = f.index.coverageBatch([
    { profile, scope: workspace },
    { profile, scope: collection },
    { scope: { embeddingSetId: 'imports', kind: 'collection' } },
    { profile: other, scope: { embeddingSetId: 'imports', kind: 'collection' } },
  ]);
  expect(results.map((result) => result.profileHash)).toEqual([
    vectorProfileHash(profile),
    vectorProfileHash(profile),
    null,
    vectorProfileHash(other),
  ]);
  expect(f.scans).toEqual([vectorProfileHash(profile), vectorProfileHash(other)]);
  expect(f.bindingQueries).toEqual([['file'], ['import']]);
  expect(f.transactions()).toBe(1);
});

it.each(['ownership', 'coarse', 'profile', 'binding', 'chunks'] as const)(
  'rejects post-success %s corruption rather than reusing a previous batch proof',
  (kind) => {
    const f = fixture();
    f.index.coverageBatch([
      { profile, scope: workspace },
      { profile, scope: collection },
    ]);
    f.corrupt(kind);
    expect(() =>
      f.index.coverageBatch([
        { profile, scope: workspace },
        { profile, scope: collection },
      ])
    ).toThrow();
    expect(f.transactions()).toBe(2);
  }
);
it('refuses unauthorized scope and profile requests before any snapshot work', () => {
  const f = fixture();
  expect(() =>
    f.index.coverageBatch([{ profile, scope: { kind: 'workspace', rootId: 'foreign' } }])
  ).toThrow('not authorized');
  expect(() =>
    f.index.coverageBatch([{ profile: { ...profile, revision: 'c'.repeat(40) }, scope: workspace }])
  ).toThrow('profile differs');
  expect(f.transactions()).toBe(0);
});

it.each(['store', 'store-and-revision', 'epoch', 'revision'] as const)(
  'distinguishes %s mismatch in the failed native snapshot before coverage validation',
  (mismatch) => {
    const f = fixture();
    const [baseline] = f.index.coverageBatch([{ profile, scope: workspace }]);
    if (!baseline) {
      throw new Error('Expected baseline native coverage.');
    }
    const expected = {
      authorityEpoch: mismatch === 'epoch' ? 'd'.repeat(64) : baseline.authorityEpoch,
      authorityRevision:
        mismatch === 'revision' || mismatch === 'store-and-revision'
          ? baseline.authorityRevision + 1
          : baseline.authorityRevision,
      storeId: mismatch.startsWith('store') ? 'c'.repeat(64) : baseline.storeId,
    };
    expect(() =>
      scopeCoverageBatch(f.db, f.index.authority, [{ profile, scope: workspace }], expected)
    ).toThrowError(
      expect.objectContaining({
        code: mismatch.startsWith('store')
          ? 'coverage-store-mismatch'
          : 'coverage-authority-changed',
      })
    );
    expect(f.transactions()).toBe(2);
    expect(f.scans).toHaveLength(1);
  }
);
