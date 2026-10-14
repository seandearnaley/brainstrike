# Sampling params on a default request — evidence

Supports `docs/agents/assistant-providers.md` § "Sampling params are never sent on a default request". The vendor rejections that drove the audit and the single path a sampling param can travel.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2242-2285); append rather than
rewrite.

---

Three vendors now reject or deprecate non-default sampling params on their
newest models — OpenAI `gpt-6-astra` (no custom `temperature`/`top_p`), Google's
2026-07-21 changelog (`temperature`/`top_p`/`top_k` deprecated on the latest
Gemini models), Anthropic Opus 4.7+ (non-default values return HTTP 400, repeated
verbatim on AWS's Claude Fable 5.1 Bedrock model card). The audit ruling, which
new provider or runtime work must preserve:

- **A default request carries no `temperature` / `top_p` / `top_k` on any of the
  five adapters** (openai, anthropic, google, bedrock, openrouter). No
  `createProvider` case passes sampling settings at construction.
- **There is exactly one path by which a sampling param can reach a hosted
  provider**: `RuntimeData.modelSettings` → Mastra's per-call `modelSettings` →
  the AI SDK adapter. Both Brainstrike-owned producers on that path emit
  `maxOutputTokens` and nothing else: `buildModelSettings`
  (`packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts`) and
  `buildModelSettingsOption`
  (`packages/agent/src/mastra/runtime-assembly/stream-options.ts`), whose
  openrouter/local backstops only ADD a `maxOutputTokens` ceiling.
- **`RuntimeModelSettings`
  (`packages/assistant-contract/src/runtime-data.ts`) has no `topK` field**, so
  `top_k` is unreachable on every hosted route. Adding one would put us on the
  wrong side of all three vendor rules — do not add it without reading this
  section.
- The **Prompt Workbench** (`buildPromptModelSettings`,
  `packages/app-shell/src/prompt-workbench-shared.ts`) is the only surface that
  can produce a user-set `temperature`/`topP` at all.

**BST-1701 — a dropped value is now REPORTED (was: silently dropped).** On a
model that rejects sampling params the installed adapter does not 400 and does
not forward the value: it DROPS it and reports an `unsupported` entry on the
call's `warnings`. That array had no consumer, so the user's explicit setting
vanished with no notice. It is now surfaced; see "Provider call warnings" below.
The characterization test above is the "before" half and stays as-is — nothing
about what is SENT changed.

Guarded by `packages/agent/src/__tests__/sampling-params-wire.spec.ts`
(per-adapter assertion on the SERIALIZED REQUEST BODY through the real
`createProvider`, recursive scan in both casings because the adapters nest these
fields differently) and the BST-1699 block in
`packages/agent/src/mastra/runtime-assembly/__tests__/stream-options.spec.ts`.
The wire spec's fetch capture must decode BOTH valid call shapes —
`fetch(url, init)` and `fetch(new Request(url, init))` — since reading only
`init.body` records `null` under the Request shape and turns the suite green on
exactly the adapter drift it exists to catch.
