import { constants, DatabaseSync } from 'node:sqlite';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { sqliteVecExtensionPath } from '@brainstrike/sqlite-native';
import { Schema } from 'effect';
import type { SqliteRows, SqliteValue } from './protocol.js';
import { REVIEWED_FUNCTIONS } from './reviewed-functions.js';

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
        throw new Error('This SQLite runtime lacks required engine resource limits.');
      }
      const limits = decodeLimits(database.limits);
      if (limits.attach !== 0 || limits.length !== LENGTH_LIMIT) {
        throw new Error('SQLite did not apply the required attach and length limits.');
      }
      if (
        database
          .prepare(
            "SELECT 1 FROM pragma_compile_options WHERE compile_options='DEFAULT_MEMSTATUS=0'"
          )
          .get()
      ) {
        throw new Error(
          'This SQLite build disables memory accounting (DEFAULT_MEMSTATUS=0); refusing an unenforced heap limit.'
        );
      }
      database.loadExtension(sqliteVecExtensionPath());
      database.enableLoadExtension(false);
      const heap = decodeHeap(database.prepare(`PRAGMA hard_heap_limit=${HEAP_LIMIT}`).get());
      if (heap.hard_heap_limit <= 0 || heap.hard_heap_limit > HEAP_LIMIT) {
        throw new Error('SQLite did not apply the required hard heap limit.');
      }
      database.setAuthorizer((action, argument, functionName) => {
        switch (action) {
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

  query(sql: string, values: readonly SqliteValue[] = [], maxRows = 50): SqliteRows {
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
    for (const output of statement.iterate(...values)) {
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

const decodeRow = makeThrowingDecoder(
  Schema.Array(
    Schema.Union([Schema.Null, Schema.String, Schema.Finite, Schema.BigInt, Schema.Uint8Array])
  )
);
