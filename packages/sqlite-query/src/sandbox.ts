import { constants, DatabaseSync } from 'node:sqlite';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { decodeIndexIdentityRow, type IndexerIdentity } from '@brainstrike/indexer/metadata';
import { sqliteVecExtensionPath } from '@brainstrike/sqlite-native';
import { createGrepLineMatcher } from '@brainstrike/utils/grep-line-matcher';
import { Schema } from 'effect';
import { CALLER_BINDING_NAMES, requireCallerVectors } from './caller-vectors.js';
import type {
  SqliteGrepOptions,
  SqliteGrepRows,
  SqliteQueryRequirement,
  SqliteRows,
  SqliteValue,
} from './protocol.js';
import { REVIEWED_FUNCTIONS } from './reviewed-functions.js';
import { SqliteRuntimeRefusedError } from './runtime-refusal.js';

const HEAP_LIMIT = 512 * 1024 * 1024;
const LENGTH_LIMIT = 16 * 1024 * 1024;
// Bound the payload before parent IPC deserialization, independently of row count.
const RESULT_LIMIT = 1024 * 1024;
const PRAGMAS = new Set([
  'data_version',
  'foreign_key_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'table_info',
  'table_list',
  'table_xinfo',
]);
const decodeLimits = makeThrowingDecoder(Schema.Struct({ attach: Schema.Int, length: Schema.Int }));
const decodeHeap = makeThrowingDecoder(Schema.Struct({ ['hard_heap_limit']: Schema.Int }));

export class SqliteSandbox {
  readonly #database: DatabaseSync;
  #ownedTransaction: 'BEGIN' | 'ROLLBACK' | undefined;

  constructor(databasePath: string) {
    // The pinned Node 24 type definitions predate the runtime's limits backport.
    // Pass canonical constructor options, then verify the actual engine values.
    const options = {
      allowExtension: true,
      limits: { attach: 0, length: LENGTH_LIMIT },
      readOnly: true,
    };
    const database = new DatabaseSync(databasePath, options);
    this.#database = database;
    try {
      if (!('limits' in database)) {
        throw new SqliteRuntimeRefusedError(
          'This SQLite runtime lacks required engine resource limits.'
        );
      }
      const limits = decodeLimits(database.limits);
      if (limits.attach !== 0 || limits.length !== LENGTH_LIMIT) {
        throw new SqliteRuntimeRefusedError(
          'SQLite did not apply the required attach and length limits.'
        );
      }
      if (
        database
          .prepare(
            "SELECT 1 FROM pragma_compile_options WHERE compile_options='DEFAULT_MEMSTATUS=0'"
          )
          .get()
      ) {
        throw new SqliteRuntimeRefusedError(
          'This SQLite build disables memory accounting (DEFAULT_MEMSTATUS=0); refusing an unenforced heap limit.'
        );
      }
      database.loadExtension(sqliteVecExtensionPath());
      database.enableLoadExtension(false);
      const heap = decodeHeap(database.prepare(`PRAGMA hard_heap_limit=${HEAP_LIMIT}`).get());
      if (heap.hard_heap_limit <= 0 || heap.hard_heap_limit > HEAP_LIMIT) {
        throw new SqliteRuntimeRefusedError('SQLite did not apply the required hard heap limit.');
      }
      database.setAuthorizer((action, argument, functionName) => {
        switch (action) {
          case constants.SQLITE_TRANSACTION:
            return this.#ownedTransaction !== undefined && argument === this.#ownedTransaction
              ? constants.SQLITE_OK
              : constants.SQLITE_DENY;
          case constants.SQLITE_SELECT:
          case constants.SQLITE_READ:
          case constants.SQLITE_RECURSIVE:
            return constants.SQLITE_OK;
          case constants.SQLITE_FUNCTION:
            return functionName !== null && REVIEWED_FUNCTIONS.has(functionName.toLowerCase())
              ? constants.SQLITE_OK
              : constants.SQLITE_DENY;
          case constants.SQLITE_PRAGMA:
            return argument !== null && PRAGMAS.has(argument.toLowerCase())
              ? constants.SQLITE_OK
              : constants.SQLITE_DENY;
          default:
            return constants.SQLITE_DENY;
        }
      });
    } catch (error) {
      database.close();
      throw error;
    }
  }

