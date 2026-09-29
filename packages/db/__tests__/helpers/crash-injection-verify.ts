/**
 * Post-crash verification for the SIGKILL crash gate. Every check enumerates what
 * it verifies from the catalog (`pg_index` / `pg_am` / `pg_class`), never a
 * hardcoded list, and every failure is a {@link CrashGateCheckError} naming the
 * check and the index or table. Nothing matches on an error message: BM25 damage
 * surfaces as arbitrary SQLSTATEs (`58P01`, `XX000`, `XX001`), so detection is
 * "the probe threw".
 */
import type { PGlite } from '@electric-sql/pglite';

export type CrashGateDb = Pick<PGlite, 'exec' | 'query'>;

export type CrashGateCheck =
  | 'access-method-coverage'
  | 'bm25-insert'
  | 'bm25-search'
  | 'btree'
  | 'gin'
  | 'heap'
  | 'hnsw'
  | 'index-coverage'
  | 'index-validity'
  | 'survival'
  | 'writer';

export class CrashGateCheckError extends Error {
  readonly check: CrashGateCheck;
  readonly subject: string;

  constructor(check: CrashGateCheck, subject: string, detail: string, cause?: unknown) {
    super(`check=${check} subject=${subject}: ${detail}`, cause === undefined ? {} : { cause });
    this.name = 'CrashGateCheckError';
    this.check = check;
    this.subject = subject;
  }
}

/** Access methods the writer exercises. A new one must be added to the writer and to a check here. */
const COVERED_ACCESS_METHODS: readonly string[] = ['bm25', 'btree', 'gin', 'hnsw'];
const NEAREST_NEIGHBOUR_OPERATORS: Readonly<Record<string, string>> = {
  halfvec_cosine_ops: '<=>',
  halfvec_ip_ops: '<#>',
  halfvec_l1_ops: '<+>',
  halfvec_l2_ops: '<->',
  vector_cosine_ops: '<=>',
  vector_ip_ops: '<#>',
  vector_l1_ops: '<+>',
  vector_l2_ops: '<->',
};
const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'`;
const BM25_PROBE_ROWS = 1000;

export interface IndexRow {
  /** Schema-qualified and quoted: safe to interpolate and to cast to regclass. */
  readonly index: string;
  readonly indexName: string;
  /** First key: a column name or a deparsed expression, from `pg_get_indexdef`, so both probe alike. */
  readonly key: string;
  readonly operatorClass: string;
  readonly predicate: string | null;
  /** Schema-qualified and quoted. */
  readonly table: string;
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** Runs `run`, turning any failure that is not already a gate failure into one. */
async function checked<T>(
  check: CrashGateCheck,
  subject: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CrashGateCheckError) {
      throw error;
    }
    const code = (error as { code?: unknown }).code;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CrashGateCheckError(check, subject, code ? `${code} ${detail}` : detail, error);
  }
}

const INDEXES_OF = `FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_am am ON am.oid = c.relam
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE am.amname = $1 AND ${USER_SCHEMA}`;

/**
 * Every index of `accessMethod` in a user schema. Nothing filters on validity or key shape (an
 * expression key has `indkey[0] = 0`), and the count is checked against `pg_index`, so a later
 * filter cannot silently drop an index from a probe.
 */
export async function listIndexes(db: CrashGateDb, accessMethod: string): Promise<IndexRow[]> {
  const listed = await db.query<IndexRow>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS "index", c.relname::text AS "indexName",
            pg_get_indexdef(i.indexrelid, 1, true) AS "key",
            (SELECT opcname::text FROM pg_opclass WHERE oid = i.indclass[0]) AS "operatorClass",
            pg_get_expr(i.indpred, i.indrelid) AS "predicate",
            format('%I.%I', n.nspname, t.relname) AS "table"
     ${INDEXES_OF} ORDER BY 1`,
    [accessMethod]
  );
  const total = await db.query<{ total: number }>(`SELECT count(*)::int AS total ${INDEXES_OF}`, [
    accessMethod,
  ]);
  if (listed.rows.length !== total.rows[0]?.total) {
    throw new CrashGateCheckError(
      'index-coverage',
      accessMethod,
      `listed ${listed.rows.length} of ${total.rows[0]?.total} ${accessMethod} indexes`
    );
  }
  return listed.rows;
}

/** After recovery every index is valid and ready; a half-built one is the damage this gate exists to see. */
export async function verifyIndexValidity(db: CrashGateDb): Promise<void> {
  const broken = await db.query<{ index: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS "index" FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE (NOT i.indisvalid OR NOT i.indisready) AND ${USER_SCHEMA} ORDER BY 1`
  );
  if (broken.rows.length > 0) {
    throw new CrashGateCheckError(
      'index-validity',
      broken.rows.map((row) => row.index).join(','),
      'not valid and ready after recovery'
    );
  }
}

