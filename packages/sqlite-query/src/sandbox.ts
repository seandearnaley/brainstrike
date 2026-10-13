import { constants, DatabaseSync } from 'node:sqlite';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { decodeIndexIdentityRow, type IndexerIdentity } from '@brainstrike/indexer/metadata';
import { createGrepLineMatcher } from '@brainstrike/utils/grep-line-matcher';
import { planGrepTrigramCandidates } from '@brainstrike/utils/grep-trigram-plan';
import { Schema } from 'effect';
import type { SqliteGrepOptions, SqliteGrepRows, SqliteValue } from './protocol.js';
import { REVIEWED_FUNCTIONS } from './reviewed-functions.js';
import { SqliteRuntimeRefusedError } from './runtime-refusal.js';

const HEAP_LIMIT = 512 * 1024 * 1024;
const LENGTH_LIMIT = 16 * 1024 * 1024;
// Bound the payload before parent IPC deserialization, independently of row count.
const RESULT_LIMIT = 1024 * 1024;
const decodeLimits = makeThrowingDecoder(Schema.Struct({ attach: Schema.Int, length: Schema.Int }));
const decodeHeap = makeThrowingDecoder(Schema.Struct({ ['hard_heap_limit']: Schema.Int }));

export class SqliteSandbox {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    // The pinned Node 24 type definitions predate the runtime's limits backport.
    // Pass canonical constructor options, then verify the actual engine values.
    const options = {
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
      const heap = decodeHeap(database.prepare(`PRAGMA hard_heap_limit=${HEAP_LIMIT}`).get());
      if (heap.hard_heap_limit <= 0 || heap.hard_heap_limit > HEAP_LIMIT) {
        throw new SqliteRuntimeRefusedError('SQLite did not apply the required hard heap limit.');
      }
      database.setAuthorizer((action, argument, functionName) => {
        switch (action) {
          case constants.SQLITE_SELECT:
          case constants.SQLITE_READ:
            return constants.SQLITE_OK;
          case constants.SQLITE_FUNCTION:
            return functionName !== null && REVIEWED_FUNCTIONS.has(functionName.toLowerCase())
              ? constants.SQLITE_OK
              : constants.SQLITE_DENY;
          // FTS5 reads `PRAGMA data_version` before a trigram MATCH to validate its cached structure.
          case constants.SQLITE_PRAGMA:
            return argument?.toLowerCase() === 'data_version'
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

  /**
   * Exhaustive authorized-scope grep in this killable reader, never the writer.
   * A trigram plan narrows the chunks read for matching; the line matcher
   * still decides every row, so results equal the exhaustive scan.
   */
  grep(options: SqliteGrepOptions): SqliteGrepRows {
    validateGrepOptions(options);
    const matcher = createGrepLineMatcher(options.pattern, options.isRegex, options.caseSensitive);
    const plan = planGrepTrigramCandidates(options.pattern, options.isRegex, options.caseSensitive);
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
    // Trigram candidates replace the literal prefilter. The table's content_rowid
    // is file_chunks.pk, the INTEGER PRIMARY KEY alias of each chunk's rowid.
    const contentFilter =
      plan.kind === 'candidates'
        ? {
            pattern: plan.match,
            predicate:
              'ch.rowid IN (SELECT rowid FROM file_chunks_trigram WHERE file_chunks_trigram MATCH ?)',
          }
        : grepLiteralFilter(options);
    // Keep every row that the existing decoder would reject, including nonmatching rows.
    const invalidValue = projection
      .map(
        (column) =>
          `((typeof(${column})='real' AND (${column}>1.7976931348623157e308 OR ${column}<-1.7976931348623157e308)) OR (typeof(${column})='integer' AND (${column}>9007199254740991 OR ${column}<-9007199254740991)))`
      )
      .join(' OR ');
    const contentPredicate = contentFilter
      ? ` AND (typeof(ch.content)<>'text' OR ${invalidValue} OR ${contentFilter.predicate})`
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
    const parameters = contentFilter
      ? [JSON.stringify(selectedIds), contentFilter.pattern]
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
