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

The `EXPLAIN` cost gate (layer 4) exists BECAUSE this timeout does not work. It
is the only working admission control. Do not weaken it on the assumption that a
timeout will catch the overrun.

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
