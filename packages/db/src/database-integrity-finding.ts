/**
 * What a database integrity check reports about one relation (BST-1877).
 *
 * The finding is the shared vocabulary of the diagnosis that produces it and the
 * snapshot manifest that persists it, so both import this one schema. It is pure:
 * no database, no filesystem.
 */
import { Schema } from 'effect';
import { TABLE_DURABILITY_CLASSES } from './table-durability-registry.js';

export const INTEGRITY_CHECKS = [
  'open',
  'heap',
  'btree',
  'gin',
  'bm25-probe',
  'hnsw-probe',
  'row-count',
] as const;
export type IntegrityCheck = (typeof INTEGRITY_CHECKS)[number];

/** A finding's table class: the registry's, plus tables the registry does not own. */
const FINDING_DURABILITIES = [...TABLE_DURABILITY_CLASSES, 'catalog', 'unclassified'] as const;

export const MAX_FINDING_MESSAGE_LENGTH = 240;

/**
 * Identifiers only: relation and table names, an access method, a SQLSTATE and
 * the error's primary message. Never a detail, hint, where or row value
 * (`docs/diagnostics-privacy-contract.md`).
 */
export const relationFindingSchema = Schema.Struct({
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
export type RelationFinding = (typeof relationFindingSchema)['Type'];

export type FindingSeverity = 'repairable' | 'blocking';

/**
 * Whether a finding can be repaired while the database stays in service.
 * Only an index in a user schema, or a heap the registry says is rebuilt or
 * disposable (`derived`, `operational`), is `repairable`. Everything else is
 * `blocking`: anything in the system catalog (the engine itself depends on it,
 * so damage there fails closed), a precious, schema-ledger or unclassified heap
 * or row count, and a database that would not open. The default is `blocking`,
 * so a class added later cannot become repairable by omission.
 */
export function classifyFindingSeverity(
  finding: Pick<RelationFinding, 'check' | 'durability' | 'relationKind'>
): FindingSeverity {
  if (finding.check === 'open' || finding.durability === 'catalog') {
    return 'blocking';
  }
  if (finding.relationKind === 'index') {
    return 'repairable';
  }
  if (
    finding.relationKind === 'table' &&
    (finding.durability === 'derived' || finding.durability === 'operational')
  ) {
    return 'repairable';
  }
  return 'blocking';
}
