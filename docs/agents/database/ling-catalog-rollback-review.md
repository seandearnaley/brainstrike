# Ling catalog rollback semantic review

Supports `database.md` § "MODEL CATALOG MIGRATIONS (CRITICAL)".

BST-768 reviewed migration 072 on 2026-09-29 without modifying shipped SQL or
its ledger key. Production Drizzle is forward-only; numbered rollback is
schema-validation-only.

`packages/db/__tests__/migration-072-rollback.integration.test.ts` uses the
full PGlite extension factory and the real numbered prefix through 071. A
pre-existing Ling Free row has an enabled choice and explicit intent timestamps.

- Up refreshes that row's authored metadata, preserving its enabled choice
  and both timestamps. The one-slot order shift changes no other columns;
  complete rows under other providers are untouched.
- Down deletes the targeted OpenRouter row, including one that existed before
  up, and reverses the remaining OpenRouter order shift. Reapplication inserts
  the model disabled; deleted user intent and prior metadata cannot be recovered.
- A target ID reassigned to another provider is preserved, including its order
  and every column. Deletion authority is provider-scoped, not just ID-scoped.
- A trigger rejecting the final order UPDATE proves the preceding DELETE and
  ledger removal are atomic. Every model row matches the pre-rollback snapshot
  after failure; removing the trigger allows rollback.
- Repeated runner up/down is guarded by the numbered ledger. Raw down is not
  idempotent: it shifts remaining OpenRouter rows on each execution.

Negative control: temporarily remove down's provider predicate. The protected
cross-provider row disappears and the preservation test fails. Restoring SQL
passes. This is semantic-audit mutation proof, not a production bug fix.

Disposition: up preserves choices and down limits deletion correctly, but the
round trip is not prior-state recovery. No historical edit or forward correction
is warranted. Follow the verified-clone and forward-migration recovery contract.
The prefix isolates 072; it does not validate out-of-order rollback through later
retirements, route replacements or provider swaps.
