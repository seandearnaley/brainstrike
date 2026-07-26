# Plan: Agent self-query (`brainstrike.querySelf`) — BST-913

> Branch: `seandearnaley/bst-913-agent-self-query`
> Linear: BST-913 (parent) → BST-914, BST-915, BST-916, BST-917, BST-918
> Follow-ups filed, not in this PR: BST-919 (symbol graph), BST-920 (regret index), BST-921 (lens system)

## Why

Every other coding agent treats its own work as ephemeral text — JSONL logs, or a cloud DB the
user cannot reach. Brainstrike is the only one where the agent's work is **data**:
`brainstrike_assistant_run_outcomes`, `brainstrike_assistant_edit_checkpoints`,
`brainstrike_assistant_run_usage`, `brainstrike_diagnostic_events`, `job_queue_metrics`, and
`file_chunks` (embedding + generated tsvector + chunk_type) all live in the **same PostgreSQL 18
database**, on disk, joinable in one statement.

We have not given the agent the one tool that unlocks them: SQL.

Today "which files have chunks but no embeddings?" costs dozens of tool calls. With this it is one
statement, on-device, at zero token cost for the traversal itself.

## Scope of THIS PR

`brainstrike.querySelf` — a single read-only SQL statement against the local PGlite database inside
a hard sandbox, plus a `describe` mode so the model can see the schema it is querying.

**Explicitly not in this PR:** the symbol graph (BST-919). It is a separate indexing-pipeline
feature that gets *queried through* this tool. Shipping both together would be unreviewable and
breaks the one-logical-change branch rule.

---

## Verified substrate

Everything below was measured against real PGlite on 2026-07-26, not assumed.
`PostgreSQL 18.3 (PGlite 0.5.3) on wasm32-unknown-linux-gnu`.

### The sandbox: four independent, engine-enforced layers

| Threat | Layer | Measured result |
| --- | --- | --- |
| `INSERT` / `UPDATE` / `DELETE` | `BEGIN READ ONLY` | `cannot execute INSERT in a read-only transaction` |
| DDL (`CREATE`/`DROP`/`ALTER`) | `BEGIN READ ONLY` | `cannot execute CREATE TABLE in a read-only transaction` |
| Arbitrary file read (`pg_read_file`, `pg_ls_dir`) | non-superuser role | `permission denied for function pg_read_file` |
| Shell execution (`COPY … TO PROGRAM`) | non-superuser role | `permission denied to COPY to or from an external program` |
| Credential/hash exfiltration (`pg_authid`) | non-superuser role | `permission denied for table pg_authid` |
| Multi-statement injection | PGlite extended protocol (`.query()`) | `cannot insert multiple commands into a prepared statement` |
| Runaway plan | `EXPLAIN` cost gate | see below |
| Oversized result | subquery wrap + `LIMIT n+1` | works, including around `WITH` |

Each layer is load-bearing **on its own**. Read-only transactions do not stop `pg_read_file`; the
role does not stop a cartesian product; neither stops multi-statement text. Removing any one is a
real privilege escalation, not a cleanup.

`CREATE ROLE` and `SET LOCAL ROLE` both work in PGlite. `current_user` becomes the restricted role
inside the transaction and reverts on `ROLLBACK`.

**Secrets are not in the database.** API keys live in Electron `safeStorage`
(`apps/desktop/src/secrets.ts`). Checked, not assumed — there is no credential table to leak.

### ⚠️ `statement_timeout` is INERT in PGlite

The most important finding, and the one most likely to be "helpfully" undone later.

PGlite **accepts and reports** `statement_timeout` and **never enforces it**:

```
SET statement_timeout = '100ms'  →  SHOW statement_timeout  →  100ms
SELECT pg_sleep(1)                                          →  completes, 1001ms, no error
SELECT count(*) FROM generate_series(1,6000) a,
                     generate_series(1,6000) b              →  completes, 2502ms, no error
```

The WASM build has no timer interrupt to fire it. This matters more than it looks: PGlite is a
**single connection**, so a runaway agent query pins the entire database — blocking live queries,
the job queue, and the UI. An unbounded query is a whole-app freeze, not a slow tool call.

Per NO SILENT FALLBACKS we must not present a timeout we do not have.

### Mitigation: `EXPLAIN` cost admission control

Plan first (planning only — cheap), read `Plan."Total Cost"` from `EXPLAIN (FORMAT JSON)`, refuse
above a ceiling with an explicit, model-actionable error. Cost separates trivial from catastrophic
by six orders of magnitude:

| Statement | Total Cost |
| --- | --- |
| `SELECT * FROM t LIMIT 10` | 0.15 |
| wrapped CTE over 5k rows | 89.5 |
| `t a, t b` self cross join | 375,166 |
| `generate_series(1,6000) a, b` | 810,060 |

`EXPLAIN` also runs under the restricted role, so it is a **second privilege gate** —
`EXPLAIN INSERT …` already fails with `permission denied for table t` before execution is reached.

---

## Implementation sequence (bottom-up, red/green)

Each step is written failing first, then made to pass. Steps land in this order because each one
is meaningless without the one below it.

### 1. BST-914 — `packages/db`: role + guarded executor