/** Runs `sql` with sequential scans off and proves the plan used the index: a probe must not pass by reading the heap. */
async function runThroughIndex(
  db: CrashGateDb,
  check: CrashGateCheck,
  entry: IndexRow,
  sql: string
): Promise<unknown[]> {
  await db.exec('SET enable_seqscan = off');
  try {
    const plan = await db.query<Record<string, string>>(`EXPLAIN ${sql}`);
    if (!plan.rows.some((row) => Object.values(row).some((l) => l.includes(entry.indexName)))) {
      throw new CrashGateCheckError(
        check,
        entry.index,
        'the planner did not use this index, so the probe would prove nothing'
      );
    }
    return (await db.query(sql)).rows;
  } finally {
    await db.exec('RESET enable_seqscan');
  }
}

/** A new index access method in the schema fails the gate until it is deliberately covered. */
export async function verifyAccessMethodsCovered(db: CrashGateDb): Promise<void> {
  const result = await db.query<{ amname: string }>(
    `SELECT DISTINCT am.amname::text AS amname FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMA}`
  );
  const uncovered = result.rows
    .map((row) => row.amname)
    .filter((method) => !COVERED_ACCESS_METHODS.includes(method));
  if (uncovered.length > 0) {
    throw new CrashGateCheckError(
      'access-method-coverage',
      uncovered.join(','),
      'the schema uses an index access method the crash gate does not exercise; extend the writer, the checks and COVERED_ACCESS_METHODS'
    );
  }
}

export interface AckedRows {
  readonly chunkIds: readonly string[];
  readonly fileRecordId: string;
  readonly indexMessageIds: readonly string[];
  readonly messageIds: readonly string[];
}

/** Committed rows are still there, read with index scans off so a lossy index cannot hide a lost row. */
export async function verifyAckedRowsSurvived(db: CrashGateDb, acked: AckedRows): Promise<void> {
  const targets = [
    ['mastra_messages', 'id', acked.messageIds],
    ['file_chunks', 'id', acked.chunkIds],
    ['brainstrike_thread_message_index', 'message_id', acked.indexMessageIds],
    ['file_records', 'id', [acked.fileRecordId]],
  ] as const;
  await db.exec(
    'SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off'
  );
  try {
    for (const [table, column, ids] of targets) {
      const missing = await checked('survival', table, () =>
        db.query<{ id: string }>(
          `SELECT e.id FROM unnest($1::text[]) AS e(id)
           WHERE NOT EXISTS (SELECT 1 FROM ${quote(table)} r WHERE r.${quote(column)} = e.id)`,
          [[...ids]]
        )
      );
      if (missing.rows.length > 0) {
        throw new CrashGateCheckError(
          'survival',
          table,
          `${missing.rows.length} of ${ids.length} acknowledged rows are missing, e.g. ${missing.rows[0]?.id}`
        );
      }
    }
  } finally {
    await db.exec('RESET enable_indexscan; RESET enable_bitmapscan; RESET enable_indexonlyscan');
  }
}

/**
 * BM25 works after recovery. First an insert that must allocate index pages
 * (rolled back): allocation is where a stale free-space map hands out a block a
 * live structure owns. Then a ranked search, which is where that overwrite shows.
 */
