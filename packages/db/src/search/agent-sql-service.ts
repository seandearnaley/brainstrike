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

/**
 * Plan node types that must CONSUME their entire input before producing a row.
 *
 * A `Recursive Union` beneath one of these cannot be bounded by the row cap:
 * the parent drains the recursion first, so an unterminated CTE runs until
 * memory is exhausted. Beneath a pipelining parent (`CTE Scan`) the same
 * recursion stops as soon as the LIMIT is satisfied.
 *
 * Measured, not assumed (PGlite 0.5.3):
 *   LIMIT over a pipelined unbounded recursion -> 51 rows in 869ms
 *   count(*) over the same recursion           -> still running after 10s
 *
 * Deliberately conservative: an unrecognised blocking node should fail CLOSED,
 * so add to this set rather than narrowing it.
 */
const DRAINING_PLAN_NODE_TYPES: ReadonlySet<string> = new Set([
  'Aggregate',
  'GroupAggregate',
  'Group',
  'Hash',
  'HashAggregate',
  'Materialize',
  'Memoize',
  'SetOp',
  'Sort',
  'Unique',
  'WindowAgg',
]);

const RECURSIVE_UNION_NODE_TYPE = 'Recursive Union';
const WORKTABLE_SCAN_NODE_TYPE = 'WorkTable Scan';

/**
 * A recursive CTE the row cap cannot bound.
 *
 * The cost gate cannot catch this class: an unbounded recursion plans at a
 * trivial cost (measured: 3.35) because the planner uses a fixed row-estimate
 * multiplier for the recursive term. The PLANNER does, however, name the
 * construct — so this guard reads the plan tree rather than pattern-matching
 * SQL text, keeping every admission decision engine-derived.
 */
export class AgentSqlUnboundedRecursionError extends Error {
  constructor() {
    // Deliberately covers BOTH rejection paths without naming a cause that may
    // not apply: query() rejects only when a draining parent defeats the row
    // cap, while explain(analyze) rejects any unbounded recursion because it has
    // no row cap at all. A message asserting "an aggregate or sort" would be
    // wrong on the analyze path.
    super(
      'Query refused: this recursive CTE has no termination condition the planner can see, and ' +
        'nothing here can bound it — either it feeds an aggregate/sort that must drain it before ' +
        'returning a row, or it is running under EXPLAIN ANALYZE, which has no row cap. An ' +
        'unterminated recursion would exhaust memory. Add a termination condition to the ' +
        'recursive term (for example WHERE depth < 10, or a join that runs out of rows), or ' +
        'select from the CTE directly instead of aggregating or ordering it.'
    );
    this.name = 'AgentSqlUnboundedRecursionError';
  }
}

export interface AgentSqlExplainResult {
  /** True when the statement was actually executed to collect real timings. */
  analyzed: boolean;
  /** The plan, one line per row of PostgreSQL's text output. */
  plan: string[];
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
  readonly name: string;
}

interface QueryResultLike<T> {
  /**
   * Output column descriptors, present when array row mode was requested.
   *
   * Readonly throughout so both PGlite (mutable arrays) and the desktop remote
   * client (readonly arrays) satisfy this interface. Declaring it mutable made
   * `RemoteDbClient` structurally incompatible and hid a production break behind
   * tests that only ever ran against raw PGlite.
   */
  readonly fields?: readonly QueryFieldLike[];
  readonly rows: T[];
}

