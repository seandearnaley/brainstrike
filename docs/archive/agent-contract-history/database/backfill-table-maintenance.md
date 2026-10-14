# Backfill table maintenance ownership — evidence

Supports `docs/agents/database.md` § "BACKFILL TABLE MAINTENANCE".

Why embedding-backfill completion may not issue VACUUM/ANALYZE on PGlite's single backend, and the ordering rules inside the scheduled pass. BST-1169.

The record below is the original contract text, extracted unchanged.

Embedding backfill completion must never issue `VACUUM` or `ANALYZE` directly.
PGlite has one WASM Postgres backend, so a table-wide maintenance statement on
that path blocks all interactive queries and worker claim/complete traffic.
The desktop scheduled-database-maintenance pass is the sole owner instead: it
first verifies the database work scheduler is idle, then verifies there are no
queued or running jobs before admitting heavyweight maintenance.

`file_chunks` and `job_queue` are both members of
`DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES`; `VACUUM (ANALYZE)` reclaims their
dead tuples and refreshes planner statistics in one idle pass. Plain `ANALYZE`
runs before the VACUUM set so a slow or failing `file_chunks` vacuum cannot
starve the cheap `file_records` and `embedding_cache` statistics refreshes. Do
not also list `file_chunks` in the default plain-ANALYZE set. `file_chunks` is
ordered last so a timeout or vacuum failure on the largest table cannot prevent
the smaller retention-ledger vacuums from running first. Every maintenance
statement taking at least one second emits a warning containing the exact SQL
statement and duration; this includes queue reads, retention probes/deletes,
plain ANALYZE, and VACUUM. That preserves one-glance attribution for single-host
stalls. Failed or interrupted backfills leave maintenance to the same scheduled
pass; index recovery is independent of heap reclamation and must not reacquire
the host for an inline vacuum.
