/**
 * Agent SQL sandbox — the execution boundary behind `brainstrike.querySelf`.
 *
 * Brainstrike's local database holds the agent's own work (run outcomes, edit
 * checkpoints, run usage, diagnostic events, queue metrics) alongside the code
 * index, so a single statement can answer questions that otherwise cost dozens
 * of tool calls. This service is what makes handing the model SQL safe.
 *
 * FOUR INDEPENDENT, ENGINE-ENFORCED LAYERS. Each blocks something the others
 * do not; none is redundant:
 *
 *   1. Read-only transaction  — blocks INSERT/UPDATE/DELETE and DDL.
 *   2. Non-superuser role     — blocks pg_read_file/pg_ls_dir (arbitrary
 *                               filesystem reads that would bypass workspace
 *                               containment), COPY … TO PROGRAM, and pg_authid.
 *                               A read-only transaction does NOT block these.
 *   3. Extended protocol      — blocks multi-statement text; PGlite's `query`
 *                               rejects it at the protocol layer, so we never
 *                               hand-roll a SQL splitter.
 *   4. EXPLAIN cost gate      — blocks runaway plans.
 *
 * WHY THE COST GATE EXISTS: PGlite ACCEPTS AND REPORTS `statement_timeout` BUT
 * NEVER ENFORCES IT. Measured against PGlite 0.5.3 / PG 18.3 — `pg_sleep(1)`
 * and a 2.5s cartesian product both run to completion under a 100ms timeout
 * while `SHOW statement_timeout` reports `100ms` the whole time. The WASM build
 * has no timer interrupt to fire it. Because PGlite is a SINGLE connection, an
 * unbounded query freezes live queries, the job queue, and the UI — a whole-app
 * DoS, not a slow tool call. Do not "restore" the timeout as a guarantee.
 *
 * Full contract and evidence: `docs/agents/agent-self-query.md`.
 */

/** The non-superuser role created by migration 074. */
export const AGENT_READONLY_ROLE = 'brainstrike_agent_readonly';

/**
 * Planner-cost ceiling above which a statement is refused.
 *
 * Derived from measurement, not taste (PGlite 0.5.3 / PG 18.3):
 *
 *   SELECT * FROM t LIMIT 10                          →       0.15
 *   wrapped CTE over 5k rows                          →      89.5
 *   5k-row self cross join                            → 375,166
 *   generate_series(1,6000) squared                   → 810,060
 *
 * 50,000 sits above ordinary full scans and joins over realistic local corpora
 * and well below cartesian explosions. If this ever needs to move, RE-RUN THE
 * MEASUREMENT — do not guess a new number.
 */
export const DEFAULT_AGENT_SQL_COST_CEILING = 50_000;

export const DEFAULT_AGENT_SQL_MAX_ROWS = 50;

/** Hard cap on caller-requested rows, independent of the projection budget. */
export const MAX_AGENT_SQL_MAX_ROWS = 200;

/**
 * Invalid input from the caller (empty SQL, out-of-range row cap).
 *
 * Distinct from a PostgreSQL error: these are safe to surface verbatim to the
 * model because they describe the model's own input and are locally
 * constructed — the same class as the multi-root resolution errors that
 * deliberately bypass the error sanitizer.
 */
export class AgentSqlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSqlInputError';
  }
}

/** A statement whose planned cost exceeds the ceiling. Carries the numbers so
 * the model can narrow instead of retrying blindly. */
export class AgentSqlCostRejectedError extends Error {
  readonly costCeiling: number;
  readonly estimatedCost: number;

  constructor(estimatedCost: number, costCeiling: number) {
    super(
      `Query refused: estimated planner cost ${Math.round(estimatedCost)} exceeds the ceiling of ` +
        `${Math.round(costCeiling)}. Narrow the query with a WHERE clause, a smaller LIMIT, or an ` +
        'aggregate. This database has a single connection and no working statement timeout, so an ' +
        'unbounded query would freeze the application.'
    );
    this.name = 'AgentSqlCostRejectedError';
    this.estimatedCost = estimatedCost;
    this.costCeiling = costCeiling;
  }
}

export interface AgentSqlQueryResult {
  /** Column names, in order, positionally aligned with every row. Duplicates
   * are preserved — object-keyed rows would silently collapse `a.id, b.id`. */
  columns: string[];
  /** Planner cost of the admitted statement, for observability. */
  estimatedCost: number;
  maxRows: number;
  rows: unknown[][];
  /** True when the source produced more rows than `maxRows`. */
  truncated: boolean;
}

export interface AgentSqlTableSummary {
  /** Planner row estimate from `pg_class.reltuples`; -1 before first ANALYZE. */
  estimatedRows: number;
  name: string;
}

export interface AgentSqlColumnInfo {
  dataType: string;
  name: string;
  nullable: boolean;
}

interface QueryFieldLike {
  name: string;
}

interface QueryResultLike<T> {
  fields?: QueryFieldLike[];
  rows: T[];
}

interface AgentSqlTransaction {
  exec: (sql: string) => Promise<unknown>;
  query: <T>(
    sql: string,
    params?: unknown[],
    options?: { rowMode?: 'array' }
  ) => Promise<QueryResultLike<T>>;
}

/**
 * Structural subset of PGlite / the desktop remote client.
 *
 * `transaction` is REQUIRED rather than optional: the sandbox is only sound if
 * `SET TRANSACTION READ ONLY`, `SET LOCAL ROLE`, and the statement itself all
 * land on the same session. A client that cannot guarantee that affinity must
 * not be handed this service.
 */
