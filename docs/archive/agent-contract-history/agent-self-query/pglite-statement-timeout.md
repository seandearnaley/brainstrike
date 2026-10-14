# PGlite never enforces statement_timeout — evidence

Supports `docs/agents/agent-self-query.md` § "⚠️ `statement_timeout` IS INERT IN PGLITE".
Read before proposing to set a statement timeout on the sandbox. Extracted verbatim from the pre-distillation contract; the measurements are PGlite 0.5.3 / PostgreSQL 18.3.

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