**Migration 074 `agent_readonly_role`**, registered in BOTH runners
(`packages/db/src/migrations/index.ts` AND the `customMigrations` ledger in
`packages/db/src/drizzle/migrate.ts` — registering one only means tests pass while real users never
get it).

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brainstrike_agent_readonly') THEN
    CREATE ROLE brainstrike_agent_readonly NOLOGIN;
  END IF;
END $$;
GRANT USAGE  ON SCHEMA public TO brainstrike_agent_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO brainstrike_agent_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO brainstrike_agent_readonly;
```

`CREATE ROLE` has no `IF NOT EXISTS`; the `DO` block is the idempotency guard the dual-runner
design requires.

**`AgentSqlService`** (`packages/db/src/search/`, sibling to `GrepSearchService`):

1. single statement only — rely on the extended protocol, do **not** hand-roll a SQL splitter
2. `BEGIN READ ONLY`
3. `SET LOCAL ROLE brainstrike_agent_readonly`
4. `EXPLAIN (FORMAT JSON) <wrapped>` → typed `AgentSqlCostRejectedError` above ceiling, carrying
   estimated cost + ceiling so the message is actionable
5. execute `SELECT * FROM (<sql>) AS _bs_q LIMIT <maxRows + 1>` — the `+1` detects truncation
   without a second query
6. `ROLLBACK` in `finally`, on every path

Tests (integration, real PGlite) — one per row of the threat table above, plus:

- role does not leak: `current_user` is `postgres` again after the call
- transaction rolled back after a *failing* query (no wedged open transaction)
- **schema coverage tripwire:** every table in `information_schema.tables` for `public` is
  SELECT-able by the role. `ALTER DEFAULT PRIVILEGES` should cover future migrations — this test
  proves it rather than assuming, and fails loudly the day it stops being true.

Register new test files in `dbUnitLaneDefinitions`
(`packages/db/scripts/db-test-lane-manifest.mjs`).

### 2. BST-915 — contract registration

`native-tool-catalog.ts`, `tool-categories.ts` (`analysis` / `deferred` / no approval /
**`riskCategory: 'read'` pinned explicitly** with a comment pointing at the sandbox that justifies
it), `tool-descriptions.ts`, `tool-schemas-display.ts`, and `QuerySelfInputSchema` in
`packages/agent/src/tools/schemas.ts` + `NATIVE_TOOL_INPUT_SCHEMAS`.

**Deliberate decision:** `querySelf` is NOT added to `DEFAULT_USER_PERSONA_TOOL_IDS` or the
built-in `explore`/`analyze` persona tool lists in v1. `assertReadOnlyPersona` would accept it
(risk `read`), but a child persona composing arbitrary SQL is a wider blast radius than the curated
exploration set, and personas cannot prompt for approval. Recorded as a code comment and pinned by
a test so it is not silently "fixed".

### 3. BST-916 — desktop wiring + model projection

`apps/desktop/src/assistant-server/query-self-tool.ts` following the `hybrid-search-tool.ts` shape.

**Error surface is the product here.** A wrong query must teach the model to write a right one, so
these are *not* collapsed into a generic failure: PostgreSQL syntax errors (they name position and
token), `permission denied for …`, and `AgentSqlCostRejectedError`. Same class as the multi-root
resolution errors that deliberately bypass the sanitiser. Genuinely unexpected internal errors
still redact.

Projection self-fits `MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS` (1500 tokens / 6000 chars). Rows are
arbitrary shape, so: **columns once, rows as arrays** (not repeated per-row key objects), per-cell
render cap so a bytea/JSONB blob cannot blow the envelope, and an explicit truncation hint from the
`maxRows + 1` sentinel — never a silently short result.

Oversized results **truncate with a hint** rather than routing through durable artifact settlement.
Rationale: a SQL result is trivially re-narrowable by the model, unlike a fetched web page that
cannot be re-fetched identically.

### 4. BST-917 — `describe` mode

The difference between a tool that works and one that gets used. A model handed "you may run SQL"
against an unknown ~30-table schema will hallucinate columns and burn turns on
`column "x" does not exist`.

`{ describe: true }` → tables + `pg_class.reltuples` estimates grouped by domain prefix.
`{ describe: '<table>' }` → columns, types, nullability, keys. Mutually exclusive with `sql` —
supplying both is a validation error, not a silent precedence rule.

It rides the *same sandbox*, because it is just a SELECT. One tool, one permission surface, never
stale — the schema is derived from the database rather than duplicated into a description that
drifts.

The tool description teaches the two-step (describe → query) and carries 2–3 worked examples.
**Every example is executed against a migrated database by a test** — a broken example in a tool
description is worse than none.

### 5. BST-918 — contract doc

`docs/agents/agent-self-query.md` + the AGENTS.md load-on-demand table row. The doc's single most
important line is the inert-`statement_timeout` finding with its measured evidence, so that the
next person who notices the timeout "isn't set" does not reintroduce a false guarantee.

---

## Definition of done

- clean lint, type-check, build, and unit tests **in the same run**
- manual verification in the desktop app via CDT (`dev:agent-debug`): the assistant calls
  `querySelf`, `describe` returns the real schema, and a real join against run outcomes returns
  real rows
- PR green, bot review comments addressed and replied to, threads resolved
- residual work filed in Linear rather than left in the branch
