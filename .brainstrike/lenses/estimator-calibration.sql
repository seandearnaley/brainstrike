-- description: Estimator-vs-provider prompt-token ratio distribution by model and resolved tool-result budget tier over an inclusive time window (BST-1205/BST-1219)
-- target: app
-- param: since text  Inclusive ISO timestamp at the start of the window
-- param: until text  Inclusive ISO timestamp at the end of the window
--
-- ratio = estimated_prompt_tokens / final_step_prompt_tokens. The numerator is
-- the chars/4 backstop over model-visible tool-output projections plus tool
-- definitions, each counted once. The denominator is the latest step's prompt,
-- which already contains prior tool outputs once via Mastra's resend behavior,
-- never the cross-step accumulated total. Conversation/system-prompt text
-- outside tool outputs/definitions is excluded from both figures.
-- The samples FILTER rejects zero denominators; the WHERE guard rejects legacy
-- zero-estimate rows that never exercised the estimator. Completed-run emission
-- now enforces the latter, so both guards are defensive for future/rare rows.
-- BST-1232: the writer no longer requires a measured tool-output projection
-- to persist a row — a zero-projection turn now also writes a row so the
-- next turn's compaction trigger can read prompt_baseline_tokens. That makes
-- `estimated_prompt_tokens` alone insufficient to keep those rows out of this
-- RATIO (it can still be positive from the static tool-definition catalog
-- alone), so `model_visible_projection_count > 0` is the real eligibility
-- gate for the calibration signal this lens reports.
SELECT
  model,
  resolved_domain_budget_tokens,
  resolved_transport_budget_tokens,
  count(*) FILTER (WHERE final_step_prompt_tokens > 0)::int AS samples,
  min(estimated_prompt_tokens::float8 / NULLIF(final_step_prompt_tokens, 0)) AS ratio_min,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY estimated_prompt_tokens::float8 / NULLIF(final_step_prompt_tokens, 0)
  ) AS ratio_median,
  max(estimated_prompt_tokens::float8 / NULLIF(final_step_prompt_tokens, 0)) AS ratio_max,
  avg(estimated_prompt_tokens::float8 / NULLIF(final_step_prompt_tokens, 0)) AS ratio_avg
FROM brainstrike_token_estimate_calibration
WHERE occurred_at >= $1::timestamptz
  AND occurred_at <= $2::timestamptz
  AND estimated_prompt_tokens > 0
  AND model_visible_projection_count > 0
GROUP BY model, resolved_domain_budget_tokens, resolved_transport_budget_tokens
ORDER BY model, resolved_domain_budget_tokens NULLS FIRST, resolved_transport_budget_tokens NULLS FIRST;
