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

/**
 * Twin of `WINDOWS_RESERVED_DEVICE_NAME` in `apps/desktop/src/database-location.ts`, which
 * `packages/db` cannot import; `scripts/__tests__/windows-reserved-device-name-twin.test.mjs`
 * keeps the two alternations equal. Windows maps these names, with any extension, to
 * devices, so `nul.db` would swallow every write. Case-insensitive: Windows is.
 */
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/** The desktop profile resolver's `PROFILE_SEGMENT_MAX_LENGTH`; an id is about 40, far below it. */
const PATH_SEGMENT_MAX_LENGTH = 64;

/**
 * Ids and profile names become directory names, so they must be one safe path
 * segment on every platform: no separator, no leading dot, no trailing dot (Windows
 * drops it), no reserved device name, and a bounded length. Two names that differ
 * only in case collide on a case-insensitive filesystem; ids end in a random suffix,
 * so that is out of scope here.
 */
const pathSegment = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, {
    message: 'must be one path segment of letters, digits, dot, underscore or dash',
  }),
  Schema.isMaxLength(PATH_SEGMENT_MAX_LENGTH, {
    message: `must be at most ${PATH_SEGMENT_MAX_LENGTH} characters`,
  }),
  Schema.makeFilter((value: string) => !value.endsWith('.'), {
    message: 'must not end in a dot, which Windows drops',
  }),
  Schema.makeFilter((value: string) => !WINDOWS_RESERVED_DEVICE_NAME.test(value), {
    message: 'must not be a reserved Windows device name',
  }),
  // Case-insensitive: on APFS and NTFS `x.PARTIAL` is the same directory as `x.partial`.
  Schema.makeFilter((value: string) => !/\.partial$/iu.test(value), {
    message: 'must not end in .partial (any case), which marks a snapshot still being written',
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

/** One consistency rule: a manifest that breaks it names `fields` in its error. */
type Contradiction = readonly [broken: boolean, fields: string, why: string];

function contradictionsOf(manifest: DatabaseSnapshotManifest): readonly Contradiction[] {
  const { findings, findingsTruncated, status, unverifiableReason } = manifest.integrity;
  const contradictions: Contradiction[] = [
    [
      status === 'clean' && findings.length > 0,
      'integrity.status, integrity.findings',
      'a clean status holds no findings',
    ],
    [
      status === 'clean' && findingsTruncated,
      'integrity.status, integrity.findingsTruncated',
      'a clean status has nothing to truncate',
    ],
    [
      status === 'damaged' && findings.length === 0 && !findingsTruncated,
      'integrity.status, integrity.findings',
      'a damaged status names at least one finding',
    ],
    [
      status === 'unverifiable' && unverifiableReason === null,
      'integrity.status, integrity.unverifiableReason',
      'an unverifiable status gives its reason',
    ],
    [
      status !== 'unverifiable' && unverifiableReason !== null,
      'integrity.status, integrity.unverifiableReason',
      'only an unverifiable status carries a reason',
    ],
  ];
  for (const durability of TABLE_CLASSES_IN_MANIFEST) {
    const total = manifest.tables
      .filter((table) => table.durability === durability)
      .reduce((sum, table) => sum + (table.rows ?? 0), 0);
    contradictions.push([
      manifest.rowCountsByDurability[durability] !== total,
      `rowCountsByDurability.${durability}`,
      `the ${durability} tables sum to ${total}`,
    ]);
  }
  return contradictions;
}

/**
 * Strictly decodes a parsed `manifest.json`. Throws a `TypeError` naming the
 * failing field. Beyond the schema it rejects a manifest that contradicts
 * itself, so a reader never has to guess which half to believe:
 * - `clean` carries no findings, no truncation and no reason; `damaged` names a
 *   finding (or was truncated); `unverifiable` gives a reason, and no other
 *   status carries one;
 * - each `rowCountsByDurability` class equals the sum of `tables[].rows` of that
 *   class, where a table whose count is `null` (counting it failed) adds
 *   nothing, so the total is over the tables that WERE counted;
 * - `verified` is true exactly when the status is clean, unmarked, findings-free
 *   and untruncated, and every table has a row count. Retention pins the newest
 *   verified snapshot, so a manifest claiming it without that evidence would
 *   protect a copy that was never proven.
 */
export function parseDatabaseSnapshotManifest(json: unknown): DatabaseSnapshotManifest {
  const manifest = decodeManifest(json);
  for (const [broken, fields, why] of contradictionsOf(manifest)) {
    if (broken) {
      throw new TypeError(`Snapshot manifest fields ${fields} contradict each other: ${why}.`);
    }
  }
  const { findings, findingsTruncated, status, unverifiableReason } = manifest.integrity;
  // A check that examined nothing, or counted no table, is no evidence: it cannot be verified.
  const earned =
    status === 'clean' &&
    manifest.integrity.checkedRelations > 0 &&
    manifest.tables.length > 0 &&
    findings.length === 0 &&
    !findingsTruncated &&
    unverifiableReason === null &&
    manifest.tables.every(({ rows }) => rows !== null);
  if (manifest.verified !== earned) {
    throw new TypeError(
      `Snapshot manifest field "verified" is ${manifest.verified}, but its integrity status and row counts say ${earned}.`
    );
  }
  return manifest;
}
