/**
 * Relation-by-relation integrity diagnosis of a PGlite database (BST-1877).
 *
 * Built for the snapshot verifier: it runs on a COPY of the profile in a
 * short-lived process that loaded `amcheck` (`createVerificationPglite`), never
 * on the live database. It enumerates the catalog (never a hardcoded list) and
 * runs ONE statement per relation, so a failure names the relation that was
 * being checked:
 *
 * - heap tables, TOAST tables and sequences (a sequence is a one-row heap):
 *   `verify_heapam`, with `check_toast` for a table that owns a TOAST table, so
 *   a value that cannot be detoasted is a finding on the table, not a later crash
 * - btree indexes: `bt_index_check(index, heapallindexed => true)`
 * - gin indexes: `gin_index_check`
 * - bm25 (pg_textsearch) and hnsw (pgvector) indexes have no amcheck support, so
 *   each gets a probe that goes THROUGH the access method: a search for a value
 *   taken from the table, plus for bm25 a rolled-back non-HOT write. The search
 *   must return a row: the value came from the table, so an empty answer means
 *   the index does not hold rows the table does, which is a finding. Which page
 *   a probe touches is a property of the query, so a probe proves the paths it
 *   walks, not the whole index; `unchecked` lists what no probe could walk.
 * - a per-table `count(*)` with index scans disabled, so the count reads the heap.
 * - an index the catalog marks invalid or not ready (what an interrupted rebuild
 *   leaves) is its own `index-invalid` finding: amcheck refuses it, and a
 *   verification after a crash must surface it. An unpopulated materialized view
 *   is unchecked, not damaged.
 *
 * Probe findings keep only the SQLSTATE and a fixed description: the write path
 * and the tokenizer can echo row content into an error. The probe write runs as
 * a replica (`session_replication_role`), so user triggers do not fire in it.
 *
 * An error is attributed to the relation being checked and its message is never
 * parsed: BM25 damage is reported against the heap, so the text is not evidence
 * of where the damage is. For the same reason a check that reads ANOTHER
 * relation runs only when that relation is clean: a btree check with
 * `heapallindexed` reads the table's heap, so it is skipped once the heap has a
 * finding; a probe searches the heap and, for a write, maintains every index, so
 * it is skipped once its table has any finding. Skipped checks are listed as
 * unchecked, never blamed on the wrong relation. hnsw probes and the bm25 searches run
 * before any bm25 write so read-side damage is named correctly; a failure only the write
 * path reaches is still attributed to the bm25 index, the one being probed.
 *
 * A probe must prove it walked its index: it plans its own search (`EXPLAIN (FORMAT JSON)`, inside
 * the same transaction) and counts the index as checked only when the main plan tree has an
 * ordered index scan on exactly that index. `enable_seqscan = off` only makes a sequential scan
 * expensive; the planner can still read another index and sort, and then the search would return a
 * row while the named index was never touched. Such an index is `unchecked`
 * (`probe-not-index-driven`). The bm25 write also inserts into every other index of the table that
 * is ready for writes, so it runs in a SECOND pass, after every other index has a verdict (a
 * bm25 sibling counts by its read-side verdict, so two bm25 indexes never block each other), and
 * only when each of them has one. A write the table refuses (`23514`, `23502`, `22001`, `23505`)
 * is not damage; any other state, including the class 22 states corrupt bytes can raise, is a
 * finding. Both skips are `unchecked`.
 *
 * Stopping versus findings. A finding names a relation, so it is only ever made where the failing
 * statement is about that relation. A failure that cannot be attributed stops the run with an
 * {@link IntegrityDiagnosisStoppedError} instead, and the caller reports the snapshot as
 * unverifiable or `open`: reading the extension list, the relation list or an index definition
 * (stage `catalog`), and starting a probe transaction or changing a session setting (stage
 * `session`). A failing BEGIN is never a probe finding. A probe transaction that cannot be rolled
 * back stops it too (stage `cleanup`), with no raw cause: probe errors can echo row content.
 *
 * The diagnosis is sequential on purpose: one statement per relation on a single
 * connection, and a fatal WebAssembly trap must stop it at the relation that
 * caused it.
 */
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Predicate, Schema } from 'effect';
import type { CrashSensitiveIndexDb } from './crash-sensitive-indexes.js';
import {
  classifyFindingSeverity,
  type IntegrityCheck,
  type RelationFinding,
  truncateFindingMessage,
} from './database-integrity-finding.js';
import type { TableDurabilityClass } from './table-durability-registry.js';

