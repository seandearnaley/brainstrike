# Role grant coverage and the privilege-assertion gotcha — evidence

Supports `docs/agents/agent-self-query.md` § "Role grant coverage".
Read before changing migration 074 grants or its test. Extracted verbatim from the pre-distillation contract.

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
