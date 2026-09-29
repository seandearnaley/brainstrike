# Effort vocabulary declarations — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". Where each effort/level union is declared, and why the provider-options interfaces are not shared.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 650-724); append rather than
rewrite.

---

- The OpenAI-family effort vocabulary has exactly ONE declaration:
  `OPENAI_REASONING_EFFORT_VALUES` in `@brainstrike/types`
  (`assistant-provider-settings.ts`), with `OpenAiReasoningEffort` derived from
  it. `packages/assistant-contract/src/runtime-data.ts` and
  `packages/agent/src/types.ts` RE-EXPORT it, and the Hosted Web request
  boundary (`apps/web/src/server/web-assistant-runtime-schema.ts`) builds its
  `z.enum` from the same const, reached through `@brainstrike/agent/hosted-web`
  so the enum and the `RuntimeData.requestedReasoningEffort` it guards come from
  one source. Do NOT re-declare it. The contrast with `AnthropicEffort` is the
  whole point: that one mirrors a zod schema `@ai-sdk/anthropic` never exports
  as a value, so its three copies are unavoidable and are policed by
  `scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs`. The OpenAI
  copies were deleted, but the single const still mirrors an upstream
  vocabulary: the installed `@ai-sdk/openai` now ships `reasoningEffort` as a
  literal union in its chat-options declaration. Membership and the version
  annotated on the const (the ONLY place the pin lives — do not repeat the
  number here) are policed by
  `scripts/__tests__/ai-sdk-openai-mirror-contract.test.mjs` against the
  installed provider's `dist/index.d.ts`. This contract covers the platform
  `openai` provider's chat options only: the Responses-API `reasoningEffort` is
  an open `string`, not an enumerable oracle, and OpenRouter's cross-vendor
  values are still governed per model by `resolveReasoningControlsAvailability`,
  not by this contract. Because the same const types OpenRouter's per-model
  ladders, a WIDER finding (a value OpenAI's chat schema dropped) is a
  decision, not a deletion order: drop the value if no provider routes it, or
  split the OpenRouter vocabulary out of this const if OpenRouter still does.
  The const is union MEMBERSHIP, not an offered list — the
  `anthropicReasoning` per-model ladder ruling above is unchanged by it. What
  a given model offers stays in `resolveReasoningControlsAvailability`; never express an
  offered-list narrowing by narrowing this union.
  `EFFORT_TRACK_ORDER` in
  `packages/assistant-ui/src/reasoning-effort-controls.tsx` is deliberately NOT
  derived from it. It is a cross-provider display ranking typed
  `readonly string[]` precisely so an unranked value sorts last rather than
  being dropped from the track.
- `OpenAiReasoningSummary` and `GoogleThinkingLevel` follow the same rule and
  for the same reason: declared once in `@brainstrike/types`, re-exported by
  `packages/assistant-contract/src/runtime-data.ts` and
  `packages/agent/src/types.ts`. Neither has a values const, deliberately.
  `OPENAI_SUMMARY_OPTIONS` (`provider-settings-panel.tsx`) is typed
  `OpenAiReasoningSummary | 'off'` — its `off` entry is a UI sentinel, not a
  wire value, so the list cannot be derived from the union. Google keeps its
  offered lists in the same file as the type —
  `GOOGLE_FLASH_THINKING_LEVELS`, `GOOGLE_PRO_THINKING_LEVELS`, and the exact
  `GOOGLE_GEMINI_37_FLASH_THINKING_LEVELS` exception — selected per-model by
  `getGoogleThinkingLevels`. A separate "all values" const sitting beside them
  would still be precisely the offered-vs-membership confusion the
  `anthropicReasoning` offered-ladder ruling exists to prevent. That
  `GOOGLE_FLASH_THINKING_LEVELS` happens to list all four levels today is a fact
  about what earlier Flash models offer, not a definition of the type. Gemini
  3.7 Flash deliberately omits `minimal`, which its official model page says
  returns an error. The shared effort control must render any persisted Google
  level outside the selected model's ladder as `Auto` and keep rejected values
  out of its interactive options; `reconcileProviderSettingsForModel` clears
  that level on an explicit Google model switch. This keeps the visible control
  aligned with the request builder, which declines to send a rejected level.
- The provider-options INTERFACES (`OpenAiProviderOptions`,
  `GoogleProviderOptions`, `AnthropicProviderOptions`, `BedrockProviderOptions`,
  `LocalProviderOptions`,
  `OpenRouterProviderOptions`) are NOT shared between
  `assistant-contract/runtime-data.ts` and `agent/types.ts`, and that is not
  oversight: the contract's extend `RuntimeJsonObject` (a wire-side
  `Record<string, unknown>`) while the agent's extend `JSONObject` from
  `@ai-sdk/provider`, which is the constraint the SDK actually imposes on
  `providerOptions`. They are structurally parallel, not the same type. Unify
  them only by resolving that base-type split first. `BedrockProviderOptions`
  (BST-1354) follows the same rule and was added to BOTH files in one change.
  The base-type split shows through in one visible way: the AGENT-side
  `BedrockReasoningConfig` must be a type ALIAS (with a `biome-ignore` for
  `useConsistentTypeDefinitions`) because an interface member does not satisfy
  `JSONObject`'s string index signature — TS2411, the same reason
  `AnthropicThinkingOptions` is an alias — while the contract-side copy is an
  ordinary interface under `RuntimeJsonObject`. `BedrockReasoningEffort` is NOT
  duplicated: like the OpenAI-family vocabulary it is declared once in
  `@brainstrike/types` and re-exported by both.