  query(
    sql: string,
    values: readonly SqliteValue[] = [],
    maxRows = 50,
    bindings?: Readonly<Record<string, SqliteValue>>,
    requirement?: SqliteQueryRequirement
  ): SqliteRows {
    if (requirement === undefined) {
      return this.#queryStatement(sql, values, maxRows, bindings);
    }
    this.#transaction('BEGIN');
    let result: SqliteRows;
    try {
      if (CALLER_BINDING_NAMES.some((name) => bindings && name in bindings)) {
        throw new TypeError('Caller context bindings are supplied only by the trusted reader.');
      }
      const callerBindings = requireCallerVectors(this.#database, requirement);
      result = this.#queryStatement(sql, values, maxRows, { ...bindings, ...callerBindings });
    } catch (operation) {
      try {
        this.#transaction('ROLLBACK');
      } catch (cleanup) {
        throw new AggregateError(
          [operation, cleanup],
          'Caller lens and read-snapshot cleanup failed.',
          { cause: operation }
        );
      }
      throw operation;
    }
    this.#transaction('ROLLBACK');
    return result;
  }

  #transaction(command: 'BEGIN' | 'ROLLBACK'): void {
    this.#ownedTransaction = command;
    try {
      this.#database.exec(command);
    } finally {
      this.#ownedTransaction = undefined;
    }
  }

  #queryStatement(
    sql: string,
    values: readonly SqliteValue[],
    maxRows: number,
    bindings?: Readonly<Record<string, SqliteValue>>
  ): SqliteRows {
    if (!(Number.isInteger(maxRows) && maxRows >= 1 && maxRows <= 200)) {
      throw new RangeError('maxRows must be an integer between 1 and 200.');
    }
    const text = sql.trim();
    if (!text) {
      throw new TypeError('SQL statement must not be empty.');
    }
    const statement = this.#database.prepare(text);
    if (text.slice(statement.sourceSQL.length).trim()) {
      throw new TypeError('Only one SQL statement is allowed.');
    }
    statement.setReturnArrays(true);
    const columns = statement.columns().map((column) => column.name);
    let resultBytes = columns.reduce((total, column) => total + Buffer.byteLength(column) + 16, 0);
    const rows: (readonly SqliteValue[])[] = [];
    let truncated = false;
    const outputRows =
      bindings === undefined
        ? statement.iterate(...values)
        : statement.iterate(bindings, ...values);
    for (const output of outputRows) {
      if (rows.length === maxRows) {
        truncated = true;
        break;
      }
      // @types/node currently describes object rows despite setReturnArrays.
      const row = decodeRow(output);
      for (const cell of row) {
        resultBytes +=
          16 +
          (typeof cell === 'string'
            ? Buffer.byteLength(cell)
            : cell instanceof Uint8Array
              ? cell.byteLength
              : 32);
      }
      if (resultBytes > RESULT_LIMIT) {
        throw new RangeError(
          'Query result exceeds the 1 MiB process-message budget. Select fewer columns, a smaller LIMIT, or an aggregate.'
        );
      }
      rows.push(row);
    }
    return { columns, rows, truncated };
  }

  /** Exhaustive authorized-scope scan in this killable reader, never the writer. */
  grep(options: SqliteGrepOptions): SqliteGrepRows {
    validateGrepOptions(options);
    const matcher = createGrepLineMatcher(options.pattern, options.isRegex, options.caseSensitive);
    const selectedIds = options.fileIds ?? options.rootIds;
    const scopePredicate =
      options.fileIds === undefined
        ? 'ch.root_id IN (SELECT value FROM json_each(?))'
        : 'fr.id IN (SELECT value FROM json_each(?))';
    const projection = [
      'ch.id',
      'ch.root_id',
      'ch.file_record_id',
      'fr.path',
      'ch.content',
      'ch.content_hash',
      'ch.start_line',
      'ch.end_line',
      'ch.chunk_index',
      'ch.chunk_size',
      'ch.chunk_type',
      'ch.start_offset',
      'ch.end_offset',
      'ch.token_count',
      ...(options.fileIds === undefined ? [] : ['fr.embedding_set_id', 'fr.source_path']),
    ];
    const literalFilter = grepLiteralFilter(options);
    // Keep every row that the existing decoder would reject, including nonmatching rows.
    const invalidValue = projection
      .map(
        (column) =>
          `((typeof(${column})='real' AND (${column}>1.7976931348623157e308 OR ${column}<-1.7976931348623157e308)) OR (typeof(${column})='integer' AND (${column}>9007199254740991 OR ${column}<-9007199254740991)))`
      )
      .join(' OR ');
    const contentPredicate = literalFilter
      ? ` AND (typeof(ch.content)<>'text' OR ${invalidValue} OR ${literalFilter.predicate})`
      : '';
    const statement = this.#database.prepare(
      `SELECT md.schema_version,md.store_id,md.index_mode,md.profile_json,md.profile_hash,native_chunks.* FROM index_metadata md LEFT JOIN (SELECT ${projection.join(',')} FROM file_chunks ch JOIN file_records fr ON fr.id=ch.file_record_id AND fr.root_id IS ch.root_id WHERE ${scopePredicate}${contentPredicate}) native_chunks ON 1=1 WHERE md.singleton=1 ORDER BY native_chunks.path,native_chunks.id`
    );
    statement.setReturnArrays(true);
    const columns = statement
      .columns()
      .slice(5)
      .map((column) => column.name);
    const rows: (readonly SqliteValue[])[] = [];
    let matchedChunks = 0;
    let identity: IndexerIdentity | undefined;
    let resultBytes = columns.reduce((total, column) => total + Buffer.byteLength(column) + 16, 0);
    const parameters = literalFilter
      ? [JSON.stringify(selectedIds), literalFilter.pattern]
      : [JSON.stringify(selectedIds)];
    for (const output of statement.iterate(...parameters)) {
      const snapshotRow = decodeRow(output);
      identity ??= decodeIndexIdentityRow({
        indexMode: snapshotRow[2],
        profileHash: snapshotRow[4],
        profileJson: snapshotRow[3],
        schemaVersion: snapshotRow[0],
        storeId: snapshotRow[1],
      });
      const row = snapshotRow.slice(5);
      if (row[0] === null) {
        continue;
      }
      const content = row[4];
      if (typeof content !== 'string') {
        throw new TypeError('Native grep chunk content must be text.');
      }
      if (!content.split('\n').some((line) => matcher.matches(line))) {
        continue;
      }
      matchedChunks += 1;
      if (rows.length === options.maxRows) {
        continue;
      }
      resultBytes += grepRowBytes(row);
      if (resultBytes > RESULT_LIMIT) {
        throw new RangeError(
          'Grep result exceeds the 1 MiB process-message budget. Reduce the result limit or refine the pattern.'
        );
      }
      rows.push(row);
    }
    if (!identity) {
      throw new TypeError('Native index metadata is missing; grep cannot identify its snapshot.');
    }
    return { columns, identity, matchedChunks, rows, truncated: matchedChunks > rows.length };
  }

  listTables(): SqliteRows {
    return this.query(
      "SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
      200
    );
  }

  describeTable(table: string): SqliteRows {
    return this.query(
      'SELECT name,type,"notnull" FROM pragma_table_info(?) ORDER BY cid',
      [table],
      200
    );
  }

  close(): void {
    this.#database.close();
  }
}

