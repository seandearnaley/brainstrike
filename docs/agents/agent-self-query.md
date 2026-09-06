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

**A third escape in this class — the unbounded recursive CTE — is now closed
too, and NOT with a text denylist.** The planner names the construct, so the
guard reads the plan, keeping every admission decision engine-derived.

The distinction is measured, not assumed:

| Statement shape | Plan | Result |
| --- | --- | --- |
| `LIMIT` over a pipelined recursion | `Limit → CTE Scan → Recursive Union` | 51 rows in **869 ms** — the row cap bounds it |
| `count(*)` over the same recursion | `Limit → Aggregate → Recursive Union` | **still running after 10 s** (killed) |
| `WHERE n < 0` over the same recursion | `Limit → CTE Scan (Filter) → Recursive Union` | **still running after 10 s** (killed) |

So recursion is NOT banned — banning it would break the symbol-graph traversal
in BST-919, a headline use case. But the admission rule is an **allowlist of
pass-through parents**, not a denylist of draining ones, and that direction is
load-bearing.

A denylist is fail-open, and it failed open twice. The row cap bounds **emitted**
rows, not **produced** ones, so `Limit → CTE Scan (Filter) → Recursive Union`
pipelines perfectly, emits nothing, never satisfies `LIMIT n+1`, and runs
forever — under a parent the denylist called safe. Two of the denylist's own
entries were not even real values: PostgreSQL emits `"Node Type": "Aggregate"`
with `"Strategy": "Hashed"`, never `"HashAggregate"` or `"GroupAggregate"`.

A `Recursive Union` with an unbounded recursive term is therefore admitted ONLY
when all three hold:

1. the row cap exists at all (`query()`, not `explain(analyze)`);
2. every node between the plan root and it is in
   `PASS_THROUGH_PLAN_NODE_TYPES` (`Limit`, `CTE Scan`, `Subquery Scan`,
   `Result`) **and** carries no row-suppressing qual; and
3. it is the ONLY `Recursive Union` in the plan.

Condition 3 is not paranoia. PostgreSQL plans two CTEs as SIBLINGS under one
`CTE Scan`, and the plan tree does not record which parent drains which sibling,
so an unbounded recursion beside a bounded one cannot be soundly cleared:

```
Limit
  CTE Scan
    Recursive Union      ← a: bounded (WorkTable Scan has a Filter)
    Recursive Union      ← b: UNBOUNDED
    Aggregate            ← drains b, but nothing in the tree says so
      CTE Scan
```

A traversal that stopped at the first `Recursive Union` never examined `b`.
`collectRecursiveUnions` visits every one, and descends THROUGH them.

### What counts as a bound

A `Filter` on the work table is only ONE way a recursion terminates, and
treating it as the only one rejected exactly the traversal this guard exists to
preserve. The canonical graph query terminates by running out of edges, and its
bound is a JOIN condition ABOVE the work table:

```
Recursive Union
  Seq Scan     Filter="(source = 1)"
  Hash Join    Hash Cond="(r.id = e.source)"   ← this is the bound
    WorkTable Scan                              ← no Filter at all
```

`RECURSION_BOUND_KEYS` therefore covers `Filter`, `Hash Cond`, `Merge Cond`,
`Index Cond`, `Join Filter`, `One-Time Filter`, `Recheck Cond`, and `TID Cond`.
Verified for both `UNION ALL` and `UNION` (dedup) recursion on PGlite 0.5.3.

The SAME key set does double duty: above a `Recursive Union` these predicates
SUPPRESS rows (defeating the cap), below one they BOUND the recursion. That is
why `isPassThrough` rejects a pass-through node type that carries any of them.

**Honest limit, stated because it matters:** a bound is not a *proof* of
termination — `WHERE n > 0` on an incrementing counter still runs forever. This
catches the accidental and the obvious case, which is the realistic failure
mode. It is a heuristic layered on the row cap, not a decidability result, and
an unrecognised node type now fails CLOSED by construction.

