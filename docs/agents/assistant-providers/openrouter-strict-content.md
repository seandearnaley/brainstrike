# OpenRouter strict-content gateway and billed cost — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". Why the `qwen/*` gateway exists and why a missing billed cost records UNKNOWN.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 526-577); append rather than
rewrite.

---

- OpenRouter is configured through Mastra's `openrouter/<provider>/<model>`
  model-router IDs, not a generic `createOpenAI({ baseURL })` client. The
  factory materializes the `ModelRouterLanguageModel` itself and injects the
  strict-content gateway
  (`packages/agent/src/providers/openrouter-strict-content.ts`): the OpenRouter
  chat serialization emits `content: text || null` for assistant messages, so a
  replayed tool-call-only assistant turn reaches the wire as `content: null`,
  which Alibaba-hosted `qwen/*` models 400 on
  (`invalid_parameter_error: The content field is a required field.`,
  field failure 2026-08-16). The gateway CLAIMS only strict-content model
  families (`qwen/*`) — every other OpenRouter model still resolves through
  Mastra's own models.dev gateway untouched — and resolves them via the same
  `@openrouter/ai-sdk-provider` version Mastra bundles (workspace-catalog pin,
  guarded against vendored-copy drift by
  `scripts/__tests__/openrouter-provider-mirror-contract.test.mjs`) with a
  fetch that coerces `null` → `""`. A blanket rewrite is unsafe because
  OpenRouter re-normalizes messages for Anthropic-style upstreams where an
  empty text block is itself invalid. Paired spec (incl. a request-equivalence
  test against the models.dev path):
  `packages/agent/src/__tests__/openrouter-strict-content.spec.ts`.
  Retire the gateway when the upstream converter stops emitting `null`. The
  official OpenRouter adapter preserves `providerMetadata.openrouter.usage.cost`;
  that exact billed amount is aggregated across `step-finish` parts and carried
  on the terminal message. Mastra emits approval/tool-suspension parts before it
  exposes that model step's `step-finish`, so a pause finish cannot claim an exact
  cost. On resume Mastra emits the deferred pre-pause `step-finish` before later
  model steps; the fresh resumed lifecycle aggregates all of them on the final
  message without double-counting. An abandoned pause therefore has no billed
  cost available through the observer stream. Mastra's terminal token usage is
  cumulative, but its terminal provider metadata repeats only the final step, so
  a missing cost cannot be repaired from the terminal metadata.

  **A MISSING COST RECORDS UNKNOWN; ONLY A MALFORMED ONE FAILS — do not
  relitigate.** OpenRouter reports no `usage.cost` for anonymous/stealth routes
  (`stealth/ox-alpha`, migration 107), so requiring one from every step failed
  EVERY such turn at the finish, discarding a completed answer over billing
  telemetry. Cost accounting is observability, and observability must not
  destroy the product it observes. An incomplete picture — no step reported, or
  only some did — therefore records the turn cost as UNKNOWN (omitted, stored
  null) with a visible `provider_billed_cost_unreported` warning that names the
  partial case and the amount it is discarding. Never zero, and never a partial
  sum presented as the total, which is the undercount the old rule was really
  guarding. A genuine `cost: 0` remains a MEASURED zero.

  MALFORMED metadata is loud but equally non-fatal. `readOpenRouterBilledCost`
  returns a three-way reading — `absent` | `malformed` | `reported` — rather
  than a number-or-throw, so the callers must handle the broken-contract case
  explicitly (nothing is coerced, and it cannot be swallowed the way a
  `try`/`catch` would). They log `provider_billed_cost_malformed` at ERROR and
  treat the step as unpriced, which resolves the turn to unknown. Absent is a
  fact about the route; malformed is a broken contract someone should fix.
  Neither destroys a completed turn, and neither becomes zero.