const DEFAULT_MAX_FINDINGS = 500;
/** Characters of an indexed value used as the bm25 probe's search text. */
const BM25_PROBE_TEXT_LENGTH = 200;
const BM25_LOST_ENTRIES =
  'The search for text taken from the table matched no row, so the index does not hold rows the table does.';
const INDEX_INVALID =
  'The catalog marks this index invalid or not ready, so it is neither maintained nor used until it is rebuilt.';
const HNSW_LOST_ENTRIES =
  'The nearest-neighbour search for a vector taken from the table returned no row, so the index does not hold rows the table does.';

export interface UncheckedRelation {
  readonly accessMethod: string | null;
  readonly reason:
    | 'no-indexed-rows'
    | 'probe-not-index-driven'
    | 'probe-write-rejected'
    | 'table-has-findings'
    | 'table-has-unverified-indexes'
    | 'unpopulated-materialized-view'
    | 'unsupported-access-method'
    | 'unsupported-index-definition';
  readonly relation: string;
  readonly table: string;
}

export interface DiagnosedTable {
  readonly durability: TableDurabilityClass | 'unclassified';
  /** Null when counting the rows failed; the failure is a `row-count` finding. */
  readonly rows: number | null;
  readonly table: string;
}

export interface IntegrityDiagnosis {
  /** Relations that ran to a verdict, clean or not. Every enumerated relation is checked or `unchecked`. */
  readonly checkedRelations: number;
  readonly durationMs: number;
  /** Blocking findings first; cut to `maxFindings`. */
  readonly findings: readonly RelationFinding[];
  readonly findingsTruncated: boolean;
  /** Every `public` table with its class and row count. */
  readonly tables: readonly DiagnosedTable[];
  /** Relations no check could walk, and why. Not findings. */
  readonly unchecked: readonly UncheckedRelation[];
}

export interface IntegrityDiagnosisOptions {
  /** The registry's class for a public table, or undefined when it is unregistered. */
  readonly classify: (table: string) => TableDurabilityClass | undefined;
  readonly maxFindings?: number;
  /** Monotonic milliseconds. */
  readonly now?: () => number;
}

const relationRows = makeThrowingDecoder(
  Schema.Array(
    Schema.Struct({
      accessMethod: Schema.NullOr(Schema.String),
      hasToast: Schema.Boolean,
      heapOid: Schema.String,
      kind: Schema.Literals(['r', 'm', 't', 'i', 'S']),
      oid: Schema.String,
      populated: Schema.Boolean,
      ready: Schema.Boolean,
      relation: Schema.String,
      schema: Schema.String,
      table: Schema.String,
      tableOid: Schema.String,
      tablePopulated: Schema.Boolean,
      tableSchema: Schema.String,
      usable: Schema.Boolean,
    })
  )
);
type RelationRow = ReturnType<typeof relationRows>[number];

const indexDefinitionRows = makeThrowingDecoder(
  Schema.Array(
    Schema.Struct({
      column: Schema.NullOr(Schema.String),
      expression: Schema.String,
      keyColumns: Schema.Int,
      opclass: Schema.String,
      predicate: Schema.NullOr(Schema.String),
      textConfig: Schema.NullOr(Schema.String),
    })
  )
);
type IndexDefinition = ReturnType<typeof indexDefinitionRows>[number];

