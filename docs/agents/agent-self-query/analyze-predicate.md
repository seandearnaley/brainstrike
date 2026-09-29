# Why analyze uses a different predicate — evidence

Supports `docs/agents/agent-self-query.md` § "⚠️ `analyze` uses a DIFFERENT predicate, and this is load-bearing".
Read before changing `findUnboundableRecursion` or the `explain` path. Extracted verbatim from the pre-distillation contract.

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
