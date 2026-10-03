# Canonical record invalidation

Canonical source removal uses the existing managed-cache invalidation transaction for both rooted workspace rows and rootless collection rows. Exact-record targets guard the actual PG ID, embedding-set membership and nullable root/path before reusing the same chunk/job cancellation, lease clearing, lifetime outcome metrics and source deletion policy.

## 2026-10-03: rootless catalog removal

Independent review of the first authoritative catalog adapter found that its rootless branch called the generic repository delete directly. PostgreSQL cascaded file/chunk deletion but retained queued and running embedding jobs, including running lease ownership. A bounded real-PG probe showed zero source/chunk rows while its queued job stayed queued and its running job retained its lease and worker.

The adapter integration regression reproduced that exact result against the unchanged implementation: after native removal joined and the source/chunks were gone, the queued job remained queued, and the running job still had its token, future lease expiry and worker. The correction extends the existing invalidation target with mode `record`, a required expected file ID and nullable root/path. Collection membership is still mandatory. Exact and prefix root/path queries retain their existing shape; the new record matcher feeds their shared invalidation runner.

The paired tests cover native removal held before PG mutation, cancellation of queued/running jobs, lease ownership clearing, cancellation metrics, rejection of heartbeat/completion through the old lease, exclusion of removed jobs from new claims, unrelated source/jobs, foreign collection membership and stale root/path. The existing root/path policy tests continue to cover rooted deletion and batch behavior. No migration, replacement cancellation SQL, new store or service is introduced.