### ⚠️ `analyze` uses a DIFFERENT predicate, and this is load-bearing

The "recursion under a pipelining parent is safe" argument depends ENTIRELY on
`query()`'s `LIMIT n+1` wrapper. `explain()` has no wrapper — `EXPLAIN` is
invalid inside a FROM subquery — and `ANALYZE` runs the statement to completion.

So under `analyze` the parent shape is irrelevant: **any** unbounded recursive
term is unstoppable, draining parent or not. Measured before the guard existed:

```sql
EXPLAIN (ANALYZE) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r)
SELECT n FROM r      -- still running after 10s (killed)
```

That is why `findUnboundableRecursion` takes `boundedByRowCap`: `true` for
`query()`, `false` for `explain(analyze)`. Both call the SAME
`AgentSqlService.admit()`, so a future guard cannot apply to one path and not the
other — the original duplication is exactly how this regression got in.

Note also that `analyze` has the cost ceiling but NO row bound, where `query()`
has both.

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
mode: 'listTables' | 'describeTable' | 'query' | 'explain'
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
- **`riskCategory: 'read'` is pinned explicitly** on its `defineNativeTool`
  declaration (`packages/assistant-contract/src/native-tools/definitions/query-self.ts`)
  rather than derived. The input is arbitrary SQL; a reader must see the bucket
  asserted at the declaration site with the sandbox named as its justification.
- **Desktop-only.** Excluded from `WEB_NATIVE_TOOL_IDS` — the browser has no
  assistant server.
- **Oversized results truncate with a hint** rather than routing through durable
  artifact settlement. A SQL result is trivially re-narrowable by the model,
  unlike a fetched web page that cannot be re-fetched identically.
- **A REQUIRED `mode` discriminator, and NO cross-field refinement.** The
  refinement this line used to describe was removed: it failed 100% of real
  calls under strict function calling (see the section above). A precedence rule
  would make a malformed call look like it worked, so the model states its mode
  and the fields that mode does not use — `sql`, `table`, `maxRows` — are
  ignored by contract. `analyze` is the ONE deliberate exception:
  `analyze: true` outside `mode: 'explain'` throws a visible
  `AgentSqlInputError` (`query-self-tool.ts`, pinned by test), because
  executing a statement the caller asked to merely time would be a silent
  semantic downgrade.

---

## Schema discoverability

A model handed "you may run SQL" against an unknown ~30-table schema
hallucinates column names. The schema modes are what make the tool usable:

- `mode: 'listTables'` → readable tables with `pg_class.reltuples` estimates
  (rendered `?` when `-1`, i.e. never analyzed — never a fabricated `0`)
- `mode: 'describeTable'` with `table` → columns, types, nullability

It rides the same sandbox because it is just a SELECT: one tool, one permission
surface, and the schema is derived from the live database rather than duplicated
into a description that drifts.

The tool description carries worked example queries. Those examples reference
real columns and are the first thing to update if a migration renames one.

---

## The symbol graph (migration 075, BST-919)

The code index carries a queryable symbol graph, extracted at chunking time
from the SAME parse that produces chunks (no separate walker — both the
initial sync and the edit-reindex path converge there):

- `file_symbols` — definitions: name, kind
  (`function|class|method|variable|interface|type|enum`), `exported`,
  line/offset ranges. JS/TS via the ESTree walker (oxc on desktop, Babel on
  web — same fields); Python via tree-sitter name captures.
- `file_symbol_refs` — name-based references: kind
  (`call|import|extends|implements`), `module` for imports, and
  `from_symbol_seq` = the ENCLOSING definition's seq (always intra-file).

**Refs store names, not resolved symbol ids — a settled ruling.** Symbol rows
share the chunk lifecycle (hard-deleted and re-inserted on every edit), so a
stored cross-file id would dangle after every re-index of the target file.
Cross-file edges are resolved at QUERY time by joining `refs.name =
symbols.name`. Over-connection (two `render`s alias) is the correct failure
direction for a retrieval index; exact resolution is the LSP pool's job, on
demand, later.

