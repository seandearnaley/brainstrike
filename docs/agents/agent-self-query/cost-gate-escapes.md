# Cost-gate escapes and the allowlist ruling — evidence

Supports `docs/agents/agent-self-query.md` § "The cost gate is a PLANNER-cost gate — and what that does NOT cover".
Read before weakening the EXPLAIN cost gate, the migration 074 REVOKEs, or the recursion admission rule. Extracted verbatim from the pre-distillation contract.

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
