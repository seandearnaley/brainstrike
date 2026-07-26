# Agent Self-Query: the `brainstrike.querySelf` SQL sandbox

> Added 2026-07-26 (BST-913). Read before touching the agent SQL sandbox, the
> read-only role, migration 074, or `AgentSqlService`. Keep updated with the code.

Brainstrike's local database holds the agent's own work — run outcomes, edit
checkpoints, token usage and cost, queue metrics, diagnostic events — in the
SAME PostgreSQL as the workspace code index. `brainstrike.querySelf` gives the
model read-only SQL over it, so questions that would otherwise cost dozens of
tool calls become one statement.

Handing a model arbitrary SQL is only safe because of the sandbox below. Every
claim here was MEASURED against real PGlite, not reasoned about.

---

## ⚠️ `statement_timeout` IS INERT IN PGLITE

**The single most important fact in this document.** If you are here because you
noticed the sandbox does not set a statement timeout: that is deliberate, and
adding one back as a guarantee would be a regression.

PGlite accepts the setting, reports it through `SHOW`, and never enforces it.
Measured on PGlite 0.5.3 / PostgreSQL 18.3:

```
SET statement_timeout = '100ms';
SHOW statement_timeout;                              -- 100ms
SELECT pg_sleep(1);                                  -- completes, 1001ms, no error
SELECT count(*) FROM generate_series(1,6000) a,
                     generate_series(1,6000) b;      -- completes, 2502ms, no error
```

The WASM build has no timer interrupt to fire it.

**Why this matters more than it looks:** PGlite is a SINGLE connection. A
runaway query does not merely make one tool call slow — it pins the database and
therefore blocks live queries, the job queue, and the UI. An unbounded statement
is a whole-app freeze.

The `EXPLAIN` cost gate (layer 4) exists BECAUSE this timeout does not work. Do
not weaken it on the assumption that a timeout will catch the overrun — and do
not read it as complete coverage either: it bounds *planned* work only. See "The
cost gate is a PLANNER-cost gate" below for what it cannot catch and what is
closed at the privilege layer instead.

---

## The sandbox: four independent, engine-enforced layers

Implementation: `packages/db/src/search/agent-sql-service.ts`.
Role: migration 074 (`packages/db/src/migrations/074-agent-readonly-role.ts`).

Each layer blocks something the others do not. **None is redundant**, and
removing any one is a privilege escalation rather than a simplification.

| # | Layer | Blocks | Measured rejection |
| --- | --- | --- | --- |
| 1 | `SET TRANSACTION READ ONLY` | writes, DDL | `cannot execute INSERT in a read-only transaction` |
| 2 | `SET LOCAL ROLE brainstrike_agent_readonly` | `pg_read_file`, `pg_ls_dir`, `COPY … TO PROGRAM`, `pg_authid` | `permission denied for function pg_read_file` |
| 3 | extended protocol (`query`, not `exec`) | multi-statement text | `cannot insert multiple commands into a prepared statement` |
| 4 | `EXPLAIN (FORMAT JSON)` cost gate | runaway plans | typed `AgentSqlCostRejectedError` |

Layer 2 is the one most likely to be misunderstood. A read-only transaction does
**not** stop `pg_read_file` — that function reads the filesystem without writing
anything. Those functions are superuser-gated by default in PostgreSQL, so
running as a plain role is what denies them. Without layer 2 the agent could
read arbitrary files, bypassing workspace-root containment AND the permission
engine, through a tool classified `read`.

There is also a fifth, structural constraint that falls out of the row cap: the
statement is wrapped as `SELECT * FROM (<sql>) AS _bs_agent_q LIMIT <n+1>`, so
anything not valid as a FROM subquery fails to parse before layers 1–2 are
reached. This is real, but it is the OUTERMOST layer and the easiest to change
by accident. `agent-sql-service.test.ts` therefore proves layers 1 and 2
independently, by driving the transaction preamble directly — those tests are
what stop a future change to the wrapper from silently becoming an escalation.