The headline traversal — transitive callers — is one statement, and its shape
(`UNION` dedup + join-terminated + explicit depth bound) is exactly what the
recursion guard admits:

```sql
WITH RECURSIVE callers(file_record_id, seq, name, depth) AS (
  SELECT s.file_record_id, s.seq, s.name, 0
  FROM file_symbols s WHERE s.name = 'startEmbeddingWorker'
  UNION
  SELECT encl.file_record_id, encl.seq, encl.name, c.depth + 1
  FROM callers c
  JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
  JOIN file_symbols encl
    ON encl.file_record_id = r.file_record_id AND encl.seq = r.from_symbol_seq
  WHERE c.depth < 10
)
SELECT DISTINCT fr.path, c.name, c.depth
FROM callers c JOIN file_records fr ON fr.id = c.file_record_id
ORDER BY c.depth, fr.path;
```

Rows are keyed by composite `(file_record_id, seq)` — measured, not guessed:
v1 text ids cost ~98% of raw source bytes on this monorepo; the composite
shape brings the whole graph (22,920 symbols + 109,297 refs from 3,337 TS
files) to ~27 MB, with sub-250 ms cold traversals. `from_symbol_seq` is
always intra-file, so the enclosing join carries the file id along.

Lifecycle: a managed-cache REPLACE deletes a file's symbol rows explicitly
(the `file_records` row survives an edit, so FK CASCADE cannot do it); file
deletion cascades; re-extraction rides `chunks_processed_at = NULL` exactly
like chunks. Symbol persistence failure degrades LOUDLY to
chunks-without-symbols — it never fails the file import.

### The hybrid one-statement query (BST-935) — PROVEN admitted

The original BST-919 pitch — traverse the graph, then rank the reachable
files' chunks with the BM25 and vector arms, fused, in ONE statement — runs
through the sandbox **as-is**. No sandbox change was needed; the guard's
allowlist direction survives contact with its headline use case.

