# Agent Self-Query: the `brainstrike.querySelf` SQL sandbox

> Read before changing the agent SQL sandbox, the read-only role, migration 074,
> `AgentSqlService`, or a lens. Rules here are true now; the measured record is in
> `agent-self-query/<topic>.md`. Measure, do not reason, before changing a number.

## ⚠️ `statement_timeout` IS INERT IN PGLITE

- Leave the sandbox without a statement timeout and never treat one as a bound.
  PGlite accepts it and reports it through `SHOW`; the WASM build never fires it.
- Treat an unbounded statement as a whole-app freeze, not a slow tool call: PGlite is
  a SINGLE connection shared with live queries, the job queue and the UI.
- Keep the `EXPLAIN` cost gate at full strength — it exists because the timeout does
  not work — and read it as bounding *planned* work only.

Settled: the absent timeout is deliberate; restoring one as a guarantee is a
regression. Evidence: `agent-self-query/pglite-statement-timeout.md`.
Guard: `packages/db/__tests__/agent-sql-service.test.ts`.

## The sandbox: four independent, engine-enforced layers

Read-only transaction, non-superuser role `brainstrike_agent_readonly`, extended
protocol (single statement), `EXPLAIN` cost gate — each with its rejection in
`packages/db/src/search/agent-sql-service.ts`; role in
`packages/db/src/migrations/074-agent-readonly-role.ts`.

- Keep all four: each blocks something the others do not, so removing one is a
  privilege escalation, not a simplification.
- Keep the role layer despite the read-only transaction. `pg_read_file` writes nothing,
  so only a non-superuser role denies it; without it a tool classified `read` reads
  arbitrary files, bypassing workspace containment and the permission engine.
- Treat the `SELECT * FROM (<sql>) AS _bs_agent_q LIMIT <n+1>` wrapper as the OUTERMOST
  constraint, not a layer, and keep the tests that drive the transaction preamble
  directly: they stop a wrapper change becoming a silent escalation.
- Only hand this service a client with session affinity; `AgentSqlDatabase` requires
  `transaction` so the preamble and the statement share one session.

Settled: four layers, none redundant; no credential table exists to leak. Evidence:
`agent-self-query/sandbox-layers.md`.
Guard: `packages/db/__tests__/agent-sql-service.test.ts`,
`apps/desktop/src/__tests__/assistant-server/query-self-remote-db-contract.test.ts`.

### The cost gate is a PLANNER-cost gate — and what that does NOT cover

- Close cheap-to-plan, unbounded-to-execute statements at the PRIVILEGE layer.
  Migration 074's `REVOKE EXECUTE … FROM PUBLIC` on `pg_sleep`, `pg_sleep_for`,
  `pg_sleep_until` and `set_config(text, text, boolean)` is load-bearing: both classes
  pass layers 1–3 and plan at ~0.01.
- Derive every recursion decision from the PLAN TREE, never from SQL text.
- Keep `PASS_THROUGH_PLAN_NODE_TYPES` an ALLOWLIST; an unrecognised node type fails
  CLOSED. The denylist it replaced was fail-open and two of its entries were not real
  PostgreSQL values.
- Admit a `Recursive Union` with an unbounded recursive term only when all three hold:
  the row cap exists at all (`query()`, not `explain(analyze)`); every node between the
  plan root and it is pass-through AND carries no row-suppressing qual; it is the ONLY
  `Recursive Union` in the plan.
- Collect every `Recursive Union` and descend THROUGH them: sibling CTEs plan under one
  `CTE Scan` and the tree never records which parent drains which.
- Do not ban recursion — it is the symbol-graph traversal's shape.

Settled: allowlist over denylist; coexisting unbounded recursion refused
unconditionally. Evidence: `agent-self-query/cost-gate-escapes.md`.
Guard: `packages/db/__tests__/agent-sql-service.test.ts`,
`packages/db/__tests__/migration-074-agent-readonly-role.test.ts`.

### What counts as a bound

- `RECURSION_BOUND_KEYS` covers join and index conditions, not just `Filter`: the
  canonical traversal terminates on a JOIN condition above a work table with no
  `Filter` at all.
- Reject a pass-through node type carrying any of those keys — the same keys SUPPRESS
  rows above a `Recursive Union` and BOUND the recursion below one.
