-- description: Model-facing characters, call counts, truncation, zero matches, and pagination proxy grouped by tool over an inclusive time window
-- target: app
-- param: since text  Inclusive ISO timestamp at the start of the window
-- param: until text  Inclusive ISO timestamp at the end of the window
--
-- truncation_hit_rate divides by count(*) (every call counts, denominator
-- never shrinks); zero_match_rate uses avg() over a nullable column, whose
-- denominator EXCLUDES rows where zero_match is NULL (every non-search tool).
-- Both are correct for what they measure — the asymmetry is intentional, not
-- a bug: truncation applies to every tool, zero-match only to search tools.
--
-- pages_per_search_proxy = (first pages + follow-up pages) / first pages, so
-- it reads as an actual pages-per-search count (a search with 1 first page +
-- 2 follow-ups reports 3, not 2). NULLIF(firsts, 0) makes it NULL both when a
-- window has no search calls at all AND when it has only follow-up calls with
-- no first page (a real, if rare, window-boundary case) — both read the same
-- as an inapplicable tool's NULL; treat this column as "no first-page calls
-- to anchor the ratio to" rather than "no search activity".
SELECT
  tool_id,
  count(*)::int AS calls,
  sum(model_facing_chars)::float8 AS total_model_facing_chars,
  avg(model_facing_chars)::float8 AS avg_model_facing_chars,
  sum(truncated::int)::float8 / count(*) AS truncation_hit_rate,
  avg(zero_match::int)::float8 AS zero_match_rate,
  CASE
    WHEN tool_id IN ('grepSearch', 'globWorkspace', 'brainstrike.grepSearch', 'brainstrike.globWorkspace')
    THEN (
      count(*) FILTER (WHERE NOT is_pagination_followup)
      + count(*) FILTER (WHERE is_pagination_followup)
    )::float8 / NULLIF(count(*) FILTER (WHERE NOT is_pagination_followup), 0)
    ELSE NULL
  END AS pages_per_search_proxy
FROM brainstrike_tool_call_telemetry
WHERE occurred_at >= $1::timestamptz
  AND occurred_at <= $2::timestamptz
GROUP BY tool_id
ORDER BY tool_id;