### The cost gate is a PLANNER-cost gate — and what that does NOT cover

This is the most important limitation of layer 4, and it is easy to misread the
table above as "runaway execution is handled". It is not, on its own.

`EXPLAIN` costs a statement's *plan*. A statement that is cheap to plan and
unbounded to *execute* passes every layer. Two such escapes were found in review
and are closed at the PRIVILEGE layer, which is the only engine-enforced place
they can be closed (migration 074):

| Escape | Measured plan cost | Why layers 1-3 admit it | Closed by |
| --- | --- | --- | --- |
| `SELECT pg_sleep(86400)` | 0.01 | not a write, not superuser-gated, one statement | `REVOKE EXECUTE ON FUNCTION pg_sleep/​pg_sleep_for/​pg_sleep_until FROM PUBLIC` |
| `SELECT set_config('role', …, false)` | 0.01 | not a write — and `is_local => false` makes it a SESSION set that OUTLIVES the transaction | `REVOKE EXECUTE ON FUNCTION set_config(text, text, boolean) FROM PUBLIC` |

The `set_config` one was the more dangerous of the two: measured, it left the
shared PGlite connection stuck as the restricted role after the sandbox
returned, so the application's own writes failed with `permission denied`
permanently — from a tool marked `requiresApproval: false`, `riskCategory: 'read'`.

**RESIDUAL RISK — not currently blocked.** A recursive CTE with no termination
condition plans at trivial cost (measured: 3.35) and runs until memory is
exhausted:

```sql
WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t) SELECT count(*) FROM t
```

The planner uses a fixed row-estimate multiplier for the recursive term, so cost
stays low, and the `LIMIT` wrapper cannot help because `count(*)` must drain the
CTE. There is no clean engine-enforced block for this: recursive CTEs are a
language construct, not a revocable function. Anyone extending this sandbox
should know that the cost gate is a bound on *planned* work only, and that a
genuinely terminable execution boundary is what would close this class properly.
Tracked as a follow-up rather than silently omitted.

### Verified NOT a concern

Secrets are not in the database. Provider API keys live in Electron
`safeStorage` (`apps/desktop/src/secrets.ts`); there is no credential table to
leak. This was checked rather than assumed, and it is worth re-checking if
anyone proposes storing a credential in PGlite.

---

## The cost ceiling

`DEFAULT_AGENT_SQL_COST_CEILING = 50_000`, in PostgreSQL planner cost units.

Derived from measurement:

| Statement | Total Cost |
| --- | --- |
| `SELECT * FROM t LIMIT 10` | 0.15 |
| wrapped CTE over 5k rows | 89.5 |
| 5k-row self cross join | 375,166 |
| `generate_series(1,6000)` squared | 810,060 |

The ceiling sits above ordinary full scans and joins over realistic local
corpora and far below cartesian explosions — six orders of magnitude separate
the two classes, so the exact value is not delicate.

**If this ever needs to move, re-run the measurement.** Do not guess a new
number, and do not raise it to make one failing query pass; the failure message
already tells the model to add a `WHERE`, a `LIMIT`, or an aggregate.

`agent-sql-service.test.ts` guards BOTH directions: a cartesian plan must be
refused, and an ordinary aggregate over 50k rows must be admitted. A ceiling
that blocks legitimate analysis is as much a bug as one that admits a runaway.

`EXPLAIN` is also a second privilege gate — it runs under the restricted role,
so `EXPLAIN INSERT …` fails with `permission denied` before execution.

---

## Role grant coverage (invariant)

Migration 074 grants `SELECT` on all existing public tables AND sets
`ALTER DEFAULT PRIVILEGES` so tables created by later migrations are covered
automatically (all migrations run as `postgres`).

`migration-074-agent-readonly-role.test.ts` proves both, including a
future-table case. **That test is a tripwire**: if a later migration ever lands a
table the role cannot read, it fails loudly instead of the agent silently
getting `permission denied` on one table in production.