export interface AgentSqlDatabase {
  transaction: <T>(fn: (tx: AgentSqlTransaction) => Promise<T>) => Promise<T>;
}

interface ExplainPlanNode {
  'Total Cost'?: number;
}

interface ExplainRow {
  'QUERY PLAN': unknown;
}

/**
 * Reads `Plan."Total Cost"` out of an `EXPLAIN (FORMAT JSON)` result.
 *
 * PGlite returns the plan already parsed in some paths and as JSON text in
 * others, so both are handled. A shape we cannot read is a hard failure: an
 * unreadable plan means the cost gate did not run, and admitting a statement
 * whose cost is unknown would silently drop the only working admission control.
 */
function readTotalCost(rows: ExplainRow[]): number {
  const raw = rows[0]?.['QUERY PLAN'];
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const first = Array.isArray(parsed) ? (parsed[0] as { Plan?: ExplainPlanNode }) : undefined;
  const cost = first?.Plan?.['Total Cost'];

  if (typeof cost !== 'number' || !Number.isFinite(cost)) {
    throw new Error('Could not read a planner cost estimate; refusing to run the statement.');
  }
  return cost;
}

export interface AgentSqlServiceOptions {
  costCeiling?: number;
}

export class AgentSqlService {
  private readonly costCeiling: number;
  private readonly db: AgentSqlDatabase;

  constructor(db: AgentSqlDatabase, options: AgentSqlServiceOptions = {}) {
    this.db = db;
    this.costCeiling = options.costCeiling ?? DEFAULT_AGENT_SQL_COST_CEILING;
  }

  /**
   * Runs one read-only statement inside the sandbox.
   *
   * PostgreSQL errors propagate unchanged. That is deliberate: a syntax error
   * naming the offending token, or `permission denied for function
   * pg_read_file`, teaches the model to write a correct query. Collapsing them
   * into a generic failure would make the tool unusable.
   */
  async query(sql: string, options: { maxRows?: number } = {}): Promise<AgentSqlQueryResult> {
    const statement = sql.trim();
    if (statement.length === 0) {
      throw new AgentSqlInputError('SQL statement must not be empty.');
    }

    const maxRows = options.maxRows ?? DEFAULT_AGENT_SQL_MAX_ROWS;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_AGENT_SQL_MAX_ROWS) {
      throw new AgentSqlInputError(
        `maxRows must be an integer between 1 and ${MAX_AGENT_SQL_MAX_ROWS}.`
      );
    }

    // Strip one trailing semicolon so an ordinary `SELECT 1;` is not a syntax
    // error once wrapped. Anything beyond that (a real second statement) still
    // reaches the protocol layer and is rejected there — we never split SQL
    // ourselves, because a hand-rolled splitter is exactly the kind of parser
    // that gets bypassed.
    const unterminated = statement.replace(/;\s*$/, '');

    // Fetch one extra row so truncation is detected without a second query.
    const wrapped = `SELECT * FROM (${unterminated}) AS _bs_agent_q LIMIT ${maxRows + 1}`;

    return await this.db.transaction(async (tx) => {
      await tx.exec('SET TRANSACTION READ ONLY');
      await tx.exec(`SET LOCAL ROLE ${AGENT_READONLY_ROLE}`);

      const explained = await tx.query<ExplainRow>(`EXPLAIN (FORMAT JSON) ${wrapped}`);
      const estimatedCost = readTotalCost(explained.rows);
      if (estimatedCost > this.costCeiling) {
        throw new AgentSqlCostRejectedError(estimatedCost, this.costCeiling);
      }

      const result = await tx.query<unknown[]>(wrapped, [], { rowMode: 'array' });
      const truncated = result.rows.length > maxRows;

      return {
        columns: (result.fields ?? []).map((field) => field.name),
        estimatedCost,
        maxRows,
        rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
        truncated,
      };
    });
  }

  /**
   * Lists the application tables the agent may read.
   *
   * Scoped to `public` and to base tables so the model sees the application
   * schema rather than the ~100 catalog and information_schema relations it has
   * no business querying.
   */
  async describeTables(): Promise<AgentSqlTableSummary[]> {
    const result = await this.query(
      `SELECT c.relname AS name, c.reltuples::bigint AS estimated_rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
      { maxRows: MAX_AGENT_SQL_MAX_ROWS }
    );

    return result.rows.map((row) => ({
      estimatedRows: Number(row[1] ?? -1),
      name: String(row[0]),
    }));
  }

  /**
   * Describes one public table's columns. An unknown table returns `[]` rather
   * than throwing — "no such table" is information the model can act on, and
   * the `public`-schema predicate means a catalog table name simply finds
   * nothing instead of leaking catalog structure.
   */
  async describeTable(table: string): Promise<AgentSqlColumnInfo[]> {
    const result = await this.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${quoteLiteral(table)}
        ORDER BY ordinal_position`,
      { maxRows: MAX_AGENT_SQL_MAX_ROWS }
    );

    return result.rows.map((row) => ({
      dataType: String(row[1]),
      name: String(row[0]),
      nullable: String(row[2]).toUpperCase() === 'YES',
    }));
  }
}

/**
 * Single-quotes a string literal for inline embedding.
 *
 * `describeTable` composes SQL text rather than using a bind parameter because
 * the statement is wrapped in a subquery before execution and the wrapper owns
 * parameter positions. The value is escaped by doubling quotes and the result
 * runs inside the same read-only, non-superuser sandbox as any other statement,
 * so the blast radius of a crafted table name is a failed SELECT.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
