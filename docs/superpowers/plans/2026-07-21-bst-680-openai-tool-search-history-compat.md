# BST-680 OpenAI tool-search history compatibility

## Outcome

Unblock OpenAI native tool-search qualification without waiting for an AI SDK
release and without reintroducing `patchedDependencies`.

## Design

Add one OpenAI-only `processLLMRequest` processor before the token limiter. For
persisted provider-executed `tool_search` results, copy the response-preserved
`providerMetadata.openai.itemId` into the `providerOptions.openai.itemId` field
that installed `@ai-sdk/openai` 4.0.8 already consumes. The processor rewrites
only the transient provider prompt, never Mastra messages or durable rows.

If both fields contain different non-empty IDs, fail visibly. If the supported
provider option is already present, preserve it. Other providers, tools, parts,
and metadata remain byte-for-byte untouched.

## Red/green proof

1. Capture the exact OpenAI Responses request from a persisted `tool_search`
   call/output pair. Red: installed AI SDK repeats the call ID for the output.
2. Green: the transient processor produces distinct `tsc_...` and `tso_...`
   item references without mutating its input.
3. Pin conflict rejection, no-op behavior, processor ordering, reload history,
   and the existing provider-native capability canary.
4. Run the focused package suite, then the root lint/type-check/build/test gate.
5. Run one live GPT-5.6 native semantic lookup through Desktop/CDT. Do not widen
   the PR into the full rollout matrix unless this foundational gate passes.

## Removal

Track vercel/ai#17667. Delete this processor and its wiring once Brainstrike
consumes an AI SDK release whose converter reads tool-result
`providerMetadata.openai.itemId` directly and the captured-request test stays
green without the processor.
