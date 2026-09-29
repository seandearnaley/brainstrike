/**
 * What a database integrity check reports about one relation (BST-1877).
 *
 * The finding is the shared vocabulary of the diagnosis that produces it and the
 * snapshot manifest that persists it, so both import this one schema. It is pure:
 * no database, no filesystem.
 */
import { Schema } from 'effect';
import { TABLE_DURABILITY_CLASSES } from './table-durability-registry.js';

/** Checks that read a table's heap. */
const TABLE_CHECKS = ['heap', 'row-count'] as const;
/** Checks that read one index. */
const INDEX_CHECKS = ['btree', 'gin', 'bm25-probe', 'hnsw-probe'] as const;
/** Every check, derived from the two families and `open`, so a check cannot exist without a family. */
export const INTEGRITY_CHECKS = ['open', ...TABLE_CHECKS, ...INDEX_CHECKS] as const;
export type IntegrityCheck = (typeof INTEGRITY_CHECKS)[number];

/** A finding's table class: the registry's, plus tables the registry does not own. */
const FINDING_DURABILITIES = [...TABLE_DURABILITY_CLASSES, 'catalog', 'unclassified'] as const;

/** The most UTF-16 units a finding's `message` may hold; the manifest schema refuses more. */
export const MAX_FINDING_MESSAGE_LENGTH = 240;

/**
 * Cuts `message` to {@link MAX_FINDING_MESSAGE_LENGTH}, the only way a writer
 * should shorten one: a manifest this build refuses to read is a snapshot it
 * cannot list. A cut never leaves half of a surrogate pair.
 */
export function truncateFindingMessage(message: string): string {
  if (message.length <= MAX_FINDING_MESSAGE_LENGTH) {
    return message;
  }
  const cut = message.slice(0, MAX_FINDING_MESSAGE_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd8_00 && last <= 0xdb_ff ? cut.slice(0, -1) : cut;
}

/**
 * Identifiers only: relation and table names, an access method, a SQLSTATE and
 * the error's primary message. Never a detail, hint, where or row value
 * (`docs/diagnostics-privacy-contract.md`).
 */
const relationFindingFields = Schema.Struct({
  accessMethod: Schema.NullOr(Schema.String),
  check: Schema.Literals(INTEGRITY_CHECKS),
  durability: Schema.Literals(FINDING_DURABILITIES),
  message: Schema.String.check(Schema.isMaxLength(MAX_FINDING_MESSAGE_LENGTH)),
  /** Null only for the `open` check, which names no relation. */
  relation: Schema.NullOr(Schema.String),
  relationKind: Schema.Literals(['table', 'index', 'database']),
  /** Null when the check reported a problem rather than throwing one. */
  sqlstate: Schema.NullOr(Schema.String),
  /** The owning table (a TOAST relation reports its owner). Null only for `open`. */
  table: Schema.NullOr(Schema.String),
});

export const relationFindingSchema = relationFindingFields.check(
  Schema.makeFilter(
    (finding) => finding.check === 'open' || (finding.relation !== null && finding.table !== null),
    { message: 'relation and table may be null only for the open check' }
  )
);
export type RelationFinding = (typeof relationFindingSchema)['Type'];

export type FindingSeverity = 'repairable' | 'blocking';

/**
 * Whether a finding can be repaired while the database stays in service.
 * Only an index in a user schema, or a heap the registry says is rebuilt or
 * disposable (`derived`, `operational`), is `repairable`. Everything else is
 * `blocking`: anything in the system catalog (the engine itself depends on it,
 * so damage there fails closed), a precious, schema-ledger or unclassified heap
 * or row count, a database that would not open, and a finding whose check does
 * not belong to its relation kind (a heap check on an index, an index check on a
 * table), which no known rebuild answers. The default is `blocking`, so a class
 * or check added later cannot become repairable by omission.
 */
export function classifyFindingSeverity(
  finding: Pick<RelationFinding, 'check' | 'durability' | 'relationKind'>
): FindingSeverity {
  if (finding.check === 'open' || finding.durability === 'catalog') {
    return 'blocking';
  }
  if (finding.relationKind === 'index') {
    return isCheckOf(INDEX_CHECKS, finding.check) ? 'repairable' : 'blocking';
  }
  if (
    finding.relationKind === 'table' &&
    isCheckOf(TABLE_CHECKS, finding.check) &&
    (finding.durability === 'derived' || finding.durability === 'operational')
  ) {
    return 'repairable';
  }
  return 'blocking';
}

function isCheckOf(family: readonly IntegrityCheck[], check: IntegrityCheck): boolean {
  return family.includes(check);
}
