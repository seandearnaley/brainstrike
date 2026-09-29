/**
 * Relation-by-relation integrity diagnosis of a PGlite database (BST-1877).
 *
 * Built for the snapshot verifier: it runs on a COPY of the profile in a
 * short-lived process that loaded `amcheck` (`createVerificationPglite`), never
 * on the live database. It enumerates the catalog (never a hardcoded list) and
 * runs ONE statement per relation, so a failure names the relation that was
 * being checked:
 *
 * - heap tables and TOAST tables: `verify_heapam`
 * - btree indexes: `bt_index_check(index, heapallindexed => true)`
 * - gin indexes: `gin_index_check`
 * - bm25 (pg_textsearch) and hnsw (pgvector) indexes have no amcheck support, so
 *   each gets a probe that goes THROUGH the access method: a search, plus for
 *   bm25 a rolled-back non-HOT write. Which page a probe touches is a
 *   property of the query, so a probe proves the paths it walks, not the whole
 *   index; `unchecked` lists what no probe could walk.
 * - a per-table `count(*)` with index scans disabled, so the count reads the heap.
 *
 * An error is attributed to the relation being checked and its message is never
 * parsed: BM25 damage is reported against the heap, so the text is not evidence
 * of where the damage is. For the same reason a probe that walks other
 * relations (a write maintains every index; a search reads the heap) runs only
 * when its table has no finding yet, and is otherwise listed as unchecked
 * rather than blamed on the wrong relation. hnsw probes run before the bm25
 * write probe so read-side damage is named correctly; a failure only the write
 * path reaches is still attributed to the bm25 index, the one being probed.
 */
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import type { CrashSensitiveIndexDb } from './crash-sensitive-indexes.js';
import {
  classifyFindingSeverity,
  type IntegrityCheck,
  MAX_FINDING_MESSAGE_LENGTH,
  type RelationFinding,
} from './database-integrity-finding.js';
import type { TableDurabilityClass } from './table-durability-registry.js';

const DEFAULT_MAX_FINDINGS = 500;
/** Characters of an indexed value used as the bm25 probe's search text. */
const BM25_PROBE_TEXT_LENGTH = 200;

export interface UncheckedRelation {
  readonly accessMethod: string;
  readonly reason:
    | 'empty-table'
    | 'table-has-findings'
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
      kind: Schema.Literals(['r', 'm', 't', 'i']),
      oid: Schema.String,
      relation: Schema.String,
      schema: Schema.String,
      table: Schema.String,
      tableOid: Schema.String,
      tableSchema: Schema.String,
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
    })
  )
);
const heapProblemRows = makeThrowingDecoder(
  Schema.Array(
    Schema.Struct({
      blkno: Schema.String,
      msg: Schema.String,
      offnum: Schema.NullOr(Schema.Int),
    })
  )
);
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

const RELATIONS_SQL = `
  SELECT c.oid::text AS "oid", n.nspname::text AS "schema", c.relname::text AS "relation",
         c.relkind::text AS "kind", am.amname::text AS "accessMethod",
         owner.oid::text AS "tableOid", owner.relname::text AS "table",
         owner_ns.nspname::text AS "tableSchema"
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_am am ON am.oid = c.relam
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_class base ON base.oid = COALESCE(i.indrelid, c.oid)
  LEFT JOIN pg_class toast_owner ON toast_owner.reltoastrelid = base.oid AND base.relkind = 't'
  JOIN pg_class owner ON owner.oid = COALESCE(toast_owner.oid, base.oid)
  JOIN pg_namespace owner_ns ON owner_ns.oid = owner.relnamespace
  WHERE c.relkind IN ('r', 'm', 't', 'i')
    AND n.nspname IN ('public', 'pg_catalog', 'pg_toast')
  ORDER BY n.nspname, c.relname`;

