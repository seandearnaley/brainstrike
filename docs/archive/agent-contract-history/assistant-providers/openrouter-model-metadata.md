# OpenRouter model metadata and limits — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". Capability-aware reasoning controls, the selected-model metadata endpoint, and the Qwen3.8 Flash exception.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 879-992); append rather than
rewrite.

---

- OpenRouter reasoning controls are model-capability-aware when the Models API
  publishes its `reasoning` object. Selected-model metadata validates and
  preserves `mandatory`, `default_enabled`, `supported_efforts`,
  `default_effort`, and `supports_max_tokens`; absence is never guessed as
  support. Declare those efforts on the static
  model definition; `resolveReasoningControlsAvailability` in
  packages/assistant-contract/src/model-reasoning.ts is the single resolver
  that filters the UI controls (the composer ComposerEffortControl slider) to
  the declared set, and the request boundary rejects incompatible settings at
  construction. Matching live metadata overrides the static entry for both
  controls and request construction. Optional models expose Off even when
  `none` is not an advertised effort, using `reasoning.enabled=false`. Its
  sibling `resolveModelReasoningSupport` is deliberately
  separate: an UNDECLARED OpenRouter model exposes no reasoning controls and
  the request boundary rejects an effort without a matching static or live
  declaration, while its capability badge resolves to a visible `unknown`
  ("unverified") — never a silent yes/no. On an explicit model switch, clear an incompatible
  provider-wide effort override so the newly selected model uses its documented
  default; do not map it to a guessed nearest level.
- Reasoning-control placement: effort/level selection and the primary Thinking
  toggle live in the always-visible ComposerEffortControl chip beside the
  model picker in the composer control dock (packages/ui/src/
  packages/assistant-ui/src/composer-effort-control.tsx, backed by
  reasoning-effort-controls.tsx). The chip's trigger doubles as the readout
  ("Effort High" / "Thinking Off") so the active reasoning config is legible
  without opening anything (BST-948); the model menu itself is selection-only.
  The Controls menu's provider section is now "Output & Limits" (formerly
  "Reasoning & Output") and keeps only agent runtime limits, max output,
  the shared "Reasoning output" summary control, the Anthropic numeric thinking budget, and the
  Google include-thoughts debug toggle. Moved controls must emit
  byte-identical settings updates to the old panel sections (pinned by
  write-through tests in composer-effort-control.test.tsx).
- Static OpenRouter prices are estimates for pre-existing/unreported usage.
  Exact provider-reported cost is authoritative because routing, caching, BYOK,
  and provider tiers can make the catalog rate differ from the billed amount.
  Run-step metadata may additionally retain the bounded selected upstream
  provider name and reasoning-token count exposed by Mastra's official
  `providerMetadata.openrouter` shape, plus the non-negative first-text latency.
  Never log or persist reasoning content.
- The OpenRouter `Auto` output profile is sent explicitly because Mastra's
  provider otherwise expands an omitted limit to the model's full output
  ceiling, which can make OpenRouter reject even a tiny prompt during credit
  preflight. The automatic input-token budget MUST reserve the same resolved
  coding default (or the explicit configured output limit), not the model's
  full output ceiling. The Output & Limits panel
  shows the selected model's context/output metadata, the effective reservation,
  and the resulting input budget. Desktop selected models install a validated
  live OpenRouter snapshot for budgeting and label its `live`, `fresh-cache`, or
  `stale-cache` provenance; loading and failed lookups keep the built-in catalog
  visibly labeled, with the failure shown instead of silently falling back. An
  unknown OpenRouter model surfaces unavailable limits instead of guessing. An
  explicit model switch clears a provider-wide output
  override that exceeds the newly selected model's declared maximum; it never
  carries a hidden incompatible limit or silently clamps it. Explicit compatible
  user limits remain authoritative. While editing the numeric output field, an
  empty, fractional, below-minimum, or above-maximum value remains visible as an
  uncommitted draft with an inline error and disables send until corrected; it
  is never clamped or persisted. The range slider remains bounded to the known
  model limits.
- OpenRouter's canonical token-limit errors (`context_length_exceeded`,
  `max_tokens_exceeded`, and `token_limit_exceeded`) remain typed through the
  stream boundary. The visible bounded failure includes the canonical type.
  Every provider shares the adjacent forensic envelope:
  `run.failed.metadata.runError` contains only stable `code`, bounded `message`
  and `causeChain`, validated `httpStatus`, bounded `providerRequestId`, and a
  literal allowlist of rate-limit / retry-after / request-id response headers.
  Header extraction reads only the AI SDK `responseHeaders` field or an
  explicitly nested `response.headers` object; an unqualified top-level
  `headers` bag is treated as request metadata and ignored.
  Unknown or provider-private codes resolve to
  `mastra_agent_stream_provider_error` when the error carries provider evidence
  (httpStatus, providerRequestId, allowlisted response headers, or an AI SDK
  api-call error marker: `AI_APICallError`/`AI_RetryError` name or
  `url` + `requestBodyValues`) and to `mastra_agent_stream_local_error` when it
  carries none; an arbitrary upstream `provider_code` is never persisted.
  Neither fallback code is ever prefixed onto the visible OpenRouter detail —
  only stable typed codes are. Request/response bodies, request headers, URLs,
  secrets, generic provider metadata, and retry-attempt data are excluded
  rather than
  sanitized after the fact. Consumers use the exported
  `readProviderRunError`/`isProviderRunError` boundary instead of shape-guessing
  event metadata.
- Desktop exposes `GET /assistant/openrouter-model?model=<provider/model>` for
  selected-model metadata. It resolves the stored OpenRouter key in main,
  requests the official single-model endpoint, validates exact model identity,
  positive context/output limits, bounded supported parameters, and the full
  published reasoning-capability object, and keeps a bounded five-minute
  in-memory cache. A refresh failure may return a prior
  snapshot only as explicit `stale-cache` data with a warning; a first failure
  is a visible 502. The renderer validates the assistant-server snapshot before
  using it for the selected model's context meter, derived input budget, and
  output control maximum. A configured output limit above the live maximum, or
  an input limit above the derived live effective budget, disables send with an
  explicit correction message. Validation uses the effective request setting,
  including a Prompt Workbench draft `modelSettings.maxOutputTokens` override.
  An impossible persisted output reservation keeps the settings panel available
  for repair instead of throwing during render; the endpoint never silently
  mutates the registry.
  Qwen3.8 Flash's fixed `qwen/qwen3.8-flash` route is a documented exception to
  treating the Models API budgets as independently authoritative: aggregate
  metadata can advertise wider limits than this route's 1,000,000-token context
  and 131,072-token output ceilings. `mergeCatalogBudgetCeilings` therefore
  clamps this exact route's live context to the static catalog ceiling and its
  output to the minimum of the live output when present, the catalog output, and
  the merged context. The final context cap keeps a missing live output value
  from producing an invalid snapshot whose output exceeds context. Do not apply
  this route-specific rule to every catalog model without equivalent fixed-route
  evidence; other static entries remain fallbacks that live metadata may refine.
  The static Qwen3.8 Flash definition also records its exact text/image/video
  input and text output modalities; `vision` remains the separate image-gating
  projection. Paired coverage:
  `apps/desktop/src/__tests__/assistant-server/openrouter-model-metadata.test.ts`
  and
  `packages/assistant-contract/src/__tests__/provider-registry-frontier-models.test.ts`.
