-- description: Estimator-vs-provider prompt-token ratio distribution by model over an inclusive time window (BST-1205)
-- param: since text  Inclusive ISO timestamp at the start of the window
-- param: until text  Inclusive ISO timestamp at the end of the window
--
-- ratio = estimated_prompt_tokens / provider_reported_prompt_tokens: 1.0 means
-- the chars/4 backstop matched the provider's reported prompt tokens exactly;
-- >1 over-estimates, <1 under-estimates. NULLIF guards a zero denominator.
-- estimated_prompt_tokens covers tool-output + tool-definition backstop share
-- only (see brainstrike_token_estimate_calibration's migration comment) — it
-- is NOT a full conversation/system-prompt estimate, so this ratio is a
-- partial-scope reconciliation signal, not a budget-meter calibration factor.
SELECT
  model,
  count(*)::int AS samples,
  min(estimated_prompt_tokens::float8 / NULLIF(provider_reported_prompt_tokens, 0)) AS ratio_min,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY estimated_prompt_tokens::float8 / NULLIF(provider_reported_prompt_tokens, 0)
  ) AS ratio_median,
  max(estimated_prompt_tokens::float8 / NULLIF(provider_reported_prompt_tokens, 0)) AS ratio_max,
  avg(estimated_prompt_tokens::float8 / NULLIF(provider_reported_prompt_tokens, 0)) AS ratio_avg
FROM brainstrike_token_estimate_calibration
WHERE occurred_at >= $1::timestamptz
  AND occurred_at <= $2::timestamptz
GROUP BY model
ORDER BY model;
