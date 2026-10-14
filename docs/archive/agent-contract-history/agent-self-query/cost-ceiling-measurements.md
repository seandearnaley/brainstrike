# Where the 50,000 cost ceiling came from — evidence

Supports `docs/agents/agent-self-query.md` § "The cost ceiling".
Read before moving `DEFAULT_AGENT_SQL_COST_CEILING`. Extracted verbatim from the pre-distillation contract.

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
