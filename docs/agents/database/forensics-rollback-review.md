# Run-error rollback semantic review

Supports `database.md` § "SAFE CATALOG ROLLBACK WITH LIVE USER DATA".

BST-943 reviewed migration 076 on 2026-09-29. Shipped SQL is unchanged. The
numbered runner is schema-validation-only; production Drizzle is forward-only.

`migration-076-rollback.integration.test.ts` runs the real numbered chain with
the full engine-extension set and seeds a conversation, a failed run, its
forensic error row, and an independent diagnostic row linked by run id.

- Down deletes the forensic table and its indexes. It removes only migration
  076's run-correlation index from diagnostics; diagnostic rows and all other
  diagnostic indexes survive, as do the conversation and run rows.
- Reapplication restores an EMPTY forensic table, its indexes and HTTP-status
  constraint, and the diagnostic run index. New error rows can be written.
  Old forensic evidence is irretrievably lost: no automatic rebuild exists.
- A view depending on the forensic table blocks DROP TABLE. The transaction
  restores the three earlier index drops, the populated error rows and the
  numbered ledger entry. It preserves the dependent view without CASCADE.
- Repeating raw down SQL proves IF EXISTS guards rather than only exercising
  the runner's unapplied-migration skip.

Negative control: temporarily add a DELETE of the correlated diagnostic rows
before the down SQL. The populated preservation case fails on lost diagnostics;
restoring the original migration is GREEN. This is an audit mutation control,
not a production bug correction.

Disposition: destructive scope is correctly limited, but the forensic table is
operational data with no rebuild owner (`table-durability-registry.ts`). A down/up
round trip is not data recovery. Do not run down SQL on a live profile or
change the production ledger. Use the contract's verified clone and reviewed
forward-migration procedure; preserve forensic evidence in the clone before
any exceptional isolated investigation. No historical migration edit or new
forward correction is justified by this review.