function grepLiteralFilter(
  options: SqliteGrepOptions
): { readonly pattern: string; readonly predicate: string } | undefined {
  // Surrogate/replacement needles do not preserve raw SQLite UTF-8 matching.
  if (
    options.isRegex ||
    Buffer.byteLength(options.pattern) > LENGTH_LIMIT ||
    /[\uD800-\uDFFF\uFFFD]/u.test(options.pattern)
  ) {
    return undefined;
  }
  if (options.caseSensitive) {
    return { pattern: options.pattern, predicate: 'instr(ch.content,?)>0' };
  }
  const pattern = options.pattern.toLowerCase();
  if (Buffer.byteLength(pattern) !== pattern.length) {
    return undefined;
  }
  // SQLite lower() folds ASCII only. Keep all non-ASCII/NUL rows for the JS matcher.
  return {
    pattern,
    predicate:
      '(instr(lower(ch.content),?)>0 OR length(CAST(ch.content AS BLOB))<>length(ch.content))',
  };
}

function grepRowBytes(row: readonly SqliteValue[]): number {
  return row.reduce<number>(
    (bytes, cell) =>
      bytes +
      16 +
      (typeof cell === 'string'
        ? Buffer.byteLength(cell)
        : cell instanceof Uint8Array
          ? cell.byteLength
          : 32),
    0
  );
}

function validateGrepOptions(options: SqliteGrepOptions): void {
  if (
    (options.rootIds.length === 0 && options.fileIds === undefined) ||
    options.rootIds.length > 100 ||
    options.rootIds.some((root) => !root.trim()) ||
    new Set(options.rootIds).size !== options.rootIds.length
  ) {
    throw new TypeError('Grep requires between 1 and 100 distinct nonempty root IDs.');
  }
  if (
    options.fileIds !== undefined &&
    (options.fileIds.some((id) => !id.trim()) ||
      new Set(options.fileIds).size !== options.fileIds.length)
  ) {
    throw new TypeError('Grep requires distinct nonempty canonical file IDs.');
  }
  if (options.pattern.length < 2 || options.pattern.length > LENGTH_LIMIT) {
    throw new TypeError('Grep pattern must have at least two characters and fit the value limit.');
  }
}

const decodeRow = makeThrowingDecoder(
  Schema.Array(
    Schema.Union([Schema.Null, Schema.String, Schema.Finite, Schema.BigInt, Schema.Uint8Array])
  )
);