Privilege assertions in those tests go through `pg_class.oid`, not a formatted
table name — the planner may evaluate `has_table_privilege()` before the schema
filter, and a name-based check then tries to resolve catalog tables in `public`.

---

## Error posture (deliberately unlike the sibling tools)

`hybridSearch` collapses unknown errors into a generic message because a failed
search tells the model nothing actionable. **`querySelf` is the opposite: the
error IS the product.**

PostgreSQL messages describe the statement the MODEL authored, so they pass
through as `ToolInputError` rather than being redacted:

- syntax errors — they name the offending token and position
- `permission denied for …` — the model learns the boundary instead of retrying
- `AgentSqlCostRejectedError` — carries the estimate and the ceiling

Only genuinely internal failures redact to a generic message. Collapsing the
first three would leave the model unable to self-correct, and the tool unusable.

---

## ⚠️ The input schema must survive strict function calling

**Learned from a live run, after the unit tests were all green.** The first
design had optional `sql` and `describe` fields made mutually exclusive by a Zod
`.refine()`. It failed **100% of real calls**.

Providers using strict function calling (OpenAI) force the model to emit EVERY
declared property. The actual arguments observed were:

```json
{"sql": ". ", "maxRows": 200, "describe": true}
```

Both fields populated, `sql` filled with a junk placeholder, and the refinement
rejected it every time.

The fix is **not** a silent precedence rule ("describe wins") — that guesses at
intent. It is a REQUIRED `mode` discriminator, so the model states what it wants
and fields the mode does not use are ignored by contract:

```
mode: 'listTables' | 'describeTable' | 'query'
```

Rules for anyone extending this schema:

- **No nested unions.** `z.union([z.literal(true), z.string()])` does not survive
  provider schema conversion. (`docs/agents/local-inference.md` records the same
  class of problem for the Gemma template.)
- **No cross-field `.refine()`.** The constraint is invisible in the emitted JSON
  Schema, so the model cannot satisfy it and only learns by failing.
- **Prefer a required enum over optional-field combinations.**

### The second half of the same failure

The `ZodError` was thrown by `parseToolExecuteInput`, which ran BEFORE
`runQuerySelf`'s catch — so the model received only the generic
`"The tool did not complete successfully. Try another approach."` It retried the
identical malformed call and abandoned the task.

For a tool whose entire value is that the model authors the input, an opaque
validation failure is a dead end. `toQuerySelfInputError` now converts the Zod
issues into model-correctable text, and schema parsing sits INSIDE the try block
in `assistant-tools.ts`. If you touch that registration, keep it there.

**Verified working end to end** (2026-07-26, GPT-5.6 Terra, live desktop app):
`mode: 'listTables'` returned 42 tables and `mode: 'query'` returned provider
model counts matching the database exactly. The run also incidentally proved the
error posture: the model's SQL carried a trailing period, PostgreSQL's syntax
error reached it verbatim, and it corrected itself and re-ran — which is the
entire reason those errors are not sanitised.

## Decisions recorded (do not silently reverse)

