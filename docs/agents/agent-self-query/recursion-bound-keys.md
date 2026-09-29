# What counts as a recursion bound — evidence

Supports `docs/agents/agent-self-query.md` § "What counts as a bound".
Read before changing `RECURSION_BOUND_KEYS` or `isPassThrough`. Extracted verbatim from the pre-distillation contract.

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
