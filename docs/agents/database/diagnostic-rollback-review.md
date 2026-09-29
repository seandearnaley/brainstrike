# Diagnostic rollback semantic review

Supports `database.md` § "SAFE CATALOG ROLLBACK WITH LIVE USER DATA".

BST-829 reviewed migration 073 on 2026-09-29. No shipped SQL, registration or
ledger key changes. Production Drizzle is forward-only; this numbered rollback
exercise is not a production recovery procedure.

`packages/db/__tests__/migration-073-rollback.integration.test.ts` uses the full
PGlite extension factory and the real numbered prefix through 073. It seeds a
durable file and a diagnostic containing structured context/cause data. The
diagnostic's correlation text can be orphaned; no historical thread schema is
invented for this prefix.

- Down removes the populated diagnostic table, its primary key and all four
  original indexes. Complete file and model rows remain unchanged.
- Reapplication restores the original index definitions and severity CHECK,
  but an EMPTY table. New fatal events can be written and info is rejected.
  Deleted diagnostic evidence has no automatic rebuild owner; down/up is not
  recovery of a debug pack's original records.
- A dependent view blocks the final DROP after the four explicit index drops.
  The transaction restores their definitions, every populated diagnostic row
  and the view; the numbered ledger remains applied. Removing the view lets
  rollback succeed without changing retained file/model rows.
- Repeating raw down checks IF EXISTS independently of the runner's ledger skip.
- A separate current-chain case proves the out-of-order limitation: 076's
  diagnostic run index exists before down, disappears with the table, and is
  not recreated by 073 up. The 076 ledger entry still says applied. Reapplying
  an older migration cannot reconcile later schema ownership or its ledger.

Negative control: temporarily add DELETE FROM file_records to down. Retained
file snapshots fail; restoring the original SQL is GREEN. This is a semantic
audit mutation, not a claimed production defect correction.

Disposition: deletion scope is correct, but diagnostic evidence is operational
data without a rebuild owner (`packages/db/src/table-durability-registry.ts`).
No historical edit or forward correction is warranted. Preserve evidence in a
verified isolated clone and use the contract's reviewed forward recovery path;
never run this down/up sequence or edit the production ledger on a live profile.