- **`querySelf` is excluded from `DEFAULT_USER_PERSONA_TOOL_IDS` and every
  built-in persona.** `assertReadOnlyPersona` would accept it — its risk
  category is a legitimately earned `read` — but a delegated child composing
  arbitrary SQL is a wider surface than the curated exploration set, and
  children cannot prompt for approval (every `'ask'` tool is stripped from a
  child's map). Persona authors must opt in explicitly via `tools:`. Pinned by
  `user-personas.test.ts`.
- **`riskCategory: 'read'` is pinned explicitly** in `tool-categories.ts` rather
  than derived. The input is arbitrary SQL; a reader must see the bucket
  asserted at the declaration site with the sandbox named as its justification.
- **Desktop-only.** Excluded from `WEB_NATIVE_TOOL_IDS` — the browser has no
  assistant server.
- **Oversized results truncate with a hint** rather than routing through durable
  artifact settlement. A SQL result is trivially re-narrowable by the model,
  unlike a fetched web page that cannot be re-fetched identically.
- **`sql` and `describe` are mutually exclusive**, enforced by a Zod refinement.
  A precedence rule would make a malformed call look like it worked.

---

## Schema discoverability

A model handed "you may run SQL" against an unknown ~30-table schema
hallucinates column names. `describe` mode is what makes the tool usable:

- `describe: true` → readable tables with `pg_class.reltuples` estimates
  (rendered `?` when `-1`, i.e. never analyzed — never a fabricated `0`)
- `describe: '<table>'` → columns, types, nullability

It rides the same sandbox because it is just a SELECT: one tool, one permission
surface, and the schema is derived from the live database rather than duplicated
into a description that drifts.

The tool description carries worked example queries. Those examples reference
real columns and are the first thing to update if a migration renames one.

---

## Using it for database tuning

The sandbox is deliberately not restricted to application tables — the role can
read the catalog and statistics views, which makes real tuning work possible.
Verified reachable under the restricted role, inside the read-only transaction:

| Question | Source |
| --- | --- |
| Which tables are seq-scanned vs index-scanned? | `pg_stat_user_tables` (`seq_scan`, `idx_scan`, `n_live_tup`, `n_dead_tup`) |
| Which indexes are never used? | `pg_stat_user_indexes` (`idx_scan = 0`) |
| What indexes exist, exactly? | `pg_indexes.indexdef` |
| How big is each table/index? | `pg_class` + `pg_relation_size(oid)`, `relpages`, `reltuples` |
| Is a column worth indexing? | `pg_stats` (`n_distinct`, `correlation`, MCVs) |
| What are the live GUCs? | `pg_settings` |
| Relations, FKs, constraint design | `pg_constraint`, `information_schema` |

### ⚠️ Statistics counters read ZERO until they are flushed

**This is a trap, and the failure mode is a confidently wrong answer rather than
an error.** PostgreSQL accumulates stats per backend and flushes them
periodically; in PGlite's single-connection WASM environment that flush does not
happen on its own within a session. Measured after a workload of 12 indexed
lookups and 2 sequential scans:

```sql
SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables;   -- t, 0, 0   ← wrong
SELECT pg_stat_force_next_flush();                             -- allowed in the sandbox
SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables;   -- t, 2, 12  ← correct
```

`track_counts` is `on`, so the data is real — it is just unflushed. An agent that
skips the flush will read all-zeros and conclude "no index is ever used", which
is exactly the kind of silent wrongness this codebase forbids. **Always call
`SELECT pg_stat_force_next_flush()` before reading any `pg_stat_*` view.** It
works under the restricted role inside the read-only transaction (it is a stats
flush, not a data write).

### Not available

- **`EXPLAIN` is not reachable by the model.** The `LIMIT` wrapper makes the
  statement a FROM-subquery, and `EXPLAIN` is not valid there — it fails with a
  syntax error. The service uses `EXPLAIN` internally for the cost gate, so the
  capability exists but is not exposed. Without it the model can see statistics
  but never a query plan, which is the single biggest gap for tuning work.
  Tracked as BST-923.
- **`pg_stat_statements` is not installed** (not in the PGlite extension set), so
  there is no per-query workload profile to rank by total time.

## Paired tests

- `packages/db/__tests__/agent-sql-service.test.ts` — all four layers, the
  independent preamble proofs, result shaping, transaction hygiene, describe mode
- `packages/db/__tests__/migration-074-agent-readonly-role.test.ts` — role
  attributes, idempotency, grant coverage tripwire
- `packages/assistant-contract/src/__tests__/user-personas.test.ts` — persona
  exclusion
- `apps/desktop/src/__tests__/assistant-server/query-self-tool.test.ts` and
  `query-self-model-projection.test.ts` — error passthrough, projection budget

When changing this flow, update this section and the paired tests.

---
