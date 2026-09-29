/**
 * The `manifest.json` written beside every database snapshot (BST-1877).
 *
 * It is a persisted format read back by a later build, so it is parsed strictly:
 * an unknown key, a wrong type or an unknown `schemaVersion` throws, naming the
 * field, and a directory whose manifest fails is listed as invalid, never
 * deleted. The schema is the single definition: the TypeScript type is derived
 * from it, so the two cannot drift.
 */
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import { relationFindingSchema } from './database-integrity-finding.js';
import { TABLE_DURABILITY_CLASSES } from './table-durability-registry.js';

export const DATABASE_SNAPSHOT_REASONS = [
  'pre-migration',
  'pre-update',
  'pre-repair',
  'post-repair',
  'daily',
  'manual',
  'imported',
] as const;
export type DatabaseSnapshotReason = (typeof DATABASE_SNAPSHOT_REASONS)[number];

export const DATABASE_SNAPSHOT_METHODS = ['online-clone', 'cold-clone', 'cold-copy'] as const;
export type DatabaseSnapshotMethod = (typeof DATABASE_SNAPSHOT_METHODS)[number];

/** A table's class in a manifest: the registry's, or `unclassified` for a table it does not own. */
const TABLE_CLASSES_IN_MANIFEST = [...TABLE_DURABILITY_CLASSES, 'unclassified'] as const;

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const nonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** Ids and profile names become directory names, so they must be one safe path segment. */
const pathSegment = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, {
    message: 'must be one path segment of letters, digits, dot, underscore or dash',
  }),
  Schema.makeFilter((value: string) => !value.endsWith('.partial'), {
    message: 'must not end in .partial, which marks a snapshot still being written',
  })
);

const isoTimestamp = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      const time = Date.parse(value);
      return !Number.isNaN(time) && new Date(time).toISOString() === value;
    },
    { message: 'must be an ISO-8601 UTC timestamp' }
  )
);

const manifestSchema = Schema.Struct({
  appVersion: Schema.String,
  byteSize: nonNegativeInt,
  cleanClose: Schema.Boolean,
  createdAt: isoTimestamp,
  engine: Schema.Struct({
    extensions: Schema.Record(Schema.String, Schema.String),
    serverVersion: Schema.String,
  }),
  id: pathSegment,
  integrity: Schema.Struct({
    checkedRelations: nonNegativeInt,
    crashSensitiveIndexesRebuilt: Schema.Array(Schema.String),
    durationMs: nonNegativeNumber,
    findings: Schema.Array(relationFindingSchema),
    findingsTruncated: Schema.Boolean,
    status: Schema.Literals(['clean', 'damaged', 'unverifiable']),
    unverifiableReason: Schema.NullOr(Schema.String),
  }),
  ledgerHead: Schema.NullOr(Schema.String),
  method: Schema.Literals(DATABASE_SNAPSHOT_METHODS),
  profile: pathSegment,
  reason: Schema.Literals(DATABASE_SNAPSHOT_REASONS),
  rowCountsByDurability: Schema.Struct({
    derived: nonNegativeInt,
    operational: nonNegativeInt,
    precious: nonNegativeInt,
    'schema-ledger': nonNegativeInt,
    unclassified: nonNegativeInt,
  }),
  schemaVersion: Schema.Literal(1),
  sourceShutdown: Schema.Literals(['clean', 'unclean', 'open']),
  tables: Schema.Array(
    Schema.Struct({
      durability: Schema.Literals(TABLE_CLASSES_IN_MANIFEST),
      rows: Schema.NullOr(nonNegativeInt),
      table: Schema.String,
    })
  ),
  timeMachine: Schema.Literals(['included', 'check-failed', 'not-applicable']),
  timings: Schema.Struct({
    cloneMs: nonNegativeNumber,
    fsyncMs: nonNegativeNumber,
    holdMs: Schema.NullOr(nonNegativeNumber),
    verifyMs: nonNegativeNumber,
  }),
  unknownLedgerEntries: nonNegativeInt,
  verified: Schema.Boolean,
});

export type DatabaseSnapshotManifest = (typeof manifestSchema)['Type'];

const decodeManifest = makeThrowingDecoder(manifestSchema, { onExcessProperty: 'error' });

/**
 * Strictly decodes a parsed `manifest.json`. Throws a `TypeError` naming the
 * failing field. `verified` is checked against the evidence it summarises
 * (a clean integrity status and a row count for every table), because a
 * manifest that claims it without it would let retention protect a copy that
 * was never proven.
 */
export function parseDatabaseSnapshotManifest(json: unknown): DatabaseSnapshotManifest {
  const manifest = decodeManifest(json);
  const earned =
    manifest.integrity.status === 'clean' && manifest.tables.every(({ rows }) => rows !== null);
  if (manifest.verified !== earned) {
    throw new TypeError(
      `Snapshot manifest field "verified" is ${manifest.verified}, but its integrity status and row counts say ${earned}.`
    );
  }
  return manifest;
}
