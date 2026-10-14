# OpenAI history compatibility seams — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". The tool-search and duplicate-item provider-boundary seams, plus the AI SDK dependency-closure record.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 801-878); append rather than
rewrite.

---

- OpenAI hosted `tool_search` response history has a narrowed provider-boundary
  seam in `openai-tool-search-history-compat.ts`. **Its recorded removal
  condition — "remove the seam after consuming an AI SDK release containing
  vercel/ai#17667" — was unsatisfiable as written and is retired (BST-1310).**
  That PR was closed UNMERGED on 2026-07-22 when its issue (vercel/ai#17666) was
  resolved by other means, so no release will ever "contain" it. The behaviour it
  described shipped instead in `@ai-sdk/openai` 4.0.18 (changeset `bc43dc2`,
  "Preserve stored tool search output item IDs from provider metadata"), which
  #2462 consumed at 4.0.42. Measured, not inferred from the version jump: the
  same persisted prompt serializes as two identical `tsc_` item references on
  4.0.8 and as distinct `tsc_`/`tso_` references on 4.0.42.
  The RESULT half of the seam is therefore gone. Two things remain, and neither
  is what #17667 was about. (a) The CALL is still canonicalized: Mastra v2
  persists a completed provider tool as one invocation and hydrates the result's
  provider metadata onto the call as well, so the call advertises the `tso_`
  OUTPUT id — and the responses converter trusts
  `providerMetadata.openai.itemId` on a `tool-call` part in 4.0.8 and 4.0.42
  alike, which collapses the call and the output into one `item_reference`. That
  is a Mastra persistence defect, not an AI SDK one; it has NO upstream
  version-based removal condition, so do not attach one. (b) The output's item
  reference is asserted DISTINCT from its call's, not merely present. The
  failure guarded against is duplication, and two routes reach it: output
  history carrying no item ID at all (the converter's last resort is
  `?? part.toolCallId`, a silent fallback that emits the call's id as the
  output's), and an output whose recorded ID already IS the call's — the
  SYMMETRIC form of the same Mastra hydration behind (a), landing the call's
  `tsc_` on the result. The second is the quiet one: nothing is absent and the
  two recorded IDs agree with each other, so a presence check waves it through
  and OpenAI 400s far downstream. Measured against the installed SDK rather than
  reasoned about — that prompt serializes as two identical `tsc_` references.
  Do NOT weaken this back to an existence check. The processor still runs
  OpenAI-only, and still never mutates durable history. Do not replace either
  half with `patchedDependencies` or a lossy history filter.
  The condition is now self-detecting rather than doc-resident:
  `openai-tool-search-history-compat.spec.ts` asserts ALL THREE upstream
  behaviours directly against the installed SDK — the preserved output ID, the
  call-side collision, and the symmetric output-side collision — so the release
  that fixes the remaining defect turns a test red instead of waiting for
  someone to re-read this page. Only the CALL half rewrites anything now, which
  is why the seam's one log line counts "call item references".
- OpenAI Responses item-id uniqueness has a second provider-boundary seam,
  `openai-duplicate-item-compat.ts` (BST-1095): when durable history holds the
  same assistant response under two message ids (Mastra sealed-boundary re-key
  double-persistence), the OpenAI-only `processLLMRequest` processor drops the
  stale duplicated `rs_`/`fc_`/`call_` references from the transient prompt so
  the request no longer 400s with "Duplicate item found" — keeping the result
  structurally valid: reasoning/text ids keep their newest occurrence, tool
  call+output survive as the newest complete pair (covering assistant-carried
  provider-executed results, e.g. native web search), and orphaned trailing
  reasoning in edited messages is swept. Within-message repeats (multi-summary
  reasoning) are untouched; durable history is never mutated. See
  `docs/agents/assistant-runtime.md` for its position in the input-processor
  chain.
- **AI SDK dependency-closure facts, recorded at #2462 (BST-1310).** Two things
  changed under the provider bumps that the version lines did not show.
  **`undici@7.28.0` is now in the agent's runtime closure.**
  `@ai-sdk/provider-utils` added it between 5.0.5 and 5.0.27, so the path
  `packages/agent` → `@ai-sdk/{anthropic,google,openai}` →
  `@ai-sdk/provider-utils@5.0.27` → `undici@7.28.0` is a plain transitive
  runtime dependency now — a full Node HTTP stack (`node:net`, `node:http`,
  `node:stream`, and the native WASM llhttp parser). That is fine on the Node
  side and must stay off the browser side, which is R2 in
  `docs/agents/mastra-boundary.md`. Verified rather than assumed: `apps/web` and
  `apps/desktop` alias only the five browser-safe agent subpaths listed in
  `packages/agent/config/browser-safe-subpath-aliases.mjs` (`/client`,
  `/local-llm`, `/pglite-mastra-memory/schema`, `/provider-metadata`,
  `/tool-metadata`), and none of those five imports `@ai-sdk/*`, `undici`, or a
  `node:` builtin. Keep it that way — a browser-safe subpath that reaches an
  `@ai-sdk` module now drags a Node HTTP stack into the renderer bundle.
  **The v4 `@ai-sdk/provider` line still has TWO copies, not one.** 4.0.7 (the
  `packages/agent` pin, the three providers, and
  `@ai-sdk/provider-utils@5.0.27`) and 4.0.4 (`@mastra/core@1.57.0`'s
  `@ai-sdk/provider-v7` alias, via `@ai-sdk/provider-utils@5.0.13`). What #2462
  removed was the agent-only THIRD revision — 4.0.2, which the old
  `provider-utils@5.0.5` pulled in — and that third copy was the actual hazard,
  because it split the provider types the agent itself compiles against. The
  remaining 4.0.4 lives entirely inside Mastra's aliased sub-tree and is not a
  regression to chase.
