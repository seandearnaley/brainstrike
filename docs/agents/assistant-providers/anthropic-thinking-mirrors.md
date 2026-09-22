# Anthropic thinking mirrors — evidence

Supports `docs/agents/assistant-providers.md` § "Anthropic `thinking` mirrors: what is deliberately NOT mirrored". The two standing rulings about what the hand-mirrored union does and does not carry.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2218-2238); append rather than
rewrite.

---

`AnthropicThinkingOptions` in `packages/agent/src/types.ts` and
`packages/assistant-contract/src/runtime-data.ts` hand-mirror the provider's
`thinking` discriminated union, guarded by
`scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs` (BST-1310). Two
standing rulings, recorded here because the next person to hit a type error will
read this file before that test:

- **`adaptive.display` includes `'updates'`** as of `@ai-sdk/anthropic` 4.0.49.
  The mirrors carry it because being strictly narrower than the provider is the
  bug class the guard exists to catch. Nothing emits it yet —
  `resolveReasoningVisible` still produces only `'omitted' | 'summarized'` — and
  the provider attaches a `thinking-display-updates-2026-08-18` beta header for
  it, so a picker generated from this union would offer a value that can fail
  against non-beta accounts. Derive pickers from an explicit const array, not
  from the mirrored type.
- **`{ type?: never; blockBinding }` is NOT mirrored.** 4.0.49 added a second,
  *undiscriminated* member alongside the discriminated union. It carries no
  `type` literal, so it is outside the guard's scope by construction, and
  adopting `blockBinding` is a feature decision about what the app emits rather
  than drift the guard is entitled to force. The mirrors are therefore knowingly
  narrower in that one dimension.