const heapProblemRows = makeThrowingDecoder(
  Schema.Array(
    Schema.Struct({
      blkno: Schema.String,
      msg: Schema.String,
      offnum: Schema.NullOr(Schema.Int),
    })
  )
);
const planRows = makeThrowingDecoder(
  Schema.Array(
    Schema.Struct({ 'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Unknown })) })
  )
);

const INDEX_SCAN_NODES: ReadonlySet<string> = new Set([
  'Bitmap Index Scan',
  'Index Only Scan',
  'Index Scan',
]);

/**
 * Whether a plan node (the `Plan` of `EXPLAIN (FORMAT JSON)`) walks `indexName`: an index scan on
 * exactly that index that has an `Order By`, in the MAIN tree. Anything under an InitPlan or a
 * SubPlan is skipped: a probe's sample subquery is not the search.
 */
export function planWalksIndex(node: unknown, indexName: string): boolean {
  if (!Predicate.isObject(node)) {
    return false;
  }
  const parent = node['Parent Relationship'];
  if (parent === 'InitPlan' || parent === 'SubPlan') {
    return false;
  }
  const type = node['Node Type'];
  if (
    typeof type === 'string' &&
    INDEX_SCAN_NODES.has(type) &&
    node['Index Name'] === indexName &&
    typeof node['Order By'] === 'string'
  ) {
    return true;
  }
  const children = node['Plans'];
  return Array.isArray(children) && children.some((child) => planWalksIndex(child, indexName));
}

const countRows = makeThrowingDecoder(Schema.Array(Schema.Struct({ rows: Schema.Int })));
const flagRows = makeThrowingDecoder(Schema.Array(Schema.Struct({ present: Schema.Boolean })));
const sampleRows = makeThrowingDecoder(Schema.Array(Schema.Struct({ sample: Schema.String })));

/** pgvector's HNSW operator classes and the distance operator each orders by. */
const HNSW_DISTANCE_OPERATORS: Readonly<Record<string, string>> = {
  halfvec_cosine_ops: '<=>',
  halfvec_ip_ops: '<#>',
  halfvec_l2_ops: '<->',
  vector_cosine_ops: '<=>',
  vector_ip_ops: '<#>',
  vector_l2_ops: '<->',
};

/**
 * A sequence has no `pg_index` row, so its owner comes from `pg_depend` (an
 * `a`uto dependency for OWNED BY, an `i`nternal one for identity columns); a
 * TOAST relation and an index report the table they belong to.
 */
const RELATIONS_SQL = `
  SELECT c.oid::text AS "oid", n.nspname::text AS "schema", c.relname::text AS "relation",
         c.relkind::text AS "kind", am.amname::text AS "accessMethod",
         (c.reltoastrelid <> 0) AS "hasToast", c.relispopulated AS "populated",
         COALESCE(i.indisvalid AND i.indisready, true) AS "usable",
         COALESCE(i.indisready, true) AS "ready", base.oid::text AS "heapOid",
         base.relispopulated AS "tablePopulated",
         owner.oid::text AS "tableOid", owner.relname::text AS "table",
         owner_ns.nspname::text AS "tableSchema"
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_am am ON am.oid = c.relam
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_depend seq_owner ON c.relkind = 'S'
    AND seq_owner.classid = 'pg_class'::regclass AND seq_owner.objid = c.oid
    AND seq_owner.refclassid = 'pg_class'::regclass AND seq_owner.deptype IN ('a', 'i')
  JOIN pg_class base ON base.oid = COALESCE(i.indrelid, seq_owner.refobjid, c.oid)
  LEFT JOIN pg_class toast_owner ON toast_owner.reltoastrelid = base.oid AND base.relkind = 't'
  JOIN pg_class owner ON owner.oid = COALESCE(toast_owner.oid, base.oid)
  JOIN pg_namespace owner_ns ON owner_ns.oid = owner.relnamespace
  WHERE c.relkind IN ('r', 'm', 't', 'i', 'S')
    AND n.nspname IN ('public', 'pg_catalog', 'pg_toast')
  ORDER BY n.nspname, c.relname`;

const INDEX_DEFINITION_SQL = `
  SELECT pg_get_indexdef(i.indexrelid, 1, true) AS "expression",
         pg_get_expr(i.indpred, i.indrelid) AS "predicate",
         oc.opcname::text AS "opclass", a.attname::text AS "column",
         i.indnkeyatts::int AS "keyColumns",
         (SELECT split_part(option, '=', 2) FROM unnest(c.reloptions) AS option
           WHERE option LIKE 'text_config=%') AS "textConfig"
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_opclass oc ON oc.oid = i.indclass[0]
  LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND i.indkey[0] <> 0 AND a.attnum = i.indkey[0]
  WHERE i.indexrelid = $1::oid`;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function qualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

function sqlstateOf(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A WebAssembly trap poisons the instance: every later statement fails with it, so it is not a per-relation finding. */
function isFatalTrap(error: unknown): boolean {
  return error instanceof Error && error.name === 'PGliteFatalTrapError';
}

/** The states that mean the table refused the probe's value (check, not null, length, unique), not damage. */
const REJECTED_WRITE_STATES: ReadonlySet<string> = new Set(['22001', '23502', '23505', '23514']);

/** Probe errors can echo row content (the write path, the tokenizer), so their findings keep only the SQLSTATE. */
const PROBE_CHECKS: ReadonlySet<IntegrityCheck> = new Set(['bm25-probe', 'hnsw-probe']);

/**
 * The diagnosis cannot go on, and no relation can be blamed: `catalog` (a catalog read failed),
 * `session` (a transaction or setting statement failed) or `cleanup` (a probe transaction would
 * not roll back, which leaves the connection in an unknown state). The caller reports the snapshot
 * as unverifiable. A `cleanup` error carries no `cause`: it would be the raw probe error, which can
 * echo row content; the other stages are catalog or session statements, which cannot.
 */
export class IntegrityDiagnosisStoppedError extends Error {
  readonly sqlstate: string | null;
  readonly stage: 'catalog' | 'cleanup' | 'session';

  constructor(stage: 'catalog' | 'cleanup' | 'session', what: string, cause?: unknown) {
    super(`${what}, so the diagnosis stopped.`, stage === 'cleanup' ? undefined : { cause });
    this.name = 'IntegrityDiagnosisStoppedError';
    this.sqlstate = sqlstateOf(cause);
    this.stage = stage;
  }
}

/** Runs a statement whose failure cannot be blamed on a relation: a trap passes through, anything else stops the run. */
async function orStop<T>(
  stage: 'catalog' | 'session',
  what: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isFatalTrap(error)) {
      throw error;
    }
    throw new IntegrityDiagnosisStoppedError(stage, what, error);
  }
}

/** What a check returns when it recorded an `unchecked` entry instead of reaching a verdict. */
const NOT_CHECKED = Symbol('not checked');
type Verdict<T> = T | typeof NOT_CHECKED;

/** A bm25 search that passed: its write is deferred to the second pass, which decides whether the index is checked. */
const READ_PASSED = Symbol('read passed');

/** Mutable state and steps of one diagnosis; only {@link diagnoseDatabaseIntegrity} constructs it. */
class DiagnosisRun {
  readonly findings: RelationFinding[] = [];
  readonly unchecked: UncheckedRelation[] = [];
  checkedRelations = 0;
  readonly #db: CrashSensitiveIndexDb;
  readonly #classify: IntegrityDiagnosisOptions['classify'];
  readonly #relations: readonly RelationRow[];
  readonly #tablesWithFindings = new Set<string>();
  /** Heaps (a table, a TOAST table) with a heap finding, by heap oid; a TOAST heap also names its owner. */
  readonly #damagedHeaps = new Set<string>();
  /**
   * Indexes that ran to a verdict; the bm25 write is only safe when every other written index did.
   * A finding IS a verdict (it also puts the table in #tablesWithFindings, which skips the write),
   * and a bm25 index counts by its read-side verdict.
   */
  readonly #verifiedIndexes = new Set<string>();
  /** bm25 indexes whose search passed, with the write that remains for the second pass. */
  readonly #deferredWrites: { index: RelationRow; write: () => Promise<Verdict<void>> }[] = [];

  constructor(
    db: CrashSensitiveIndexDb,
    classify: IntegrityDiagnosisOptions['classify'],
    relations: readonly RelationRow[]
  ) {
    this.#db = db;
    this.#classify = classify;
    this.#relations = relations;
  }

  async checkHeaps(): Promise<void> {
    for (const relation of this.#relations.filter(({ kind }) => kind !== 'i')) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential by design: one verify_heapam per relation on a single-connection PGlite (parallel calls only queue); a fatal trap must stop at its relation.
      await this.#attempt(relation, 'heap', async () => {
        const [problem] = heapProblemRows(
          (
            await this.#db.query(
              `SELECT blkno::text AS "blkno", offnum, msg FROM verify_heapam($1::oid::regclass, true, $2::boolean)`,
              [relation.oid, relation.hasToast]
            )
          ).rows
        );
        if (problem) {
          const offset = problem.offnum === null ? '' : `, offset ${problem.offnum}`;
          this.#record(relation, 'heap', {
            message: `block ${problem.blkno}${offset}: ${problem.msg}`,
            sqlstate: null,
          });
        }
      });
    }
  }

  async checkIndexes(): Promise<void> {
    const probed: RelationRow[] = [];
    for (const index of this.#relations.filter(({ kind }) => kind === 'i')) {
      if (!index.usable) {
        // Left behind by an interrupted build or rebuild, and exactly what a verification after a
        // crash must surface. amcheck refuses such an index, so it is reported, not checked.
        this.#record(index, 'index-invalid', { message: INDEX_INVALID, sqlstate: null });
        this.checkedRelations += 1;
        continue;
      }
      switch (index.accessMethod) {
        case 'btree':
          if (this.#damagedHeaps.has(index.heapOid)) {
            // heapallindexed reads the heap this index is on: a damaged heap would be blamed on every index.
            this.#skip(index, 'table-has-findings');
          } else {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential by design: one amcheck statement per index on the single connection, attributed to that index; a fatal trap must stop here.
            await this.#attempt(index, 'btree', () =>
              this.#db.query('SELECT bt_index_check($1::oid::regclass, true)', [index.oid])
            );
            this.#verifiedIndexes.add(index.oid);
          }
          break;
        case 'gin':
          await this.#attempt(index, 'gin', () =>
            this.#db.query('SELECT gin_index_check($1::oid::regclass)', [index.oid])
          );
          this.#verifiedIndexes.add(index.oid);
          break;
        case 'bm25':
        case 'hnsw':
          probed.push(index);
          break;
        default:
          this.#skip(index, 'unsupported-access-method');
      }
    }
    // The bm25 write maintains every index on its table, so the writes go last, after every index has a verdict.
    for (const accessMethod of ['hnsw', 'bm25']) {
      for (const index of probed.filter((candidate) => candidate.accessMethod === accessMethod)) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential by design: each probe is a rolled-back transaction on the single connection and must not interleave; hnsw probes run before bm25.
        await this.#probe(index);
      }
    }
    for (const { index, write } of this.#deferredWrites) {
      if (this.#tablesWithFindings.has(index.tableOid)) {
        this.#skip(index, 'table-has-findings');
      } else if (this.#unverifiedWrittenIndexes(index).length > 0) {
        this.#skip(index, 'table-has-unverified-indexes');
      } else {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential by design: each write probe is a rolled-back transaction on the single connection and must not interleave.
        await this.#attempt(index, 'bm25-probe', write);
      }
    }
  }

  /** One `count(*)` per public table, with index scans off so the count reads the heap. */
  async countTables(): Promise<DiagnosedTable[]> {
    await orStop('session', 'Changing the count settings failed', () =>
      this.#db.exec(
        'SET enable_indexscan = off; SET enable_indexonlyscan = off; SET enable_bitmapscan = off'
      )
    );
    let tables: DiagnosedTable[];
    try {
      tables = await this.#countEach();
    } catch (error) {
      // A poisoned instance cannot run RESET, and a cleanup failure must not replace the error that
      // explains why the diagnosis is stopping.
      if (!isFatalTrap(error)) {
        await this.#resetCountSettings().catch(() => undefined);
      }
      throw error;
    }
    await this.#resetCountSettings();
    return tables;
  }

  /** RESET restores the server defaults, which are the values the diagnosis started from. */
  #resetCountSettings(): Promise<unknown> {
    return this.#db.exec(
      'RESET enable_indexscan; RESET enable_indexonlyscan; RESET enable_bitmapscan'
    );
  }

  async #countEach(): Promise<DiagnosedTable[]> {
    const tables: DiagnosedTable[] = [];
    for (const relation of this.#relations) {
      if (relation.schema !== 'public' || (relation.kind !== 'r' && relation.kind !== 'm')) {
        continue;
      }
      if (!relation.populated) {
        // count(*) on a view that was never populated is an error, not a damaged relation.
        this.#skip(relation, 'unpopulated-materialized-view');
        tables.push({
          durability: this.#classify(relation.relation) ?? 'unclassified',
          rows: null,
          table: relation.relation,
        });
        continue;
      }
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential by design: one count(*) per table under session-scoped SETs on the single connection, so attribution and the GUC scope stay exact.
      const rows = await this.#attempt(relation, 'row-count', async () => {
        const [counted] = countRows(
          (
            await this.#db.query(
              `SELECT count(*)::int AS "rows" FROM ${qualified(relation.schema, relation.relation)}`
            )
          ).rows
        );
        if (!counted) {
          throw new Error('count(*) returned no row');
        }
        return counted.rows;
      });
      tables.push({
        durability: this.#classify(relation.relation) ?? 'unclassified',
        rows: typeof rows === 'number' ? rows : null,
        table: relation.relation,
      });
    }
    return tables;
  }

  async #probe(index: RelationRow): Promise<void> {
    if (!index.tablePopulated) {
      // Every read of an unpopulated materialized view fails; that is not damage to its index.
      this.#skip(index, 'unpopulated-materialized-view');
      return;
    }
    // A probe walks the table's heap and, for a write, every index on it. Its error could
    // belong to any of them, so it runs only when the table's own checks found nothing.
    if (this.#tablesWithFindings.has(index.tableOid)) {
      this.#skip(index, 'table-has-findings');
      return;
    }
    // The definition is a catalog read: its own step, outside the attempt, so a failure stops the
    // run instead of becoming a finding on this user index.
    const [definition] = indexDefinitionRows(
      (
        await orStop('catalog', 'Reading an index definition failed', () =>
          this.#db.query(INDEX_DEFINITION_SQL, [index.oid])
        )
      ).rows
    );
    if (definition?.keyColumns !== 1) {
      this.#skip(index, 'unsupported-index-definition');
      return;
    }
    // Every read of the user's table the probe needs is inside the attempt: a value that cannot
    // be read (a TOAST pointer that passed amcheck, say) is a finding on this index.
    const result = await this.#attempt(
      index,
      index.accessMethod === 'bm25' ? 'bm25-probe' : 'hnsw-probe',
      () =>
        index.accessMethod === 'bm25'
          ? this.#probeBm25(index, definition)
          : this.#probeHnsw(index, definition)
    );
    if (result !== NOT_CHECKED) {
      this.#verifiedIndexes.add(index.oid);
    }
  }

  /** Whether `search`, planned inside the open probe transaction, walks `index` itself. */
  async #walksIndex(index: RelationRow, search: string, params?: unknown[]): Promise<boolean> {
    try {
      const [row] = planRows(
        (await this.#db.query(`EXPLAIN (FORMAT JSON) ${search}`, params)).rows
      );
      return planWalksIndex(row?.['QUERY PLAN'][0]?.Plan, index.relation);
    } catch (error) {
      // pg_textsearch refuses a plan that reads another index than the query names (42809), which
      // is what an identical second bm25 index causes: the named index was not walked.
      if (sqlstateOf(error) === '42809') {
        return false;
      }
      throw error;
    }
  }

  /** Every other index on the table that a write reaches and no check verified. */
  #unverifiedWrittenIndexes(index: RelationRow): readonly RelationRow[] {
    return this.#relations.filter(
      (other) =>
        other.kind === 'i' &&
        other.ready &&
        other.tableOid === index.tableOid &&
        other.oid !== index.oid &&
        !this.#verifiedIndexes.has(other.oid)
    );
  }

  /**
   * Searches with text taken from the table (both roll back). The write that rewrites one row
   * through the index is deferred: it needs every other index verified first.
   */
  async #probeBm25(
    index: RelationRow,
    definition: IndexDefinition
  ): Promise<Verdict<typeof READ_PASSED | undefined>> {
    // An expression key has no column to sample, and bm25 requires a text_config; without both the
    // probe cannot be built.
    // Nor can pg_textsearch resolve a name, the index's or its schema's, that contains a dot, in any
    // form (pinned by a test).
    if (
      definition.column === null ||
      definition.textConfig === null ||
      index.relation.includes('.') ||
      index.schema.includes('.')
    ) {
      return this.#notChecked(index, 'unsupported-index-definition');
    }
    const table = qualified(index.tableSchema, index.table);
    const column = quoteIdentifier(definition.column);
    // A value whose text has at least one term the index's own configuration keeps, so the
    // search below has something to match. A sample of stop words alone would legitimately match nothing.
    const config = `${quoteLiteral(definition.textConfig)}::regconfig, `;
    const text = `left(${column}::text, ${BM25_PROBE_TEXT_LENGTH})`;
    // A partial index holds only the rows its predicate accepts: the sample, the search and the
    // write all stay inside them, and the search's WHERE lets the planner choose the index.
    const inIndex = definition.predicate ? ` AND (${definition.predicate})` : '';
    const [sample] = sampleRows(
      (
        await this.#db.query(
          `SELECT ${text} AS "sample" FROM ${table}
            WHERE ${column} IS NOT NULL${inIndex} AND to_tsvector(${config}${text}) <> ''::tsvector LIMIT 1`
        )
      ).rows
    );
    if (!sample) {
      return this.#notChecked(index, 'no-indexed-rows');
    }
    // qualified: the argument is SQL name syntax when it has a dot, and an exact name otherwise
    // (pinned by a test), so this form does not depend on the search_path or the letter case.
    const search = `SELECT 1 FROM ${table}${definition.predicate ? ` WHERE (${definition.predicate})` : ''} ORDER BY ${column} <@> to_bm25query($1, ${quoteLiteral(qualified(index.schema, index.relation))}) LIMIT 1`;
    return this.#inRolledBackTransaction(
      async (): Promise<Verdict<typeof READ_PASSED | undefined>> => {
        if (!(await this.#walksIndex(index, search, [sample.sample]))) {
          return this.#notChecked(index, 'probe-not-index-driven');
        }
        const found = await this.#db.query(search, [sample.sample]);
        if (found.rows.length === 0) {
          this.#record(index, 'bm25-probe', { message: BM25_LOST_ENTRIES, sqlstate: null });
          return undefined;
        }
        this.#deferredWrites.push({
          index,
          write: () =>
            this.#inRolledBackTransaction(async (): Promise<Verdict<void>> => {
              try {
                // A non-HOT update: the access method's insert path runs, then the write rolls back.
                await this.#db.query(
                  `UPDATE ${table} SET ${column} = ${column} || ' ' WHERE ctid = (SELECT ctid FROM ${table} WHERE ${column} IS NOT NULL${inIndex} LIMIT 1)`
                );
              } catch (error) {
                // The table refused the value (a CHECK, a NOT NULL, a length, a unique key): its rule, not damage.
                if (REJECTED_WRITE_STATES.has(sqlstateOf(error) ?? '')) {
                  return this.#notChecked(index, 'probe-write-rejected');
                }
                throw error;
              }
              return undefined;
            }),
        });
        return READ_PASSED;
      }
    );
  }

  /** Orders the table by distance to one of its own vectors, forced through the index. */
  async #probeHnsw(index: RelationRow, definition: IndexDefinition): Promise<Verdict<undefined>> {
    const operator = HNSW_DISTANCE_OPERATORS[definition.opclass];
    if (!operator) {
      return this.#notChecked(index, 'unsupported-index-definition');
    }
    const table = qualified(index.tableSchema, index.table);
    // The catalog's own rendering of the key and partial predicate: a partial index is only
    // chosen when the query's WHERE implies its predicate. A NULL key is never indexed.
    const key = `(${definition.expression})`;
    const indexed = ` WHERE ${[definition.predicate, `${key} IS NOT NULL`].filter(Boolean).join(' AND ')}`;
    // The sample must be a vector the index holds: cosine distance to itself is NaN for a zero
    // vector, which pgvector does not index.
    const covered = `${indexed} AND (${key} ${operator} ${key}) < 1`;
    const [populated] = flagRows(
      (await this.#db.query(`SELECT EXISTS (SELECT 1 FROM ${table}${covered}) AS "present"`)).rows
    );
    if (!populated?.present) {
      return this.#notChecked(index, 'no-indexed-rows');
    }
    const search = `SELECT 1 FROM ${table}${indexed} ORDER BY ${key} ${operator} (SELECT ${key} FROM ${table}${covered} LIMIT 1) LIMIT 1`;
    return this.#inRolledBackTransaction(async (): Promise<Verdict<undefined>> => {
      if (!(await this.#walksIndex(index, search))) {
        return this.#notChecked(index, 'probe-not-index-driven');
      }
      const found = await this.#db.query(search);
      if (found.rows.length === 0) {
        this.#record(index, 'hnsw-probe', { message: HNSW_LOST_ENTRIES, sqlstate: null });
      }
      return undefined;
    });
  }

  /**
   * A rolled-back transaction with sequential scans ruled out, so a probe walks the index it
   * names. A trap skips the rollback (the instance is dead) and is rethrown; any other failure
   * is rethrown after a rollback that must itself succeed.
   */
  async #inRolledBackTransaction<T>(run: () => Promise<T>): Promise<T> {
    await orStop('session', 'Starting a probe transaction failed', () => this.#db.exec('BEGIN'));
    let outcome: { error: unknown } | { value: T };
    try {
      // replica: the probe write does not fire user triggers or foreign-key checks, which would
      // run application code against a copy; a trigger marked ENABLE ALWAYS still fires.
      await orStop('session', 'Changing the probe transaction settings failed', () =>
        this.#db.exec(
          'SET LOCAL enable_seqscan = off; SET LOCAL session_replication_role = replica'
        )
      );
      outcome = { value: await run() };
    } catch (error) {
      outcome = { error };
    }
    if ('error' in outcome && isFatalTrap(outcome.error)) {
      throw outcome.error;
    }
    try {
      await this.#db.exec('ROLLBACK');
    } catch (error) {
      throw isFatalTrap(error)
        ? error
        : new IntegrityDiagnosisStoppedError(
            'cleanup',
            'A probe transaction could not be rolled back'
          );
    }
    if ('error' in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  }

  /**
   * Runs one relation's check. A thrown error becomes that relation's finding; a trap or a failed
   * cleanup aborts. A check that recorded an `unchecked` entry (it returned {@link NOT_CHECKED})
   * is not counted as checked.
   */
  async #attempt<T>(
    relation: RelationRow,
    check: IntegrityCheck,
    run: () => Promise<Verdict<T>>
  ): Promise<Verdict<T> | undefined> {
    try {
      const result = await run();
      this.#countChecked(check, result);
      return result;
    } catch (error) {
      if (isFatalTrap(error) || error instanceof IntegrityDiagnosisStoppedError) {
        throw error;
      }
      this.#record(relation, check, {
        message: PROBE_CHECKS.has(check)
          ? `The ${check === 'bm25-probe' ? 'bm25' : 'hnsw'} probe raised an error against this index.`
          : messageOf(error),
        sqlstate: sqlstateOf(error),
      });
      this.#countChecked(check, undefined);
      return undefined;
    }
  }

  /** A row count re-reads a table its heap check already counted. */
  #countChecked(check: IntegrityCheck, result: unknown): void {
    if (check !== 'row-count' && result !== NOT_CHECKED && result !== READ_PASSED) {
      this.checkedRelations += 1;
    }
  }

  #record(
    relation: RelationRow,
    check: IntegrityCheck,
    problem: { message: string; sqlstate: string | null }
  ): void {
    if (check !== 'index-invalid') {
      // A catalog marking is not a failed read, so it never gates another check on the table.
      this.#tablesWithFindings.add(relation.tableOid);
    }
    if (check === 'heap' && relation.kind !== 'S') {
      // heapallindexed reads a table or a TOAST table, never a sequence. It also detoasts, so a TOAST
      // heap gates its owner's indexes too (tableOid is the owner; for a plain table it is the oid).
      this.#damagedHeaps.add(relation.oid);
      this.#damagedHeaps.add(relation.tableOid);
    }
    this.findings.push({
      accessMethod: relation.accessMethod,
      check,
      durability: this.#durabilityOf(relation),
      message: truncateFindingMessage(problem.message),
      relation: relation.relation,
      relationKind: relation.kind === 'i' ? 'index' : 'table',
      sqlstate: problem.sqlstate,
      table: relation.table,
    });
  }

  #skip(relation: RelationRow, reason: UncheckedRelation['reason']): void {
    this.unchecked.push({
      accessMethod: relation.accessMethod,
      reason,
      relation: relation.relation,
      table: relation.table,
    });
  }

  #notChecked(relation: RelationRow, reason: UncheckedRelation['reason']): typeof NOT_CHECKED {
    this.#skip(relation, reason);
    return NOT_CHECKED;
  }

  #durabilityOf(relation: RelationRow): RelationFinding['durability'] {
    if (relation.tableSchema === 'pg_catalog') {
      return 'catalog';
    }
    // Only public tables are in the registry: a table of the same name in another schema is not
    // that table. RELATIONS_SQL lists TOAST relations from pg_toast whatever schema owns their table.
    return relation.tableSchema === 'public'
      ? (this.#classify(relation.table) ?? 'unclassified')
      : 'unclassified';
  }
}