- Present the check as a heuristic layered on the row cap, never as a termination proof.

Settled: the eight bound keys, verified for `UNION ALL` and `UNION`. Evidence:
`agent-self-query/recursion-bound-keys.md`.
Guard: `packages/db/__tests__/agent-sql-service.test.ts`.

### ⚠️ `analyze` uses a DIFFERENT predicate, and this is load-bearing

- Pass `boundedByRowCap: true` from `query()` and `false` from `explain(analyze)`:
  `EXPLAIN` is invalid inside a FROM subquery, so that path has no `LIMIT n+1` wrapper,
  runs to completion, and ANY unbounded recursive term is unstoppable there.
- Route both paths through the one `AgentSqlService.admit()`, so a new guard cannot
  apply to one and not the other.
- `analyze` has the cost ceiling but no row bound; `query()` has both.

Evidence: `agent-self-query/analyze-predicate.md`.
Guard: `packages/db/__tests__/agent-sql-service.test.ts`.

### Verified NOT a concern

- Provider API keys live in Electron `safeStorage` (`apps/desktop/src/secrets.ts`);
  there is no credential table. Re-check if anyone proposes storing one in PGlite.
  Evidence: `agent-self-query/sandbox-layers.md`.

## The cost ceiling

- `DEFAULT_AGENT_SQL_COST_CEILING = 50_000`, in PostgreSQL planner cost units.
- RE-RUN THE MEASUREMENT before moving it. Never raise it to make one failing query
  pass: the rejection already tells the model to add a `WHERE`, `LIMIT`, or aggregate.
- Guard both directions — a cartesian plan refused AND an ordinary aggregate over 50k
  rows admitted. Blocking legitimate analysis is as much a bug as admitting a runaway.
- `EXPLAIN` runs under the restricted role, so it is a second privilege gate:
  `EXPLAIN INSERT …` fails with `permission denied` before execution.

Settled: 50,000, six orders of magnitude clear of both classes. Evidence:
`agent-self-query/cost-ceiling-measurements.md`.
Guard: `packages/db/__tests__/agent-sql-service.test.ts`.

## Role grant coverage (invariant)

- Migration 074 grants `SELECT` on existing public tables AND sets
  `ALTER DEFAULT PRIVILEGES`, covering later migrations' tables automatically.
- Treat its test as a tripwire: a migration landing an unreadable table fails there
  instead of the agent hitting `permission denied` on one table in production.
- Assert privileges through `pg_class.oid`, never a formatted table name — the planner
  may evaluate `has_table_privilege()` before the schema filter.

Evidence: `agent-self-query/role-grant-coverage.md`.
Guard: `packages/db/__tests__/migration-074-agent-readonly-role.test.ts`.

## Error posture (deliberately unlike the sibling tools)

- Pass PostgreSQL's own messages through as `ToolInputError` — syntax errors,
  `permission denied for …`, `AgentSqlCostRejectedError` with its estimate and ceiling.
  The error IS the product: it describes the statement the MODEL authored.
- Redact only genuinely internal failures.

Guard: `apps/desktop/src/__tests__/assistant-server/query-self-tool.test.ts`.

## ⚠️ The input schema must survive strict function calling

Extending `QuerySelfInputSchema`
(`packages/assistant-contract/src/native-tools/schemas/schemas-diagnostics.ts`):

- Keep `mode` a REQUIRED enum discriminator; fields the chosen mode does not use are
  ignored by contract. Strict function calling forces the model to emit EVERY property.
- Prefer a required enum over optional-field combinations.
- No nested unions — they do not survive provider schema conversion
  (`docs/agents/local-inference.md` records the same class for Gemma).
- No cross-field `.refine()`: it is invisible in the emitted JSON Schema, so the model
  only learns it by failing.

Settled: an optional-field pair made exclusive by `.refine()` failed 100% of real calls.
Evidence: `agent-self-query/strict-function-calling-schema.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/query-self-tool.test.ts`.

### The second half of the same failure

- Keep schema parsing INSIDE the executor's `try`
  (`apps/desktop/src/assistant-server/native-tool-executors-execution.ts`) with
  `toQuerySelfInputError` in the `catch`, turning Zod issues into model-correctable
  text. A generic tool failure is a dead end for a tool whose value is that the model
  authors the input: it retries the identical call and abandons the task.

