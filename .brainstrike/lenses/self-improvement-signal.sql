-- description: Top N most wasteful tool behaviors over an inclusive time window, ranked by a waste-score heuristic
-- param: since text  Inclusive ISO timestamp at the start of the window
-- param: until text  Inclusive ISO timestamp at the end of the window
-- param: top_n integer  Number of tools to keep, ranked by waste score (canonically 5)
--
-- waste_score = total_model_facing_chars * (truncation_hit_rate +
-- zero_match_rate) is a RANKING HEURISTIC, not an estimate of wasted
-- characters: zero-match responses are usually tiny, so weighting total chars
-- by the zero-match rate deliberately over-weights misses as a behavioral
-- signal (a tool that misses often has a targeting problem regardless of how
-- few chars each miss costs). Do not read the score as a char count.
--
-- tool_id is stored VERBATIM by the telemetry writer, so one logical tool
-- can land under both bare and dotted spellings ('grepSearch' /
-- 'brainstrike.grepSearch'); the CTE normalizes to the bare spelling before
-- grouping. This matters more here than in the sibling lenses: they list
-- every tool so a split is visible, while a split here halves a waste score
-- and can silently push the genuinely-worst tool out of the top N.
--
-- COALESCE folds the zero-match term to 0 for tools that never report it
-- (every non-search tool) so they still rank by truncation alone; the
-- zero_match_rate COLUMN stays NULL for those tools — the fold is confined
-- to the score. tool_id breaks waste-score ties so the top N is
-- deterministic.
WITH normalized AS (
  SELECT
    CASE
      WHEN tool_id LIKE 'brainstrike.%' THEN substr(tool_id, 13)
      ELSE tool_id
    END AS tool_id,
    model_facing_chars,
    truncated,
    zero_match
  FROM brainstrike_tool_call_telemetry
  WHERE occurred_at >= $1::timestamptz
    AND occurred_at <= $2::timestamptz
)
SELECT
  tool_id,
  count(*)::int AS calls,
  sum(model_facing_chars)::float8 AS total_model_facing_chars,
  sum(truncated::int)::float8 / count(*) AS truncation_hit_rate,
  avg(zero_match::int)::float8 AS zero_match_rate,
  sum(model_facing_chars)::float8
    * (sum(truncated::int)::float8 / count(*) + COALESCE(avg(zero_match::int)::float8, 0))
    AS waste_score
FROM normalized
GROUP BY tool_id
ORDER BY waste_score DESC, tool_id
LIMIT $3;
