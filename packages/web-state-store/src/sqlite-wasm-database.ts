import type { Database, PreparedStatement, Sqlite3Static, SqlValue } from '@sqlite.org/sqlite-wasm';

/**
 * The state DB's shared modules (`@brainstrike/state-store`'s schema, run log
 * and domains) are written against better-sqlite3's synchronous API. This is
 * that API's subset, over the official build's oo1 `Database`, so the browser
 * writer runs those modules unchanged instead of a second copy of them.
 *
 * Binding follows better-sqlite3, not oo1: only numbers, bigints, strings,
 * `Uint8Array` and null bind, and only positionally. A value better-sqlite3
 * would refuse (a boolean, `undefined`, a named-parameter object) throws here
 * too, so a statement that works in the browser also works on the desktop.
 */

type Bindable = number | bigint | string | Uint8Array | null;
type Row = Record<string, SqlValue>;

/** Statements mid-use, so a re-entrant use of the same SQL compiles its own. */
const busy = new WeakSet<PreparedStatement>();

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/** better-sqlite3 errors carry the extended result code's name; `isCorrupt` reads it. */
function withCode(sqlite3: Sqlite3Static, error: unknown): unknown {
  if (error instanceof sqlite3.SQLite3Error && typeof error.resultCode === 'number') {
    Object.assign(error, { code: sqlite3.capi.sqlite3_js_rc_str(error.resultCode) });
  }
  return error;
}

function bindings(params: readonly unknown[]): Bindable[] {
  const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return values.map((value: unknown, index: number) => {
    if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
      // better-sqlite3 reads a plain object as named parameters; the state DB modules bind positionally only.
      throw new RangeError(
        `Named parameters are not supported (parameter ${index + 1} is an object)`
      );
    }
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'string' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError(
      `SQLite can bind only numbers, bigints, strings, Uint8Arrays and null (parameter ${index + 1} is ${
        value === undefined ? 'undefined' : typeof value
      })`
    );
  });
}

/** A rowid as better-sqlite3 reports it: a number while it is a safe integer. */
function rowid(value: bigint | number): number | bigint {
  if (typeof value === 'number') {
    return value;
  }
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value;
}

export class SqliteWasmStatement {
  #pluck = false;

  constructor(
    private readonly owner: SqliteWasmDatabase,
    readonly source: string
  ) {}

  /** Rows return their first column instead of an object, as better-sqlite3's `pluck()`. */
  pluck(toggle = true): this {
    this.#pluck = toggle;
    return this;
  }

  run(...params: unknown[]): RunResult {
    return this.owner.execute(this.source, bindings(params), (stmt) => {
      while (stmt.step()) {
        // A RETURNING clause's rows are discarded, as better-sqlite3's run() does.
      }
      return {
        changes: this.owner.connection.changes(),
        lastInsertRowid: rowid(
          this.owner.sqlite3.capi.sqlite3_last_insert_rowid(this.owner.connection)
        ),
      };
    });
  }

  get(...params: unknown[]): unknown {
    return this.owner.execute(this.source, bindings(params), (stmt) =>
      stmt.step() ? this.row(stmt) : undefined
    );
  }

  all(...params: unknown[]): unknown[] {
    return this.owner.execute(this.source, bindings(params), (stmt) => {
      const rows: unknown[] = [];
      while (stmt.step()) {
        rows.push(this.row(stmt));
      }
      return rows;
    });
  }

  /**
   * Rows one at a time. better-sqlite3 steps lazily; the run log consumes every
   * iteration fully, so the rows are read eagerly here and the statement is
   * free again before the first row is handed out.
   */
  iterate(...params: unknown[]): IterableIterator<unknown> {
    return this.all(...params)[Symbol.iterator]();
  }

  private row(stmt: PreparedStatement): unknown {
    return this.#pluck ? stmt.get(0) : stmt.get({} as Row);
  }
}

/**
 * better-sqlite3's `Database` subset the state DB modules use: `prepare`,
 * `exec`, `pragma`, `transaction`, `inTransaction`, `name` and `close`.
 */
export class SqliteWasmDatabase {
  /** Compiled statements by SQL text. A facade statement is cheap; compiling is not. */
  readonly #compiled = new Map<string, PreparedStatement>();
  #savepoints = 0;

  constructor(
    readonly sqlite3: Sqlite3Static,
    readonly connection: Database,
    readonly name: string
  ) {}

  get inTransaction(): boolean {
    return this.sqlite3.capi.sqlite3_get_autocommit(this.connection) === 0;
  }

  prepare(source: string): SqliteWasmStatement {
    // Compile now, so a syntax error throws at prepare() as it does in better-sqlite3.
    this.compiled(source);
    return new SqliteWasmStatement(this, source);
  }

  exec(source: string): this {
    try {
      this.connection.exec(source);
    } catch (error) {
      throw withCode(this.sqlite3, error);
    }
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.prepare(`PRAGMA ${source}`).all();
    if (!options.simple) {
      return rows;
    }
    const first = rows[0] as Row | undefined;
    return first === undefined ? undefined : Object.values(first)[0];
  }

  /**
   * better-sqlite3's `transaction(fn)`: BEGIN/COMMIT, or a savepoint when
   * called inside another transaction; any throw rolls back and rethrows.
   */
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result
  ): (...args: Args) => Result {
    return (...args: Args): Result => {
      if (!this.inTransaction) {
        this.exec('BEGIN');
        try {
          const result = fn(...args);
          this.exec('COMMIT');
          return result;
        } catch (error) {
          if (this.inTransaction) {
            this.exec('ROLLBACK');
          }
          throw error;
        }
      }
      const savepoint = `wasm_txn_${++this.#savepoints}`;
      this.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn(...args);
        this.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.exec(`ROLLBACK TO ${savepoint}`);
        this.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    };
  }

  close(): void {
    for (const stmt of this.#compiled.values()) {
      stmt.finalize();
    }
    this.#compiled.clear();
    this.connection.close();
  }

  /**
   * Runs `use` on the statement for `source` with `params` bound, then resets
   * it. A statement already mid-use (re-entered from inside `use`) gets a
   * one-off compile, finalized afterwards.
   */
  execute<T>(source: string, params: Bindable[], use: (stmt: PreparedStatement) => T): T {
    let stmt = this.compiled(source);
    let oneOff = false;
    if (busy.has(stmt)) {
      stmt = this.compile(source);
      oneOff = true;
    }
    busy.add(stmt);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      const result = use(stmt);
      stmt.reset(true);
      return result;
    } catch (error) {
      // After a failed step, sqlite3_reset returns that step's error again, and
      // oo1's reset() would throw it; the step's own error is the one to report.
      if (stmt.pointer !== undefined) {
        this.sqlite3.capi.sqlite3_reset(stmt.pointer);
        this.sqlite3.capi.sqlite3_clear_bindings(stmt.pointer);
      }
      throw withCode(this.sqlite3, error);
    } finally {
      busy.delete(stmt);
      if (oneOff) {
        stmt.finalize();
      }
    }
  }

  private compiled(source: string): PreparedStatement {
    let stmt = this.#compiled.get(source);
    if (!stmt) {
      stmt = this.compile(source);
      this.#compiled.set(source, stmt);
    }
    return stmt;
  }

  private compile(source: string): PreparedStatement {
    try {
      return this.connection.prepare(source);
    } catch (error) {
      throw withCode(this.sqlite3, error);
    }
  }
}