Evidence: `agent-self-query/strict-function-calling-schema.md`.

## Decisions recorded (do not silently reverse)

- `querySelf` stays out of `DEFAULT_USER_PERSONA_TOOL_IDS` and every built-in persona;
  authors opt in via `tools:`. A child composing arbitrary SQL is a wider surface than
  the curated set, and children cannot prompt for approval.
- `riskCategory: 'read'` is pinned explicitly on the `defineNativeTool` declaration
  (`packages/assistant-contract/src/native-tools/definitions/query-self.ts`) with the
  sandbox named as its justification — never derived.
- Desktop-only: excluded from `WEB_NATIVE_TOOL_IDS`.
- Oversized results truncate with a hint rather than durable artifact settlement; a SQL
  result is trivially re-narrowable.
- `analyze: true` outside `mode: 'explain'` throws a visible `AgentSqlInputError`
  (`query-self-tool.ts`) rather than being ignored or enforced as a refinement.

Guard: `packages/assistant-contract/src/__tests__/user-personas.test.ts`,
`packages/assistant-contract/src/__tests__/native-tools.test.ts`,
`apps/desktop/src/__tests__/assistant-server/query-self-tool.test.ts`.

## Schema discoverability

- Keep `listTables` and `describeTable` on the same sandbox and derived from the live
  database: one tool, one permission surface, no duplicated description to drift. Render
  a `-1` `reltuples` estimate as `?`, never as a fabricated `0`.
- Keep the description's worked examples in `QUERY_SELF_EXAMPLE_QUERIES` and executable,
  so a renaming migration fails a test instead of teaching a dead column.

Guard: `packages/db/__tests__/agent-sql-service.test.ts`.

## The symbol graph (migration 075, BST-919)

- Extract `file_symbols` and `file_symbol_refs` at chunking time from the SAME parse
  that produces chunks — no separate walker; sync and edit-reindex converge there.
- **Refs store names, not resolved symbol ids**; cross-file edges resolve at QUERY time
  by joining `refs.name = symbols.name`. Symbol rows share the chunk lifecycle, so a
  stored id would dangle after every re-index, and over-connection is the correct
  failure direction for a retrieval index.
- Key rows by composite `(file_record_id, seq)`; `from_symbol_seq` is always intra-file.
- A managed-cache REPLACE deletes a file's symbol rows explicitly (the `file_records`
  row survives an edit, so FK CASCADE cannot); deletion cascades; re-extraction rides
  `chunks_processed_at = NULL`. Persistence failure degrades LOUDLY to
  chunks-without-symbols and never fails the file import.

Settled: name-based refs and composite keys, both measured. Evidence:
`agent-self-query/symbol-graph-design.md`, `agent-self-query/symbol-rollback-review.md`.
Guard: `packages/db/__tests__/search-hybrid-symbol-retrieval.test.ts`, `packages/db/__tests__/migration-075-rollback.integration.test.ts`.

### The hybrid one-statement query (BST-935) — PROVEN admitted

- The traversal-plus-BM25-plus-vector statement runs through the sandbox as-is and
  ships as the `callers-hybrid` lens, the readable copy of its shape.
- Its top level drains (`GROUP BY … ORDER BY`), so the row cap plays NO part: admission
  rests on the recursion-bound heuristic plus the cost gate. Do not cite the row cap.
- Scope the vector arm to the seed's `embedding_set_id` (`IS NOT DISTINCT FROM`):
  `file_chunks.embedding` is deliberately dimensionless, and a cross-set comparison
  aborts the statement with `different vector dimensions`.
- Give each arm a match predicate and its own `LIMIT` (canonically 50), so arm work
  scales with top-N and zero-relevance chunks earn no RRF mass.
- Keep the two operator idioms in the tool description; they appear in no column
  listing, so `describe` cannot teach them.

Evidence: `agent-self-query/hybrid-one-statement-admission.md`.
Guard: `packages/db/__tests__/search-hybrid-symbol-retrieval.test.ts`.

## Lenses (BST-921): retrieval strategy as a reviewable artifact