interface AgentSqlTransaction {
  exec: (sql: string) => Promise<unknown>;
  query: <T>(
    sql: string,
    params?: readonly unknown[],
    options?: { readonly rowMode?: 'array' }
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

interface ExplainRow {
  'QUERY PLAN': unknown;
}

/**
 * The subset of PostgreSQL's JSON plan node this service reads.
 *
 * The bound-condition keys are declared individually rather than via an index
 * signature so a typo in `RECURSION_BOUND_KEYS` is a compile error instead of a
 * silently-always-undefined lookup — which would quietly turn every recursion
 * into "unbounded" and re-break the traversal case.
 */
interface ExplainPlanNode {
  Filter?: string;
  'Hash Cond'?: string;
  'Index Cond'?: string;
  'Join Filter'?: string;
  'Merge Cond'?: string;
  'Node Type'?: string;
  Plans?: ExplainPlanNode[];
  'Recheck Cond'?: string;
  'Total Cost'?: number;
}

/**
 * Plan attributes that restrict a recursive term.
 *
 * A `Filter` on the `WorkTable Scan` is only ONE way a recursion terminates.
 * The canonical graph traversal terminates by running out of edges, and its
 * bound is a JOIN condition above the work table, not a node-local predicate:
 *
 *   Recursive Union
 *     Seq Scan     Filter="(source = 1)"
 *     Hash Join    Hash Cond="(r.id = e.source)"   <- this is the bound
 *       WorkTable Scan                              <- no Filter at all
 *
 * Treating absence-of-`Filter` as absence-of-bound rejected exactly the
 * BST-919 symbol-graph traversal this guard exists to preserve. Verified on
 * PGlite 0.5.3 for both `UNION ALL` and `UNION` (dedup) recursion.
 */
const RECURSION_BOUND_KEYS = [
  'Filter',
  'Hash Cond',
  'Index Cond',
  'Join Filter',
  'Merge Cond',
  'Recheck Cond',
] as const satisfies readonly (keyof ExplainPlanNode)[];

/**
 * True when a `Recursive Union`'s recursive term has NO restriction anywhere
 * between it and the work table.
 *
 * HONEST LIMIT: a bound is not a PROOF of termination — `WHERE n > 0` on an
 * incrementing counter still runs forever. This catches the accidental and
 * obvious case, which is the realistic failure mode. It is a heuristic layered
 * on the row cap, not a decidability result.
 */
function hasUnboundedRecursiveTerm(recursiveUnion: ExplainPlanNode): boolean {
  const walk = (node: ExplainPlanNode, boundAbove: boolean): boolean => {
    const bound = boundAbove || RECURSION_BOUND_KEYS.some((key) => typeof node[key] === 'string');
    if (node['Node Type'] === WORKTABLE_SCAN_NODE_TYPE) {
      return !bound;
    }
    return (node.Plans ?? []).some((child) => walk(child, bound));
  };
  return walk(recursiveUnion, false);
}

/**
 * Finds a recursion this call cannot bound.
 *
 * `requireDrainingParent` is the load-bearing difference between the two
 * callers, and getting it wrong reopens the hang through a different door:
 *
 * - `query()` wraps the statement in `LIMIT n+1`, so a recursion feeding a
 *   PIPELINING parent stops as soon as the cap is satisfied (measured: 51 rows
 *   in 869ms). Only a DRAINING parent defeats the cap, so the draining
 *   condition is required there.
 * - `explain(analyze)` has NO wrapper — `EXPLAIN` is invalid inside a FROM
 *   subquery — and `ANALYZE` runs the statement to completion. The parent shape
 *   is therefore irrelevant: ANY unbounded recursive term is unstoppable.
 *   Measured: `EXPLAIN ANALYZE … SELECT n FROM r` was still running after 10s.
 */
function findUnboundableRecursion(
  plan: ExplainPlanNode,
  options: { requireDrainingParent: boolean },
  drainingAbove = false
): boolean {
  const nodeType = plan['Node Type'];
  if (nodeType === RECURSIVE_UNION_NODE_TYPE) {
    if (!options.requireDrainingParent || drainingAbove) {
      return hasUnboundedRecursiveTerm(plan);
    }
    return false;
  }
  const draining =
    drainingAbove || (nodeType !== undefined && DRAINING_PLAN_NODE_TYPES.has(nodeType));
  return (plan.Plans ?? []).some((child) => findUnboundableRecursion(child, options, draining));
}

function readPlanRoot(rows: ExplainRow[]): { cost: number; plan: ExplainPlanNode } {
  const raw = rows[0]?.['QUERY PLAN'];
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const first = Array.isArray(parsed) ? (parsed[0] as { Plan?: ExplainPlanNode }) : undefined;
  const plan = first?.Plan;
  const cost = plan?.['Total Cost'];

  // Returning the already-validated cost keeps call sites free of an
  // `as number` assertion on a value this function just proved is a number.
  if (plan === undefined || typeof cost !== 'number' || !Number.isFinite(cost)) {
    throw new Error('Could not read a planner cost estimate; refusing to run the statement.');
  }
  return { cost, plan };
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
   * The single admission gate: plan the statement, then apply every guard.
   *
   * Extracted because `query()` and `explain(analyze)` previously hand-rolled
   * the same read-plan → recursion-guard → cost-ceiling sequence. That is the
   * exact divergence this codebase keeps getting bitten by: the next guard
   * added to one path would silently not apply to the other. The ONLY
   * difference between the callers is `requireDrainingParent`, and it is now a
   * named argument rather than an accident.
   */
  private async admit(
    tx: AgentSqlTransaction,
    statement: string,
    options: { requireDrainingParent: boolean }
  ): Promise<number> {
    const explained = await tx.query<ExplainRow>(`EXPLAIN (FORMAT JSON) ${statement}`);
    const { cost, plan } = readPlanRoot(explained.rows);

    // Reported before a cost rejection when both would fire: this names a
    // specific, fixable mistake, where the cost message is generic.
    if (findUnboundableRecursion(plan, options)) {
      throw new AgentSqlUnboundedRecursionError();
    }
    if (cost > this.costCeiling) {
      throw new AgentSqlCostRejectedError(cost, this.costCeiling);
    }
    return cost;
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

      // requireDrainingParent: the LIMIT wrapper below bounds a recursion that
      // feeds a pipelining parent, so only a draining parent is a problem here.
      const estimatedCost = await this.admit(tx, wrapped, { requireDrainingParent: true });

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
   * Returns the PostgreSQL query plan for a statement.
   *
   * Statistics tell you WHAT is slow; plans tell you WHY. Without this the
   * agent can read every `pg_stat_*` view and still never see an index decision.
   *
   * Two modes with genuinely different risk:
   *
   * - Plain `EXPLAIN` only PLANS. It cannot execute, so neither the cost
   *   ceiling nor the recursion guard applies — and deliberately so: explaining
   *   an expensive query is exactly when its plan is most valuable, so refusing
   *   on cost would defeat the purpose.
   * - `EXPLAIN ANALYZE` EXECUTES the statement. It therefore goes through the
   *   same admission gates as a normal query. Writes remain blocked by the
   *   read-only transaction, so `EXPLAIN ANALYZE INSERT …` cannot slip a
   *   mutation through.
   *
   * Not wrapped in the row-cap subquery: `EXPLAIN` is invalid inside a FROM
   * subquery, which is why plans were unreachable before this method existed.
   */
  async explain(sql: string, options: { analyze?: boolean } = {}): Promise<AgentSqlExplainResult> {
    const statement = sql.trim().replace(/;\s*$/, '');
    if (statement.length === 0) {
      throw new AgentSqlInputError('SQL statement must not be empty.');
    }
    const analyze = options.analyze === true;

    return await this.db.transaction(async (tx) => {
      await tx.exec('SET TRANSACTION READ ONLY');
      await tx.exec(`SET LOCAL ROLE ${AGENT_READONLY_ROLE}`);

      if (analyze) {
        // requireDrainingParent: FALSE — and this is the whole reason the flag
        // exists. There is no LIMIT wrapper on this path (EXPLAIN is invalid
        // inside a FROM subquery), so ANALYZE runs the statement to completion
        // and the parent shape is irrelevant: any unbounded recursive term
        // hangs the single connection. Measured before this guard existed:
        // `EXPLAIN ANALYZE … SELECT n FROM r` was still running after 10s.
        await this.admit(tx, statement, { requireDrainingParent: false });
      }

      // TEXT rather than JSON: it is the format every Postgres operator reads,
      // and it is far more compact per unit of information than the JSON tree.
      const result = await tx.query<Record<string, unknown>>(
        `EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT TEXT) ${statement}`
      );

      return {
        analyzed: analyze,
        plan: result.rows.map((row) => String(Object.values(row)[0] ?? '')),
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
