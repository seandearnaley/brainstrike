-- description: Tool usage patterns (calls, truncation, zero matches, follow-ups) grouped by tool and run outcome verdict over an inclusive time window
-- param: since text  Inclusive ISO timestamp at the start of the window
-- param: until text  Inclusive ISO timestamp at the end of the window
--
-- LEFT JOIN keeps telemetry from runs that carry no outcome label — the
-- overwhelmingly common case — bucketed as 'unlabeled' rather than dropped;
-- a correlation lens that silently excluded unlabeled runs would compare
-- labeled runs against nothing.
--
-- Rate columns mirror token-spend-by-tool: truncation_hit_rate and
-- followup_call_rate divide by count(*) (every call counts, denominator never
-- shrinks); zero_match_rate uses avg() over the nullable column, whose
-- denominator EXCLUDES rows where zero_match is NULL (every non-search tool).
-- The asymmetry is intentional, not a bug.
SELECT
  t.tool_id,
  COALESCE(o.verdict, 'unlabeled') AS verdict,
  count(DISTINCT t.run_id)::int AS runs,
  count(*)::int AS calls,
  sum(t.model_facing_chars)::float8 AS total_model_facing_chars,
  sum(t.truncated::int)::float8 / count(*) AS truncation_hit_rate,
  avg(t.zero_match::int)::float8 AS zero_match_rate,
  sum(t.is_pagination_followup::int)::float8 / count(*) AS followup_call_rate
FROM brainstrike_tool_call_telemetry t
LEFT JOIN brainstrike_assistant_run_outcomes o ON o.run_id = t.run_id
WHERE t.occurred_at >= $1::timestamptz
  AND t.occurred_at <= $2::timestamptz
GROUP BY t.tool_id, COALESCE(o.verdict, 'unlabeled')
ORDER BY t.tool_id, verdict;