A lens is a named, parameterized `.sql` file under `.brainstrike/lenses/` (per mounted
root, then `~/.brainstrike/lenses/` — the persona two-tier, flat-scan, first-id-wins
convention). Grammar: `packages/assistant-contract/src/lenses.ts`; loader:
`apps/desktop/src/assistant-server/lens-loader.ts`. Invocation rides `querySelf`:
`mode: 'listLenses'`, then `mode: 'lens'` with `lens` and `values`.

- **Same sandbox, no elevation.** A lens runs the identical preamble and admission as
  `mode: 'query'`; a lens file is untrusted repo content, like a persona file.
- **Values only ever travel as bind parameters**, into BOTH the admission `EXPLAIN` and
  execution; planning with real values keeps the cost estimate honest. Never interpolate
  one into lens SQL.
- **List invalid files WITH their parse errors** — fail closed, never silent.
- **Placeholder discipline is a PARSE-time error**: the highest `$n` equals the declared
  param count and every `$1..$n` appears.
- **Every lens ships with a golden test** reading the checked-in file, so the artifact
  is the single source of truth. `.brainstrike/lenses/` is the inventory.
- **Normalize `tool_id` before grouping** in telemetry lenses
  (`brainstrike.grepSearch` → `grepSearch`): the writer stores the id verbatim, so one
  tool lands under both spellings and a split halves its score.
- The opt-in
  [self-improvement signal injection](workspace-context.md#self-improvement-signal-injection-bst-1241)
  executes an app-owned copy of `self-improvement-signal`, pinned to the shipped lens
  body by a parity test; it never executes a workspace-scanned lens.

Evidence: `agent-self-query/lens-inventory.md`.
Guard: `packages/db/__tests__/search-lens-*.test.ts`,
`packages/assistant-contract/src/__tests__/lenses.test.ts`,
`apps/desktop/src/__tests__/assistant-server/lens-loader.test.ts`,
`apps/desktop/src/__tests__/assistant-server/query-self-lens-modes.test.ts`,
`apps/desktop/src/__tests__/assistant-server/self-improvement-signal-context.test.ts`.

## Using it for database tuning

- Keep the catalog and statistics views reachable (`pg_stat_user_*`, `pg_indexes`,
  `pg_class`, `pg_stats`, `pg_settings`, `pg_constraint`, `information_schema`). The
  sandbox is deliberately not restricted to application tables; that is what makes
  real tuning work possible.

### ⚠️ Statistics counters read ZERO until they are flushed

- **Always run `SELECT pg_stat_force_next_flush()` before reading any `pg_stat_*`
  view.** It is allowed under the restricted role inside the read-only transaction.
- PGlite's single-connection WASM environment never flushes per-backend stats within a
  session, so `track_counts` is `on`, the data is real, and an unflushed read returns
  all zeros — a confidently wrong "no index is ever used" rather than an error.

Evidence: `agent-self-query/stats-counter-flush.md`.

### Query plans: `mode: 'explain'`

- Keep plain `explain` free of the cost ceiling and the recursion guard: it only plans,
  and explaining an expensive query is when its plan is most valuable.
- `analyze: true` executes, so it passes the SAME ceiling and guard; the read-only
  transaction still blocks writes, so it cannot smuggle a mutation. Return
  PostgreSQL's own indented plan text.

Guard: `packages/db/__tests__/agent-sql-service.test.ts`.

### Not available

- `pg_stat_statements` is not in the PGlite extension set, so there is no per-query
  workload profile to rank by total time.

## Projection fitting

- Projections apply the 6,000-character domain budget. `maxRows` caps rows (default 50,
  hard max 200), but columns, lenses and plan lines come from the database or the user's
  lens directory and are not item-capped.
- Keep the largest complete prefix by BINARY-SEARCHING the retained-item count, and keep
  the explicit-omission contract. Dropping one item and re-serializing the candidate
  each iteration is quadratic, and unbounded for plan and lens output.

Evidence: `agent-self-query/projection-fitting-cost.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/query-self-model-projection-performance.test.ts`.

## Paired tests

Every `Guard:` line above names the test that owns that rule; update the owning test in
the same change. The remaining coverage lives in
`apps/desktop/src/__tests__/assistant-server/query-self-tool.integration.test.ts` and
`query-self-model-projection.test.ts`.
