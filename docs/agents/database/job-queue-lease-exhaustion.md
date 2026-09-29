# Job queue lease exhaustion

Supports `database.md` § "ATOMIC CHUNK AND JOB WRITES".

The queue increments `attempts` when it claims a job. Previously, a worker that
stopped or crashed on its final attempt left a `running` row after lease expiry.
The claim predicate required `attempts < max_attempts`, so later polls could
neither reclaim nor fail the row. A deduped enqueue returned that stale row,
while queue statistics continued to report it as running.

Claim now handles expired exhausted leases in the same atomic statement as
ordinary claims. The terminal update rechecks state and lease expiry after
locking its candidate, and only its `RETURNING` rows increment the durable
failure counter. A current worker may extend an unexpired lease; a stale token
cannot heartbeat or complete after terminal failure. Leases with attempts
remaining retain the existing reclaim path.

A 2026-09-26 PGlite EXPLAIN ANALYZE comparison used 10,000 migrated rows:
6,000 live final leases, 1,000 expired final, 1,000 expired retryable, 1,000 queued,
and 1,000 expired in another queue. Across five rollback-contained runs, the
mixed-poll median rose from 1.55ms to 2.44ms; an idle variant rose from 0.377ms
to 0.699ms. Existing state/lease indexes were used, with no full 10,000-row scan.
The transition limit bounds writes, not scan volume: the mixed query visited
3,000 expired rows and sorted 1,000 (79kB). This measured overhead did not justify
another index, but it is not a claim of constant scan cost for larger backlogs.