export async function diagnoseDatabaseIntegrity(
  db: CrashSensitiveIndexDb,
  options: IntegrityDiagnosisOptions
): Promise<IntegrityDiagnosis> {
  const now = options.now ?? (() => performance.now());
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    throw new RangeError('maxFindings must be a positive integer.');
  }
  const started = now();
  await assertAmcheckInstalled(db);

  const run = new DiagnosisRun(
    db,
    options.classify,
    relationRows(
      (await orStop('catalog', 'Listing the relations failed', () => db.query(RELATIONS_SQL))).rows
    )
  );
  // Heaps first: every later check is gated on its table having no finding yet.
  await run.checkHeaps();
  await run.checkIndexes();
  const tables = await run.countTables();

  // A cut list keeps blocking findings ahead of repairable ones, never the reverse.
  const ordered = [
    ...run.findings.filter((finding) => classifyFindingSeverity(finding) === 'blocking'),
    ...run.findings.filter((finding) => classifyFindingSeverity(finding) === 'repairable'),
  ];
  return {
    checkedRelations: run.checkedRelations,
    durationMs: now() - started,
    findings: ordered.slice(0, maxFindings),
    findingsTruncated: ordered.length > maxFindings,
    tables,
    unchecked: run.unchecked,
  };
}

async function assertAmcheckInstalled(db: CrashSensitiveIndexDb): Promise<void> {
  const [installed] = flagRows(
    (
      await orStop('catalog', 'Reading the installed extensions failed', () =>
        db.query(
          `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'amcheck') AS "present"`
        )
      )
    ).rows
  );
  if (!installed?.present) {
    throw new Error(
      'Integrity diagnosis needs the amcheck extension: create it (CREATE EXTENSION amcheck) on a createVerificationPglite instance first.'
    );
  }
}