const INDEX_DEFINITION_SQL = `
  SELECT pg_get_indexdef(i.indexrelid, 1, true) AS "expression",
         pg_get_expr(i.indpred, i.indrelid) AS "predicate",
         oc.opcname::text AS "opclass", a.attname::text AS "column",
         i.indnkeyatts::int AS "keyColumns"
  FROM pg_index i
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

type IndexDefinition = ReturnType<typeof indexDefinitionRows>[number];

/** Mutable state and steps of one diagnosis; only {@link diagnoseDatabaseIntegrity} constructs it. */
class DiagnosisRun {
  readonly findings: RelationFinding[] = [];
  readonly unchecked: UncheckedRelation[] = [];
  checkedRelations = 0;
  readonly #db: CrashSensitiveIndexDb;
  readonly #classify: IntegrityDiagnosisOptions['classify'];
  readonly #relations: readonly RelationRow[];
  readonly #tablesWithFindings = new Set<string>();

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
      await this.#attempt(relation, 'heap', async () => {
        const [problem] = heapProblemRows(
          (
            await this.#db.query(
              `SELECT blkno::text AS "blkno", offnum, msg FROM verify_heapam($1::oid::regclass, true)`,
              [relation.oid]
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
      switch (index.accessMethod) {
        case 'btree':
          await this.#attempt(index, 'btree', () =>
            this.#db.query('SELECT bt_index_check($1::oid::regclass, true)', [index.oid])
          );
          break;
        case 'gin':
          await this.#attempt(index, 'gin', () =>
            this.#db.query('SELECT gin_index_check($1::oid::regclass)', [index.oid])
          );
          break;
        case 'bm25':
        case 'hnsw':
          probed.push(index);
          break;
        default:
          this.#skip(index, 'unsupported-access-method');
      }
    }
    // The bm25 write probe maintains every index on its table, so it goes last.
    for (const accessMethod of ['hnsw', 'bm25']) {
      for (const index of probed.filter((candidate) => candidate.accessMethod === accessMethod)) {
        await this.#probe(index);
      }
    }
  }

  /** One `count(*)` per public table, with index scans off so the count reads the heap. */
  async countTables(): Promise<DiagnosedTable[]> {
    const tables: DiagnosedTable[] = [];
    await this.#db.exec(
      'SET enable_indexscan = off; SET enable_indexonlyscan = off; SET enable_bitmapscan = off'
    );
    try {
      for (const relation of this.#relations) {
        if (relation.schema !== 'public' || (relation.kind !== 'r' && relation.kind !== 'm')) {
          continue;
        }
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
          rows: rows ?? null,
          table: relation.relation,
        });
      }
    } finally {
      await this.#db.exec(
        'RESET enable_indexscan; RESET enable_indexonlyscan; RESET enable_bitmapscan'
      );
    }
    return tables;
  }

  async #probe(index: RelationRow): Promise<void> {
    // A probe walks the table's heap and, for a write, every index on it. Its error could
    // belong to any of them, so it runs only when the table's own checks found nothing.
    if (this.#tablesWithFindings.has(index.tableOid)) {
      this.#skip(index, 'table-has-findings');
      return;
    }
    const [definition] = indexDefinitionRows(
      (await this.#db.query(INDEX_DEFINITION_SQL, [index.oid])).rows
    );
    if (definition?.keyColumns !== 1) {
      this.#skip(index, 'unsupported-index-definition');
    } else if (index.accessMethod === 'bm25') {
      await this.#probeBm25(index, definition);
    } else {
      await this.#probeHnsw(index, definition);
    }
  }

  /** Searches with text taken from the table, then rewrites one row through the index; both roll back. */
  async #probeBm25(index: RelationRow, definition: IndexDefinition): Promise<void> {
    if (definition.column === null) {
      this.#skip(index, 'unsupported-index-definition');
      return;
    }
    const table = qualified(index.tableSchema, index.table);
    const column = quoteIdentifier(definition.column);
    const [sample] = sampleRows(
      (
        await this.#db.query(
          `SELECT left(${column}::text, ${BM25_PROBE_TEXT_LENGTH}) AS "sample" FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`
        )
      ).rows
    );
    if (!sample) {
      this.#skip(index, 'empty-table');
      return;
    }
    await this.#attempt(
      index,
      'bm25-probe',
      () =>
        this.#inRolledBackTransaction(async () => {
          await this.#db.query(
            `SELECT 1 FROM ${table} ORDER BY ${column} <@> to_bm25query($1, ${quoteLiteral(index.relation)}) LIMIT 1`,
            [sample.sample]
          );
          // A non-HOT update: the access method's insert path runs, then the write rolls back.
          await this.#db.query(
            `UPDATE ${table} SET ${column} = ${column} || ' ' WHERE ctid = (SELECT ctid FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1)`
          );
        }),
      sample.sample
    );
  }

  /** Orders the table by distance to one of its own vectors, forced through the index. */
  async #probeHnsw(index: RelationRow, definition: IndexDefinition): Promise<void> {
    const operator = HNSW_DISTANCE_OPERATORS[definition.opclass];
    if (!operator) {
      this.#skip(index, 'unsupported-index-definition');
      return;
    }
    const table = qualified(index.tableSchema, index.table);
    // The catalog's own rendering of the key and partial predicate: a partial index is only
    // chosen when the query's WHERE implies its predicate.
    const where = definition.predicate ? ` WHERE ${definition.predicate}` : '';
    const key = `(${definition.expression})`;
    const [populated] = flagRows(
      (await this.#db.query(`SELECT EXISTS (SELECT 1 FROM ${table}${where}) AS "present"`)).rows
    );
    if (!populated?.present) {
      this.#skip(index, 'empty-table');
      return;
    }
    await this.#attempt(index, 'hnsw-probe', () =>
      this.#inRolledBackTransaction(async () => {
        await this.#db.query(
          `SELECT 1 FROM ${table}${where} ORDER BY ${key} ${operator} (SELECT ${key} FROM ${table}${where} LIMIT 1) LIMIT 1`
        );
      })
    );
  }

  /** A rolled-back transaction with sequential scans ruled out, so a probe walks the index it names. */
  async #inRolledBackTransaction(run: () => Promise<void>): Promise<void> {
    await this.#db.exec('BEGIN');
    try {
      await this.#db.exec('SET LOCAL enable_seqscan = off');
      await run();
    } finally {
      await this.#db.exec('ROLLBACK');
    }
  }

  /**
   * Runs one relation's check. A thrown error becomes that relation's finding, with
   * `redact` (text the check bound as a parameter) scrubbed from its message; a trap aborts.
   */
  async #attempt<T>(
    relation: RelationRow,
    check: IntegrityCheck,
    run: () => Promise<T>,
    redact?: string
  ): Promise<T | undefined> {
    try {
      const result = await run();
      this.#countChecked(check);
      return result;
    } catch (error) {
      if (isFatalTrap(error)) {
        throw error;
      }
      const message = messageOf(error);
      this.#record(relation, check, {
        message: redact ? message.replaceAll(redact, '[probe text]') : message,
        sqlstate: sqlstateOf(error),
      });
      this.#countChecked(check);
      return undefined;
    }
  }

  /** A row count re-reads a table its heap check already counted. */
  #countChecked(check: IntegrityCheck): void {
    if (check !== 'row-count') {
      this.checkedRelations += 1;
    }
  }

  #record(
    relation: RelationRow,
    check: IntegrityCheck,
    problem: { message: string; sqlstate: string | null }
  ): void {
    this.#tablesWithFindings.add(relation.tableOid);
    this.findings.push({
      accessMethod: relation.accessMethod,
      check,
      durability: this.#durabilityOf(relation),
      message: problem.message.slice(0, MAX_FINDING_MESSAGE_LENGTH),
      relation: relation.relation,
      relationKind: relation.kind === 'i' ? 'index' : 'table',
      sqlstate: problem.sqlstate,
      table: relation.table,
    });
  }

  #skip(relation: RelationRow, reason: UncheckedRelation['reason']): void {
    this.unchecked.push({
      accessMethod: relation.accessMethod ?? 'unknown',
      reason,
      relation: relation.relation,
      table: relation.table,
    });
  }

  #durabilityOf(relation: RelationRow): RelationFinding['durability'] {
    if (relation.tableSchema === 'pg_catalog') {
      return 'catalog';
    }
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
    relationRows((await db.query(RELATIONS_SQL)).rows)
  );
  // Heaps first: every later probe is gated on its table having no finding yet.
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
      await db.query(
        `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'amcheck') AS "present"`
      )
    ).rows
  );
  if (!installed?.present) {
    throw new Error(
      'Integrity diagnosis needs the amcheck extension: create it (CREATE EXTENSION amcheck) on a createVerificationPglite instance first.'
    );
  }
}