**Be precise about WHY it is admitted, because the row cap plays no part.**
The statement's top level is a `GROUP BY … ORDER BY`, so `query()`'s
`LIMIT n+1` wrapper sits above a draining `Aggregate`/`Sort` — the walk in
`findUnboundableRecursion` reaches the `Recursive Union` with
`reachedByRowCap = false`, exactly as on the `explain(analyze)` path. The
statement drains fully regardless of `maxRows`. Admission rests entirely on
the recursion-bound heuristic (the depth filter + join conds below the
`Recursive Union` — a heuristic, not a termination proof; see "What counts
as a bound") plus the cost gate. Measured: planner cost ≈ 472 at a
2,005-chunk fixture and 25 ms wall-clock against a live 322-chunk workspace
— versus the 50,000 ceiling.

Idioms in the statement that are NOT discoverable via `describe` (operators
and an index name appear in no column listing), which is why the tool
description carries the first two:

- BM25 arm: `content <@> to_bm25query('terms', 'idx_file_chunks_content_bm25')`
  — raw score is ascending-better; the repositories negate it. english config
  does not split camelCase identifiers. Pair it with a
  `content_tsvector @@ websearch_to_tsquery(…)` match predicate so
  zero-relevance chunks earn no RRF mass.
- Vector arm: `embedding <=> (SELECT embedding FROM …)` — a STORED chunk
  embedding as the query vector (the chunk CONTAINING the seed symbol's
  `start_line`, not an arbitrary chunk of the file), so the whole statement
  needs no out-of-band embedding computation.
- **Scope the vector arm to the seed's `embedding_set_id`**
  (`IS NOT DISTINCT FROM`): `file_chunks.embedding` is deliberately
  dimensionless, and comparing across sets with different dimensions aborts
  the whole statement with `different vector dimensions`.
- Give each arm a `LIMIT` (canonically 50): the arms' work then scales with
  top-N, not with the size of the reachable set.

The canonical statement (traversal → `reachable` file set → both arms scoped
to it → RRF fusion `sum(1.0 / (60 + position))`) now SHIPS as the
`callers-hybrid` lens (`.brainstrike/lenses/callers-hybrid.sql` — see the
lens section below); the raw-SQL admission path stays pinned in
`packages/db/__tests__/search-hybrid-symbol-retrieval.test.ts`, including the
scoping proof (a bait chunk with content and embedding identical to the seed
chunk, in an unreachable file, must not appear), the mixed-dimension abort
without set scoping, thousand-chunk admission, and the BM25 index-name
tripwire against `BM25_CONTENT_INDEX_NAME`.

---

## Lenses (BST-921): retrieval strategy as a reviewable artifact

A **lens** is a named, parameterized SQL file under `.brainstrike/lenses/`
(per mounted root, then `~/.brainstrike/lenses/` — the persona two-tier,
flat-scan, first-id-wins convention; loader:
`apps/desktop/src/assistant-server/lens-loader.ts`, grammar:
`packages/assistant-contract/src/lenses.ts`). Header grammar:

```sql
-- description: <required, one line>
-- param: <name> <text|integer|number|boolean> <optional description>
<SQL body; $1..$N in param declaration order>
```

Invocation rides `brainstrike.querySelf`: `mode: 'listLenses'` (invalid
files are listed WITH their parse errors — fail closed, never silent) and
`mode: 'lens'` + `lens` + `values` (positional strings, coerced by the
declared types).

Invariants (do not silently reverse):

- **Same sandbox, no elevation.** A lens executes through the identical
  four-layer preamble + admission as `mode: 'query'`. A lens file is
  untrusted repo content, exactly like a persona file.
- **Values only ever travel as bind parameters** — `AgentSqlService.query`'s
  `params` rides the extended protocol into BOTH the admission `EXPLAIN`
  (PGlite plans parameterized statements; planning with real values keeps
  the cost estimate honest) and execution. Never interpolate a value into
  lens SQL.
- **Placeholder discipline is a PARSE-time error**: the SQL's highest `$n`
  must equal the declared param count and every `$1..$n` must appear —
  an authoring mistake surfaces in `listLenses`, not as a runtime surprise.
- **Every lens ships with a golden test.** `callers-hybrid` (the BST-935
  canonical statement, parameterized on symbol + terms) is proven by
  `packages/db/__tests__/search-lens-callers-hybrid.test.ts`, which reads
  the ACTUAL checked-in file — the artifact is the single source of truth.

Shipped lens inventory (each with its golden test,
`packages/db/__tests__/search-lens-<name>.test.ts`, reading the checked-in
file):

| Lens | What it answers |
| --- | --- |
| `callers-hybrid` | BST-935 hybrid retrieval over a symbol's caller graph |
| `token-spend-by-tool` | per-tool model-facing chars, truncation, zero-match, pagination proxy over a window |
| `estimator-calibration` | estimator-vs-provider prompt-token ratio distribution by model and budget tier (BST-1205/BST-1219) |
| `run-outcome-tool-correlation` | tool usage × run-outcome verdict buckets with per-verdict run denominators (`verdict_total_runs`, `verdict_run_share`); unlabeled runs kept as their own bucket (BST-1240) |
| `self-improvement-signal` | top-N tools by `waste_score` — a RANKING HEURISTIC (chars × (truncation rate + zero-match rate)), not a char count (BST-1240). BST-1247: rates count MODEL-CONTROLLABLE waste only — substrate-degraded calls (js-walk fallback, scan/candidate caps) are excluded and reported as `substrate_degraded_rate` |
| `experiment-outcome-correlation` | run outcomes grouped by per-run experiment treatment (experiment, variant, signal injection + distinct content hashes); unlabeled runs kept visible (BST-1250) |

The BST-1240 lenses normalize `tool_id` before grouping
(`brainstrike.grepSearch` → `grepSearch`): the telemetry writer stores the id
verbatim (`toolNameMap.get(toolId) ?? toolId`), so one logical tool can land
under both spellings, and a split would halve a waste score and silently push
the worst tool out of the top N.

The opt-in [self-improvement signal injection](workspace-context.md#self-improvement-signal-injection-bst-1241)
executes an app-owned copy of `self-improvement-signal`, pinned to the shipped
lens SQL body by a parity test; it never executes a workspace-scanned lens.

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

### Query plans: `mode: 'explain'`

Statistics tell you WHAT is slow; plans tell you WHY. `EXPLAIN` is invalid
inside a FROM subquery, which is why plans were unreachable until `explain` mode
bypassed the row-cap wrapper.

Two modes with genuinely different risk:

- **Plain `explain`** only PLANS. It cannot execute, so neither the cost ceiling
  nor the recursion guard applies — deliberately: explaining an expensive query
  is exactly when its plan is most valuable, so refusing it on cost would defeat
  the purpose.
- **`analyze: true`** EXECUTES the statement, so it passes through the SAME cost
  ceiling and recursion guard as an ordinary query. Writes stay blocked by the
  read-only transaction (verified: `EXPLAIN ANALYZE INSERT …` fails with
  `cannot execute INSERT in a read-only transaction`), so it cannot smuggle a
  mutation through.

Output is PostgreSQL's own indented plan text — the densest form, and the one
the model has seen most of.

### Not available

- **`pg_stat_statements` is not installed** (not in the PGlite extension set), so
  there is no per-query workload profile to rank by total time.

## Projection fitting

`querySelf` projections apply a 6,000-character domain budget. Rows are capped
at 200 by `maxRows`, but columns, lenses, and plan lines come from the database
or the user's lens directory and are not item-capped. Keep the largest complete
prefix by binary-searching the retained-item count. Dropping one item and
re-serializing the whole candidate on every iteration is quadratic—188 full
serializations on the maximum-row fixture alone, and unbounded for plan and
lens output. The paired performance test pins that fixture to a logarithmic
number of full-projection serializations while preserving the same
complete-prefix and explicit-omission contract.

## Paired tests

- `packages/db/__tests__/agent-sql-service.test.ts` — all four layers, the
  independent preamble proofs, result shaping, transaction hygiene, describe mode
- `packages/db/__tests__/migration-074-agent-readonly-role.test.ts` — role
  attributes, idempotency, grant coverage tripwire
- `packages/db/__tests__/search-hybrid-symbol-retrieval.test.ts` — the hybrid
  one-statement query admitted end-to-end, arm scoping via the traversal
- `packages/db/__tests__/search-lens-callers-hybrid.test.ts` — the shipped
  lens artifact: parse → coerce → sandbox execution with binds; the same
  pattern proves `search-lens-token-spend-by-tool.test.ts`,
  `search-lens-estimator-calibration.test.ts`,
  `search-lens-run-outcome-tool-correlation.test.ts` (per-verdict
  denominators, dotted-id normalization, 2k-row cost-gate admission), and
  `search-lens-self-improvement-signal.test.ts` (top_n cutoff, tiebreak,
  dotted-id merge)
- `packages/assistant-contract/src/__tests__/lenses.test.ts` — lens grammar,
  fail-closed; `apps/desktop/src/__tests__/assistant-server/lens-loader.test.ts`
  — two-tier scan; `query-self-lens-modes.test.ts` — dispatch + bind proof
- `packages/assistant-contract/src/__tests__/user-personas.test.ts` — persona
  exclusion
- `apps/desktop/src/__tests__/assistant-server/query-self-tool.test.ts` and
  `query-self-model-projection.test.ts` — error passthrough, projection budget;
  `query-self-model-projection-performance.test.ts` — bounded fitting work

When changing this flow, update this section and the paired tests.

---
