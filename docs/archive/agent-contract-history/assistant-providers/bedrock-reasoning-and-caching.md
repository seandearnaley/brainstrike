# Bedrock prompt caching and reasoning dialects — evidence

Supports `docs/agents/assistant-providers.md` § "Amazon Bedrock". Registry-driven caching, the three reasoning dialects, `bedrockEffort`, and Converse message hygiene.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1653-1742); append rather than
rewrite.

---

- **Prompt caching is REGISTRY-driven (BST-1354, closing finding 7).** Wrapper
  selection reads `LlmModelDefinition.promptCaching` (`'anthropic' | 'bedrock'`)
  through the single seam
  `packages/agent/src/providers/prompt-caching.ts`; the factory no longer
  chooses by provider id, and NEITHER the factory nor the wrappers may match on
  a model-id substring (pinned by `prompt-caching-selection.spec.ts`). Bedrock's
  catalog is exactly why: Claude and Nova v1 accept Converse `cachePoint`
  checkpoints, Llama/DeepSeek/Nova 2 Lite do not, and an undeclared route is
  sent NO breakpoints rather than a guessed dialect. Every first-party
  Anthropic row declares `'anthropic'`, so that path is unchanged.
  `wrapBedrockModelWithPromptCaching` places MESSAGE-level
  `providerOptions.bedrock.cachePoint = {type:'default'}` on the first 2 system
  plus last 2 non-system messages (OpenCode's policy) — exactly saturating
  AWS's four-checkpoint ceiling, honoring any pre-existing explicit cachePoint
  under either the `bedrock` or `amazonBedrock` spelling, and carrying the same
  two documented Proxy limits as the Anthropic wrapper. Message level (not
  content-part level) because the SDK reads `message.providerOptions` uniformly
  for system, user and assistant.
- **Cache PRICING is no longer Anthropic-first-party-only.** The old
  provider-registry-pricing pin ("non-Anthropic providers declare no cache
  rates") is gone; the invariant is now that a cache RATE and a
  `promptCaching` dialect travel together. Anthropic-on-Bedrock bills the
  Anthropic multipliers (read 0.1x, write 1.25x of input); Amazon Nova bills
  read at 0.25x and writes at the ORDINARY input rate, so its
  `cacheWritePerMTok` is deliberately absent — absence means "no premium",
  never "unknown".
- **Reasoning is per-model, by DIALECT (BST-1354).**
  `LlmModelDefinition.bedrockReasoning` is `'adaptive' | 'budget-tokens' |
  'max-reasoning-effort'`, and the dialects do not follow vendor lines:
  newer Claude routes REJECT `thinking.type:'enabled'` and need adaptive
  (`thinking:{type:'adaptive',display}` plus the effort in its own
  `output_config.effort`), Claude Haiku 4.5 keeps the legacy
  `{type:'enabled',budgetTokens}` form, and Amazon Nova takes
  `{type:'enabled',maxReasoningEffort}` with no token budget at all. The
  declaration is pinned — and each dialect's wire shape asserted — by
  `packages/agent/src/__tests__/bedrock-reasoning-dialect-contract.spec.ts`
  against `getModelCapabilities()` from **`@ai-sdk/anthropic/internal`**. Note
  the package: that table is the real source of truth and
  `@ai-sdk/amazon-bedrock` merely imports it, so an **`@ai-sdk/anthropic`**
  bump can move a Bedrock route between dialects with the Bedrock package
  untouched — re-check the pin on either upgrade. The pin asserts
  `isKnownModel` too, because the table DEFAULTS an unrecognized id to
  `supportsAdaptiveThinking: true`; without that assertion a typo'd or retired
  registry id would satisfy the adaptive branch having verified nothing. Every
  Claude-family row is REQUIRED to declare a dialect (absence fails rather than
  skips), and no non-Anthropic route may claim a Claude-only dialect.
  Nova v1 (pro/lite/micro) documents caching but NOT reasoning, so those rows
  declare `promptCaching` with no `bedrockReasoning` — the two capabilities are
  independent.
- **Bedrock reasoning DEPTH has its own settings key, `bedrockEffort`.** Not a
  reuse of `anthropicEffort`: Bedrock exposes no free-form thinking BUDGET, so
  the Anthropic pair would leave the Thinking toggle writing
  `anthropicThinkingBudgetTokens` that the Bedrock request builder drops — a
  switch reading on while nothing is requested. For the same reason
  `ReasoningControlsAvailability` gained its own `family: 'bedrock'` (effort
  submenu, no thinking toggle) rather than borrowing the Anthropic family.
  `BEDROCK_REASONING_EFFORTS` is the per-dialect OFFERED list, deliberately
  narrower than the type — same offered-vs-membership discipline as
  the per-model `anthropicReasoning` ladders. An effort the selected route does
  not offer yields NO provider options rather than a request the API would reject.
- **Visibility (BST-840) projects onto Bedrock through
  `resolveBedrockReasoningDisplay`** (`reasoning-visibility.ts`), which maps the
  shared switch to `reasoningConfig.display` (`summarized`/`omitted`, same
  vocabulary and same provider-side `omitted` default as first-party
  Anthropic). The SDK honors `display` ONLY for the `adaptive` dialect, so it is
  attached there alone — mirroring the existing first-party rule that the legacy
  budget form carries no `display`. That is an ABSENT knob on the other two
  dialects, not an ignored setting.
- **`providerOptions.bedrock` is generation-only — no stream-boundary
  stripping.** Unlike `providerOptions.ollama`/`.lmstudio` (transport config:
  `baseUrl`/`apiToken`, which would serialize into the request body), the
  bedrock namespace carries only `reasoningConfig`, which is precisely what
  Mastra must forward to the SDK. So it is deliberately NOT added to
  `buildGenerationProviderOptionsOption`'s strip list in
  `runtime-assembly/stream-options.ts` (moved out of `agent-streaming.ts` by
  BST-1649).
  If a future Bedrock ticket adds transport-ish fields (endpoint override,
  credentials), replicate the ollama/lmstudio stripping at that point.
- **Replayed history is normalized for Converse
  (`bedrock-message-hygiene.ts`).** A Bedrock-scoped input processor, installed
  beside the OpenAI compat seams and running after them, drops empty text parts
  and empty reasoning parts, keeps reasoning that carries
  `providerOptions.bedrock.signature`/`.redactedData` (the provider's proof that
  thinking happened), drops messages left with no content, and rewrites
  tool-call ids outside `[a-zA-Z0-9_-]` to `_`. The id charset is an API-level
  Converse `toolUseId` constraint rather than a model-family quirk, so it
  applies to every Bedrock route and is a no-op on already-valid ids; calls and
  their results rewrite deterministically so pairs stay matched. Like every
  compat processor it is a TRANSIENT provider-boundary rewrite and never
  touches durable history.
