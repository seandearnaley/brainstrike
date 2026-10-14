# Explicit text commits — 2026-10-03

The independently measured fused-vector retrieval gate failed on the complete
canonical corpus. Product policy therefore calls for text default plus explicit
vector opt-in. This package layer enables that policy without inference: a
separate strict `commitTextFile` operation accepts the validated plan and optional
canonical syntax metadata, with no embedding payload. Host startup still requires
a complete validated configured profile; no nullable identity or guessed model.

Missing-vector absence is represented by no vec row, while ordinary FTS/file
rows persist. Text replacement keeps unchanged vectors and deletes stale rows.
Required-vector commits still validate the exact complete missing-vector set.
Prepare now joins actual vec rows when identifying missing embeddings; unchanged
snapshots can explicitly backfill vectors rather than taking a false no-op.
Backfill preserves unchanged graph metadata. Schema3 persists has_vector=0/1 per chunk and verifies actual vector presence, root identity and orphan absence on reopen. Schema2 now raises rebuild-required without wiping/migrating. The new real text-close/reopen check first exposed the old all-chunks-have-vectors guard; explicit durable presence fixes it without weakening corruption detection.

The real process test first failed because commitTextFile was absent. It then
proved text retrieval with zero vector hits, strict missing-vector rejection,
tampered missing-set rejection, actual later backfill, unchanged-vector reuse,
changed-vector deletion and file removal. The actual Electron utility positive
proof exercises text commit followed by vector backfill and existing lifecycle,
incremental, reopen and reset checks. Full app wiring is a following layer.

CI is disabled due to cost; validation must run locally. No new quarantine,
fallback, model default, main inference or hosted execution is introduced.
