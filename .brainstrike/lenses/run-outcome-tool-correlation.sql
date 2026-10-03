-- description: Tool usage patterns (calls, truncation, zero matches, follow-ups) grouped by tool and run outcome verdict, with per-verdict run denominators, over an inclusive time window
-- target: app
-- param: since text  Inclusive ISO timestamp at the start of the window
-- param: until text  Inclusive ISO timestamp at the end of the window
--
-- LEFT JOIN keeps telemetry from runs that carry no outcome label — the
-- overwhelmingly common case — bucketed as 'unlabeled' rather than dropped;
-- a correlation lens that silently excluded unlabeled runs would compare
-- labeled runs against nothing.
--
-- verdict_total_runs / verdict_run_share are what make correlation
-- computable from this output alone: `runs` is "distinct runs that used THIS
-- tool with THIS verdict", and summing it within a verdict over-counts (a
-- run using three tools appears in three rows). The share divides by the
-- per-verdict distinct-run total, so "grepSearch appears in 80% of failed
-- runs but 10% of succeeded runs" is readable directly off two rows.
--
-- tool_id is stored VERBATIM by the telemetry writer, so one logical tool
-- can land under both bare and dotted spellings ('grepSearch' /
-- 'brainstrike.grepSearch'); the CTE normalizes to the bare spelling before
-- grouping so a split spelling cannot halve a bucket.
--
-- Rate columns mirror token-spend-by-tool: truncation_hit_rate and
-- followup_call_rate divide by count(*) (every call counts, denominator
-- never shrinks); zero_match_rate uses avg() over the nullable column, whose
-- denominator EXCLUDES rows where zero_match is NULL (every non-search
-- tool). The asymmetry is intentional, not a bug.
WITH labeled AS (
  SELECT
    CASE
      WHEN t.tool_id LIKE 'brainstrike.%' THEN substr(t.tool_id, 13)
      ELSE t.tool_id
    END AS tool_id,
    t.run_id,
    t.model_facing_chars,
    t.truncated,
    t.zero_match,
    t.is_pagination_followup,
    COALESCE(o.verdict, 'unlabeled') AS verdict
  FROM brainstrike_tool_call_telemetry t
  LEFT JOIN brainstrike_assistant_run_outcomes o ON o.run_id = t.run_id
  WHERE t.occurred_at >= $1::timestamptz
    AND t.occurred_at <= $2::timestamptz
),
verdict_runs AS (
  SELECT verdict, count(DISTINCT run_id)::int AS verdict_total_runs
  FROM labeled
  GROUP BY verdict
)
SELECT
  l.tool_id,
  l.verdict,
  count(DISTINCT l.run_id)::int AS runs,
  v.verdict_total_runs,
  count(DISTINCT l.run_id)::float8 / v.verdict_total_runs AS verdict_run_share,
  count(*)::int AS calls,
  sum(l.model_facing_chars)::float8 AS total_model_facing_chars,
  sum(l.truncated::int)::float8 / count(*) AS truncation_hit_rate,
  avg(l.zero_match::int)::float8 AS zero_match_rate,
  sum(l.is_pagination_followup::int)::float8 / count(*) AS followup_call_rate
FROM labeled l
JOIN verdict_runs v ON v.verdict = l.verdict
GROUP BY l.tool_id, l.verdict, v.verdict_total_runs
ORDER BY l.tool_id, l.verdict;
