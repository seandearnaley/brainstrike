# Migration 118 convergence over shipped bootstrap eras — evidence

Supports `docs/agents/assistant-persistence.md` §
"118 must CONVERGE, because every existing install already has these tables". Read this before proposing to change migration 118 or its upgrade-path test seeds.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

The fresh database is the easy case. The one that decides this migration is the
install that has been running the assistant for months: the retired bootstrap
already created both relations there, and 118 is about to run over them.

- A bare `CREATE TABLE` **errors on upgrade for every existing user**. It is not
  an option and never was.
- A conditional `CREATE TABLE` **skips**, and by itself that is exactly the
  silent drift this ticket deletes — preserved on precisely the installs that
  matter. So the conditional create is only half the migration. The other half
  is the additive statements above, which must cover every difference between
  what a shipped bootstrap era left and what the create declares.

That obligation is what makes the additive statements load-bearing rather than
defensive noise, and it is CHECKED, not asserted:
`assistant-run-schema-upgrade-path.test.ts` (db) seeds a database the way each
shipped bootstrap era actually left it — pre-BST-1163 (no `turn_message_id`),
BST-1404 (the `run_id`-shaped answer index), and the final BST-1440 shape — runs
the chain over it, and asserts the resulting catalog is IDENTICAL to a
freshly-migrated one: columns WITH THEIR ORDINALS, indexes, and constraints
including the `thread_id` foreign key. Column ordinal is in the comparison
deliberately; it is the projection the `tool_projection_rewrites` divergence
above hid in.

Its seeds are frozen history, identified by the commit that shipped them. If a
future change to 118 makes that test fail, the bug is the missing forward
statement — **never** the seed.

Paired coverage: `assistant-memory-schema-probe.integration.test.ts`
(assistant-data), `mastra-schema-migration-parity.test.ts` and
`assistant-run-schema-upgrade-path.test.ts` (db).

