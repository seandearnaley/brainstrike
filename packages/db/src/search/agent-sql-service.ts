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
 * Plan node types that pass the row cap's demand straight through to their
 * child: each emits at most one row per input row and never buffers.
 *
 * An ALLOWLIST, not a denylist, and that direction is the whole point. The
 * previous version listed DRAINING parents (`Sort`, `Aggregate`, …) and treated
 * everything else as safe — which is fail-open, and two distinct shapes walked
 * through it: a `CTE Scan` carrying a row-suppressing `Filter` (the cap never
 * fills, so the recursion never stops), and node types that simply were not on
 * the list. Two entries on that list — `HashAggregate` and `GroupAggregate` —
 * were not even real values: PostgreSQL emits `"Node Type": "Aggregate"` with
 * `"Strategy": "Hashed"`. Anything unrecognised now fails CLOSED.
 *
 * Measured on PGlite 0.5.3 / PG 18.3:
 *   Limit -> CTE Scan -> Recursive Union            -> 51 rows in 869ms
 *   Limit -> CTE Scan (Filter) -> Recursive Union   -> still running after 10s
 *   Limit -> Aggregate -> Recursive Union           -> still running after 10s
 */
const PASS_THROUGH_PLAN_NODE_TYPES: ReadonlySet<string> = new Set([
  'CTE Scan',
  // `OFFSET` plans as a nested `Limit`; both still propagate row demand down.
  'Limit',
  'Result',
  'Subquery Scan',
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
    // Deliberately names no single cause. There are four, and asserting the
    // wrong one teaches the model to make the wrong edit: a draining parent
    // (aggregate/sort), a predicate above the CTE that suppresses every row so
    // the cap never fills, a second recursion in the same plan, or EXPLAIN
    // ANALYZE, which has no row cap at all.
    super(
      'Query refused: this recursive CTE has no termination condition the planner can see, and ' +
        'nothing in this statement can bound it — it feeds an aggregate or sort that must drain ' +
        'it, a WHERE clause above it suppresses the rows the row cap counts, another recursion ' +
        'shares the plan, or it is running under EXPLAIN ANALYZE. An unterminated recursion would ' +
        'exhaust memory. Add a termination condition to the recursive term (for example ' +
        'WHERE depth < 10, or a join that runs out of rows), and select from the CTE directly ' +
        'rather than aggregating, ordering, or filtering it from outside.'
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
  'One-Time Filter'?: string;
  Plans?: ExplainPlanNode[];
  'Recheck Cond'?: string;
  'TID Cond'?: string;
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
  'One-Time Filter',
  'Recheck Cond',
  'TID Cond',
] as const satisfies readonly (keyof ExplainPlanNode)[];

/**
 * True when a node forwards the row cap's demand to its child unchanged.
 *
 * A pass-through NODE TYPE is not sufficient — the same keys that BOUND a
 * recursive term (above) SUPPRESS rows when they sit above one. `CTE Scan` with
 * `Filter="(n < 0)"` pipelines perfectly and still emits nothing, so `LIMIT 51`
 * is never satisfied and the recursion below runs forever.
 */
function isPassThrough(node: ExplainPlanNode): boolean {
  const nodeType = node['Node Type'];
  if (nodeType === undefined || !PASS_THROUGH_PLAN_NODE_TYPES.has(nodeType)) {
    return false;
  }
  return !RECURSION_BOUND_KEYS.some((key) => typeof node[key] === 'string');
}

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

interface RecursiveUnionSite {
  /** True when EVERY node between the plan root and this one is pass-through. */
  reachedByRowCap: boolean;
  unboundedTerm: boolean;
}

/**
 * Collects EVERY `Recursive Union` in the plan, with whether the row cap's
 * demand actually reaches it.
 *
 * Collects rather than short-circuits because a traversal that stopped at the
 * first `Recursive Union` never examined the rest. PostgreSQL plans two CTEs as
 * SIBLINGS under one `CTE Scan` (verified on PGlite 0.5.3), so a bounded
 * recursion encountered first hid an unbounded one beside it — fail-open.
 *
 * Descends THROUGH a `Recursive Union` as well: its own subplans may contain
 * further recursion.
 */
function collectRecursiveUnions(
  plan: ExplainPlanNode,
  reachedByRowCap: boolean,
  found: RecursiveUnionSite[] = []
): RecursiveUnionSite[] {
  const isRecursiveUnion = plan['Node Type'] === RECURSIVE_UNION_NODE_TYPE;
  if (isRecursiveUnion) {
    found.push({ reachedByRowCap, unboundedTerm: hasUnboundedRecursiveTerm(plan) });
  }
  const childReach = !isRecursiveUnion && reachedByRowCap && isPassThrough(plan);
  for (const child of plan.Plans ?? []) {
    collectRecursiveUnions(child, childReach, found);
  }
  return found;
}

/**
 * Finds a recursion this call cannot bound.
 *
 * `boundedByRowCap` is the load-bearing difference between the two callers, and
 * getting it wrong reopens the hang through a different door:
 *
 * - `query()` wraps the statement in `LIMIT n+1`. That cap stops a recursion
 *   only when every node above it forwards the demand AND emits its input
 *   (measured: 51 rows in 869ms). A draining parent OR a row-suppressing
 *   predicate defeats it.
 * - `explain(analyze)` has NO wrapper — `EXPLAIN` is invalid inside a FROM
 *   subquery — and `ANALYZE` runs the statement to completion. The parent shape
 *   is therefore irrelevant: ANY unbounded recursive term is unstoppable.
 *   Measured: `EXPLAIN ANALYZE … SELECT n FROM r` was still running after 10s.
 *
 * When several recursions coexist, an unbounded one is refused unconditionally:
 * the plan tree does not record which parent drains which sibling CTE, so there
 * is no sound way to clear it. Fail closed.
 */
function findUnboundableRecursion(
  plan: ExplainPlanNode,
  options: { boundedByRowCap: boolean }
): boolean {
  const sites = collectRecursiveUnions(plan, options.boundedByRowCap);
  const unbounded = sites.filter((site) => site.unboundedTerm);
  if (unbounded.length === 0) {
    return false;
  }
  if (!options.boundedByRowCap || sites.length > 1) {
    return true;
  }
  return !unbounded[0]?.reachedByRowCap;
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
   * difference between the callers is `boundedByRowCap`, and it is now a named
   * argument rather than an accident.
   */
  private async admit(
    tx: AgentSqlTransaction,
    statement: string,
    options: { boundedByRowCap: boolean }
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

      // boundedByRowCap: the LIMIT wrapper above can stop a recursion, but only
      // when every plan node between them forwards its demand AND emits rows.
      const estimatedCost = await this.admit(tx, wrapped, { boundedByRowCap: true });

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
        // boundedByRowCap: FALSE — and this is the whole reason the flag
        // exists. There is no LIMIT wrapper on this path (EXPLAIN is invalid
        // inside a FROM subquery), so ANALYZE runs the statement to completion
        // and the parent shape is irrelevant: any unbounded recursive term
        // hangs the single connection. Measured before this guard existed:
        // `EXPLAIN ANALYZE … SELECT n FROM r` was still running after 10s.
        await this.admit(tx, statement, { boundedByRowCap: false });
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