export async function verifyBm25(db: CrashGateDb): Promise<void> {
  const indexes = await listIndexes(db, 'bm25');
  if (indexes.length === 0) {
    throw new CrashGateCheckError('bm25-search', '(none)', 'no BM25 index exists to probe');
  }
  for (const entry of indexes) {
    if (entry.table !== 'public.file_chunks') {
      throw new CrashGateCheckError(
        'bm25-insert',
        entry.index,
        `the insert probe only knows public.file_chunks, not ${entry.table}; extend verifyBm25`
      );
    }
    await db.exec('BEGIN');
    try {
      await checked('bm25-insert', entry.index, () =>
        db.query(
          `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash)
           SELECT 'probe-' || g, (SELECT id FROM file_records LIMIT 1), -g,
                  'crash probe ' || g || ' ' || repeat('recovery index search ', 8), 'probe'
           FROM generate_series(1, $1::int) AS g`,
          [BM25_PROBE_ROWS]
        )
      );
    } finally {
      await db.exec('ROLLBACK');
    }
    const indexName = entry.indexName.replaceAll("'", "''");
    const search = `SELECT ctid FROM ${entry.table} ORDER BY ${entry.key} <@> to_bm25query('database recovery index', '${indexName}') LIMIT 10`;
    await checked('bm25-search', entry.index, () =>
      runThroughIndex(db, 'bm25-search', entry, search)
    );
  }
}

/** Nearest-neighbour search through every HNSW index returns rows, via the index. */
export async function verifyHnsw(db: CrashGateDb): Promise<void> {
  const indexes = await listIndexes(db, 'hnsw');
  if (indexes.length === 0) {
    throw new CrashGateCheckError('hnsw', '(none)', 'no HNSW index exists to probe');
  }
  for (const entry of indexes) {
    const operator = NEAREST_NEIGHBOUR_OPERATORS[entry.operatorClass];
    if (!operator) {
      throw new CrashGateCheckError(
        'hnsw',
        entry.index,
        `unknown operator class ${entry.operatorClass}; extend NEAREST_NEIGHBOUR_OPERATORS`
      );
    }
    const where = entry.predicate ? `WHERE ${entry.predicate}` : '';
    const eligible = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${entry.table} ${where}`
    );
    const rowCount = eligible.rows[0]?.n ?? 0;
    if (rowCount === 0) {
      throw new CrashGateCheckError(
        'hnsw',
        entry.index,
        'no row matches the index predicate, so the probe would prove nothing'
      );
    }
    // The query vector is a stored one, so the probe needs no knowledge of the dimension.
    const sql = `SELECT ctid FROM ${entry.table} ${where} ORDER BY ${entry.key} ${operator} (SELECT ${entry.key} FROM ${entry.table} ${where} LIMIT 1) LIMIT 5`;
    const rows = await checked('hnsw', entry.index, () => runThroughIndex(db, 'hnsw', entry, sql));
    if (rows.length === 0) {
      throw new CrashGateCheckError(
        'hnsw',
        entry.index,
        `nearest-neighbour search returned no rows although ${rowCount} match the index predicate`
      );
    }
  }
}

/**
 * amcheck over every heap, btree (heapallindexed) and GIN index in a user
 * schema. The caller loads `@electric-sql/pglite/contrib/amcheck` on this
 * handle; the extension is dropped again so the data dir stays what production opens.
 */
export async function verifyStructure(db: CrashGateDb): Promise<void> {
  await db.exec('CREATE EXTENSION IF NOT EXISTS amcheck');
  try {
    const tables = await db.query<{ table: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS "table" FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'm') AND c.relpersistence <> 't' AND ${USER_SCHEMA} ORDER BY 1`
    );
    for (const { table } of tables.rows) {
      const damage = await checked('heap', table, () =>
        db.query<{ msg: string }>('SELECT msg FROM verify_heapam($1::regclass) LIMIT 1', [table])
      );
      if (damage.rows.length > 0) {
        throw new CrashGateCheckError('heap', table, `verify_heapam: ${damage.rows[0]?.msg}`);
      }
    }
    for (const { index } of await listIndexes(db, 'btree')) {
      await checked('btree', index, () =>
        db.query('SELECT bt_index_check($1::regclass, heapallindexed => true)', [index])
      );
    }
    for (const { index } of await listIndexes(db, 'gin')) {
      await checked('gin', index, () => db.query('SELECT gin_index_check($1::regclass)', [index]));
    }
  } finally {
    await db.exec('DROP EXTENSION IF EXISTS amcheck');
  }
}
