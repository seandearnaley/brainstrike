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

---

**Always-on rows send `display` at Auto effort (BST-1804, 2026-09-22).**
Before this, a `mandatory` row with no chosen effort sent no `thinking`, on the
belief that adaptive thinking required an effort. Anthropic's Thinking page
(https://platform.claude.com/docs/en/build-with-claude/thinking) says the
opposite: on Opus 5.5, Fable 5.1 and Fable 5 thinking "is already on and needs
no configuration", `display` defaults to `"omitted"` on them, and the opt-in is
`thinking: {"type": "adaptive", "display": "summarized"}` with no effort. On
Opus 5.5 the text written between tool calls comes back as progress-update
`thinking` blocks, which are empty under `"omitted"` — so Auto-effort runs lost
that text. `"updates"` (beta `thinking-display-updates-2026-08-18`) is still not
emitted; `"summarized"` returns progress updates as well as reasoning
summaries. The Bedrock path is unchanged: Bedrock rows carry no always-on
marker, so Bedrock Auto sends no `reasoningConfig`.
Guards: `packages/app-shell/src/__tests__/anthropic-provider-options.test.ts`,
`packages/agent/src/__tests__/anthropic-always-on-thinking-display-wire.spec.ts`.
