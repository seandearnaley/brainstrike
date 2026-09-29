# July catalog rollback semantic review

Supports `database.md` § "MODEL CATALOG MIGRATIONS (CRITICAL)".

BST-760 reviewed migration 071 on 2026-09-29. Shipped SQL and its ledger key
are unchanged. The numbered runner is schema-validation-only; production
Drizzle applies forward migrations only.

`packages/db/__tests__/migration-071-rollback.integration.test.ts` applies the
real numbered prefix through 070 using the full PGlite extension factory.
It adds an already-enabled target row with explicit user-intent timestamps.

- Up refreshes authored metadata while retaining that row's enabled choice
  and both timestamps. Existing OpenRouter rows shift by nine; all other
  columns and providers remain unchanged. Repeated runner up changes nothing.
- Down removes the nine target IDs only when owned by OpenRouter and reverses
  the order shift on remaining OpenRouter rows. All non-target rows match the
  original complete-row snapshot. A target reassigned to another provider
  survives with its complete row unchanged.
- Down also deletes a target row that existed before up. Reapplication seeds
  it disabled; the prior enabled choice and overwritten metadata are not
  recovered. This is destructive rollback, not restoration of prior state.
- A fixture trigger rejects the final order UPDATE after DELETE. PostgreSQL
  restores every deleted row, every column and the numbered ledger entry.
  Removing the trigger allows rollback. The repeated runner rollback is a
  ledger skip; raw down is NOT idempotent because it shifts order again.

Negative control: temporarily replace `is_enabled = models.is_enabled` with
`is_enabled = EXCLUDED.is_enabled`. The conflict-row assertion fails; restoring
shipped SQL passes. This is audit mutation evidence, not a production fix.

Disposition: up preserves user choices as required; down is scoped but cannot
recover user state. No historical edit or forward correction is warranted.
Use the verified-clone and reviewed-forward-migration procedure for recovery.
The prefix isolates 071's own ordering semantics; it does not claim that
rolling it back out of order reverses later catalog changes or provider swaps.
