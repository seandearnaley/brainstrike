# Symbol graph rollback semantic review

Supports `agent-self-query.md` § "The symbol graph (migration 075, BST-919)".

BST-942 reviewed migration 075 on 2026-09-29 without changing shipped SQL.
`MigrationRunner` and its rollback are schema-validation-only. Production
Drizzle remains forward-only; this is not a live-profile recovery procedure.

`migration-075-rollback.integration.test.ts` runs the real numbered chain with
the full PGlite extension set, then seeds a file, stored source, a chunk,
symbol definitions and a reference with an enclosing-symbol FK.

- Down removes refs before definitions, including the traversal indexes. The
  populated roots, file records and chunks remain unchanged.
- Reapplying up recreates an EMPTY derived graph. It marks only content-bearing
  processed files for re-extraction by clearing `chunks_processed_at` and
  `chunking_strategy`; unloaded files keep their existing markers.
- The ordinary `FileSymbolRepository` can repopulate the graph. SELECT grants
  survive recreation through default privileges, and the enclosing-symbol FK
  still rejects a dangling reference.
- A dependent view blocks the final definition-table drop. PostgreSQL restores
  the earlier reference-table/index drops, all graph rows, and the numbered
  ledger entry. There is no CASCADE that silently deletes the extra view.
- Repeating raw down SQL checks its IF EXISTS guards independently of the
  runner's unapplied-migration skip.

Negative control: omit up's re-extraction-marker update temporarily. The
populated rollback/reapply case must fail because an unchanged file would
otherwise keep a permanently empty graph. Restore original SQL for GREEN.
This proves a regression guard, not a newly reproduced production defect.

Disposition: deletion is limited to derived symbol data and reapplication
provides the existing rebuild marker. No historical SQL edit is warranted.
This suite proves marking and repository reconstruction, not an end-to-end
background parser run; extraction/lifecycle behavior remains guarded by the
existing symbol, indexing and hybrid-search suites.
