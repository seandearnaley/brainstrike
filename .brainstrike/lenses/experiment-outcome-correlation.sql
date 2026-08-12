-- description: Run outcomes grouped by experiment treatment (experiment, variant, signal injection) over an inclusive time window
-- param: since text  Inclusive ISO timestamp at the start of the window
-- param: until text  Inclusive ISO timestamp at the end of the window
--
-- BST-1250 (recursive self-improvement phase 2A): answers "did variant X beat
-- control on labeled runs" directly. Treatment rows are written by desktop
-- main at prompt assembly — the one seam that knows whether the
-- self-improvement signal actually injected and its exact content hash —
-- never inferred from date windows or the current preference value.
--
-- Windowed on the treatment's created_at (stamped at prompt assembly, i.e.
-- run start) rather than joining brainstrike_assistant_thread_runs: the run
-- header is bootstrap-only and cascades away with thread deletion, while
-- treatment and outcome evidence deliberately survive (mirroring
-- run_outcomes retention).
--
-- LEFT JOIN keeps runs that carry no outcome label — the common case — as
-- unlabeled counts rather than dropping them; an experiment lens that
-- silently excluded unlabeled runs would overstate its evidence.
--
-- signal_content_hashes counts DISTINCT injected texts inside a bucket: a
-- treatment arm whose signal content shifted mid-window (the hourly memo
-- refreshed onto new telemetry) is visible instead of silently pooled.
SELECT
  t.experiment_id,
  t.variant,
  t.signal_injected,
  count(*)::int AS runs,
  count(o.run_id)::int AS labeled_runs,
  (count(*) FILTER (WHERE o.verdict = 'succeeded'))::int AS succeeded,
  (count(*) FILTER (WHERE o.verdict = 'mixed'))::int AS mixed,
  (count(*) FILTER (WHERE o.verdict = 'failed'))::int AS failed,
  count(DISTINCT t.signal_content_hash)::int AS signal_content_hashes
FROM brainstrike_assistant_run_treatments t
LEFT JOIN brainstrike_assistant_run_outcomes o ON o.run_id = t.run_id
WHERE t.created_at >= $1::timestamptz
  AND t.created_at <= $2::timestamptz
GROUP BY t.experiment_id, t.variant, t.signal_injected
ORDER BY t.experiment_id NULLS LAST, t.variant NULLS LAST, t.signal_injected;
