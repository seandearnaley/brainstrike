# The four sandbox layers, and the wrapper above them — evidence

Supports `docs/agents/agent-self-query.md` § "The sandbox: four independent, engine-enforced layers".
Read before removing, merging or reordering a sandbox layer. Extracted verbatim from the pre-distillation contract. The closing paragraph is the former "Verified NOT a concern" section.

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

Secrets are not in the database. Provider API keys live in Electron
`safeStorage` (`apps/desktop/src/secrets.ts`); there is no credential table to
leak. This was checked rather than assumed, and it is worth re-checking if
anyone proposes storing a credential in PGlite.
