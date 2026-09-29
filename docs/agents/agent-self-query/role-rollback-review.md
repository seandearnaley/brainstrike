# Role rollback semantic review

Supports `agent-self-query.md` § "Role grant coverage (invariant)".

BST-941 reviewed migration 074 on 2026-09-29. The shipped migration is unchanged.
`MigrationRunner` is schema-validation-only; production Drizzle migrations are
forward-only. This review does not authorize rollback of a live profile.

`migration-074-rollback.integration.test.ts` runs the real numbered chain with
the full PGlite extension set. Its populated fixture verifies:

- Removing the role cleans its public schema, existing-table and default-table
  grants without deleting unrelated table rows or another role.
- Reapplication recreates a NOLOGIN, non-superuser role and restores existing
  and future-table reads. The implicit application superuser can still write.
- PUBLIC revocations of the three sleep functions and `set_config` deliberately
  survive rollback. Removing a sandbox identity is not authority to reopen
  functions that can freeze or contaminate the shared session.
- An unexpected grant in another schema blocks DROP ROLE. The transaction
  restores the preceding revokes and retains the numbered ledger entry. After
  removing only that fixture dependency, rollback succeeds.
- Executing the original SQL twice exercises its role-existence guard rather
  than merely testing the runner's already-unapplied skip.

Negative control: temporarily omit the down SQL's default-privilege cleanup.
The successful-rollback case fails because PostgreSQL refuses to drop a role
still referenced by default ACLs. Restore the original migration to pass.
This is mutation evidence for a semantic audit, not a production bug fix.

Disposition: the guarded DROP ROLE is correctly scoped for isolated schema
tests. No forward correction or historical migration edit is warranted.
