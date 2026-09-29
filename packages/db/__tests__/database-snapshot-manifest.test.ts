import { describe, expect, it } from 'vitest';
import {
  DATABASE_SNAPSHOT_METHODS,
  DATABASE_SNAPSHOT_REASONS,
  parseDatabaseSnapshotManifest,
} from '../src/database-snapshot-manifest.js';

const FINDING = {
  accessMethod: 'btree',
  check: 'btree',
  durability: 'derived',
  message: 'invalid page in block 1',
  relation: 'file_chunks_pkey',
  relationKind: 'index',
  sqlstate: 'XX001',
  table: 'file_chunks',
};

const CLEAN_INTEGRITY = {
  checkedRelations: 680,
  crashSensitiveIndexesRebuilt: ['idx_file_chunks_content_bm25'],
  durationMs: 7012.5,
  findings: [],
  findingsTruncated: false,
  status: 'clean',
  unverifiableReason: null,
};

/** A clean, fully verified manifest, as the writer emits it; `overrides` replace whole top-level keys. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appVersion: '1.2.3',
    byteSize: 2_300_000_000,
    cleanClose: true,
    createdAt: '2026-09-29T10:15:30.123Z',
    engine: {
      extensions: { pg_textsearch: '1.3.1', vector: '0.8.1' },
      serverVersion: '18.3',
    },
    id: '20260929T101530123Z-pre-update-a1b2c3',
    integrity: CLEAN_INTEGRITY,
    ledgerHead: 'custom-144-agent-family-colors',
    method: 'cold-clone',
    profile: 'default',
    reason: 'pre-update',
    rowCountsByDurability: {
      derived: 120_000,
      operational: 50,
      precious: 4000,
      'schema-ledger': 145,
      unclassified: 0,
    },
    schemaVersion: 1,
    sourceShutdown: 'unclean',
    tables: [
      { durability: 'derived', rows: 120_000, table: 'file_chunks' },
      { durability: 'precious', rows: 4000, table: 'mastra_messages' },
    ],
    timeMachine: 'included',
    timings: { cloneMs: 900, fsyncMs: 1200, holdMs: null, verifyMs: 14_000 },
    unknownLedgerEntries: 0,
    verified: true,
    ...overrides,
  };
}

const withIntegrity = (overrides: Record<string, unknown>) =>
  ({ ...CLEAN_INTEGRITY, ...overrides }) as Record<string, unknown>;

const damaged = (findings: readonly object[] = [FINDING]) =>
  manifest({ integrity: withIntegrity({ findings, status: 'damaged' }), verified: false });

describe('parseDatabaseSnapshotManifest', () => {
  it('returns a valid manifest unchanged, through a JSON round trip', () => {
    expect(parseDatabaseSnapshotManifest(JSON.parse(JSON.stringify(manifest())))).toEqual(
      manifest()
    );
  });

  it('accepts a damaged manifest with findings, and an unverifiable one with its reason', () => {
    const parsedDamaged = parseDatabaseSnapshotManifest(damaged());
    expect(parsedDamaged.integrity.findings).toEqual([FINDING]);
    expect(parsedDamaged.verified).toBe(false);

    const unverifiable = manifest({
      integrity: withIntegrity({
        status: 'unverifiable',
        unverifiableReason: 'verifier timed out',
      }),
      timings: { cloneMs: 900, fsyncMs: 1200, holdMs: 2400, verifyMs: 0 },
      verified: false,
    });
    expect(parseDatabaseSnapshotManifest(unverifiable).integrity.unverifiableReason).toBe(
      'verifier timed out'
    );
  });

  it('accepts a snapshot with no ledger head yet', () => {
    expect(parseDatabaseSnapshotManifest(manifest({ ledgerHead: null })).ledgerHead).toBeNull();
  });

  const missingSchemaVersion = Object.fromEntries(
    Object.entries(manifest()).filter(([key]) => key !== 'schemaVersion')
  );

  it.each([
    ['an unknown top-level key', manifest({ extra: 1 }), /extra/u],
    [
      'an unknown key inside integrity',
      manifest({ integrity: withIntegrity({ extra: 1 }) }),
      /extra/u,
    ],
    ['an unknown key inside a finding', damaged([{ ...FINDING, detail: 'x' }]), /detail/u],
    ['an unknown schemaVersion', manifest({ schemaVersion: 2 }), /schemaVersion/u],
    ['a missing schemaVersion', missingSchemaVersion, /schemaVersion/u],
    ['a byteSize given as text', manifest({ byteSize: '5' }), /byteSize/u],
    ['a negative byteSize', manifest({ byteSize: -1 }), /byteSize/u],
    [
      'a fractional row count',
      manifest({ tables: [{ durability: 'derived', rows: 1.5, table: 't' }] }),
      /rows/u,
    ],
    ['an unknown reason', manifest({ reason: 'whenever' }), /reason/u],
    ['an unknown method', manifest({ method: 'rsync' }), /method/u],
    ['an unknown sourceShutdown', manifest({ sourceShutdown: 'closed' }), /sourceShutdown/u],
    [
      'a table class outside the registry classes',
      manifest({ tables: [{ durability: 'catalog', rows: 1, table: 't' }] }),
      /durability/u,
    ],
    [
      'a finding message over 240 characters',
      damaged([{ ...FINDING, message: 'x'.repeat(241) }]),
      /message/u,
    ],
    [
      'a createdAt that is not an ISO UTC timestamp',
      manifest({ createdAt: 'yesterday' }),
      /createdAt/u,
    ],
    ['an id that escapes its directory', manifest({ id: '../evil' }), /id/u],
    ['an id that marks an unfinished snapshot', manifest({ id: 'abc.partial' }), /id/u],
    ['a profile that is not one path segment', manifest({ profile: 'a/b' }), /profile/u],
  ])('rejects %s, naming the field', (_label, input, field) => {
    expect(() => parseDatabaseSnapshotManifest(input)).toThrow(TypeError);
    expect(() => parseDatabaseSnapshotManifest(input)).toThrow(field);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'manifest'],
    ['a number', 7],
    ['an empty array', []],
    ['an array holding a manifest', [manifest()]],
  ])('rejects %s, which is not a manifest object', (_label, input) => {
    expect(() => parseDatabaseSnapshotManifest(input)).toThrow(TypeError);
  });

  it('rejects a manifest that claims verified while the check found problems', () => {
    const claimed = manifest({
      integrity: withIntegrity({ findings: [FINDING], status: 'damaged' }),
    });
    expect(() => parseDatabaseSnapshotManifest(claimed)).toThrow(/verified/u);
  });

  it('rejects a manifest that claims verified while a table has no row count', () => {
    const uncounted = manifest({
      tables: [{ durability: 'derived', rows: null, table: 'file_chunks' }],
    });
    expect(() => parseDatabaseSnapshotManifest(uncounted)).toThrow(/verified/u);
  });

  it('rejects a manifest that denies verification to a clean, fully counted check', () => {
    expect(() => parseDatabaseSnapshotManifest(manifest({ verified: false }))).toThrow(/verified/u);
  });
});

describe('snapshot vocabularies', () => {
  it('lists the reasons and methods the design names', () => {
    expect(DATABASE_SNAPSHOT_REASONS).toEqual([
      'pre-migration',
      'pre-update',
      'pre-repair',
      'post-repair',
      'daily',
      'manual',
      'imported',
    ]);
    expect(DATABASE_SNAPSHOT_METHODS).toEqual(['online-clone', 'cold-clone', 'cold-copy']);
  });
});
