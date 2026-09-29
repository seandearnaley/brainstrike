# Reasoning depth and visibility — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". The two independent reasoning dimensions and the Anthropic thinking/effort ladders.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 578-649); append rather than
rewrite.

---

- Reasoning has two INDEPENDENT dimensions, and they must not be re-conflated
  (BST-840). DEPTH is a budget concern (`reasoningEffort`, `anthropicEffort`,
  `googleThinkingLevel`, the OpenRouter auto profile). VISIBILITY is a UX
  concern — whether the provider returns the reasoning at all — and is owned by
  the single cross-provider `reasoningVisible` setting, resolved by
  `packages/assistant-contract/src/reasoning-visibility.ts` (defaults to
  visible). Each provider projects it onto its own wire field:
  `openai.reasoningSummary`, `anthropic.thinking.display`,
  `google.thinkingConfig.includeThoughts`, `openrouter.reasoning.exclude`.
  Three hard rules: visibility only ever MODIFIES a reasoning request that is
  already being made (cleared settings must still produce NO provider options);
  output is never suppressed/summarized for reasoning that is switched off; and
  the OpenRouter VISIBLE path adds NO field at all, because OpenRouter already
  returns reasoning and `provider.require_parameters` narrows routing to
  endpoints supporting every supplied parameter — an unconditional extra field
  would shrink the eligible upstream pool on every request. Only the OpenRouter
  opt-out adds `exclude: true`. Do NOT reintroduce a default
  `openrouter.reasoning.summary`: it is not part of OpenRouter's documented
  reasoning object (`effort`, `max_tokens`, `exclude`, `enabled`).
  Provider-specific keys remain valid escape hatches and win when explicitly
  set — and each one's control must render the RESOLVED value, not the raw key,
  or it reports stale state (the Google include-thoughts switch and the
  OpenAI/OpenRouter summary select both do this).
- The Anthropic Thinking toggle is AUTHORITATIVE for "is Claude thinking".
  Because a model-supported `anthropicEffort` implies adaptive thinking,
  switching the toggle off clears the effort as well as the budget; otherwise
  the runtime keeps requesting thinking while the switch reads unchecked.
- Anthropic thinking mirrors the installed `@ai-sdk/anthropic` discriminated
  union: `adaptive` (carries `display`, whose provider-side default is
  `omitted`), legacy `enabled` + `budgetTokens`, and `disabled`. An explicit
  budget pins the legacy form; otherwise a supported effort emits `adaptive`.
  The `AnthropicEffort` TYPE spans `low|medium|high|xhigh|max`, in step with
  the SDK enum, and is declared identically in BOTH
  `packages/assistant-contract/src/runtime-data.ts` and
  `packages/agent/src/types.ts` (the latter is what actually hands
  `providerOptions` to the SDK, and the boundary is structural — a narrower
  type there diverges SILENTLY). The OFFERED ladder is now declared per model
  in `LlmModelDefinition.anthropicReasoning` (BST-847), typed `AnthropicEffort`
  and separate from the OpenAI-vocabulary `reasoning` block. It is recorded
  from vendor documentation, never derived from union membership: Fable 5,
  Opus 5, Opus 4.8, and Sonnet 5 offer `low|medium|high|xhigh|max`; Sonnet 4.6 offers
  `low|medium|high|max` (NO `xhigh`). Each defaults to `high`. Haiku 4.5
  declares NO effort ladder: effort is unsupported, while thinking keeps the
  legacy `enabled` + `budgetTokens` form. Sources, retrieved **2026-09-04**:
  https://platform.claude.com/docs/en/build-with-claude/effort and
  https://platform.claude.com/docs/en/about-claude/models/overview.
  Opus 5 rejects thinking disabled with `xhigh` or `max`; the supported-effort
  path emits adaptive thinking. Switching Thinking off clears effort and budget;
  for Opus 5 only, cleared settings explicitly emit `thinking.type: disabled`
  because omission enables thinking by default on this model. Other models keep
  their existing omission behavior. Its
  direct catalog row is seeded disabled (migration 116), preserving existing
  user toggles. Pricing includes $10/MTok for one-hour cache writes, retained
  here because the registry represents only the five-minute cache-write rate.
  `resolveReasoningControlsAvailability` reads the declared ladder/default;
  Haiku gets an empty ladder so its Effort row disappears while its Thinking
  toggle remains. A missing or uncatalogued id (direct Anthropic uses the
  registry model allow-list, with no custom-model option, so this is the
  no-selection edge) gets the SAME empty-ladder shape, not `available: false`:
  the request builder still sends a persisted legacy budget for such an id,
  and the toggle is authoritative for "is Claude thinking", so it must stay
  visible and clearable; only the ladder is withheld.
  `buildAnthropicOptions(modelName, settings)` treats an effort outside the
  model's ladder, including no ladder or no registry row, as ABSENT: no effort
  and no derived adaptive thinking, never a neighbouring effort. An explicit
  legacy budget still survives independently. Controls display rejected
  persisted efforts as Auto and do not count them as active thinking.
  `reconcileAnthropicSettingsForModel` strips unsupported efforts on explicit
  switches to declared models, preserves budgets/unrelated settings and
  identity when unchanged, and leaves uncatalogued models alone (the Bedrock
  rule). The global-switch update key list includes `anthropicEffort` so its
  removal persists as `anthropicEffort: undefined`.
