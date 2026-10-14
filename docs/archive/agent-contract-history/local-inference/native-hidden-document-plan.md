# Native hidden document batch transport

Document batches require a verified immutable renderer plan. The hidden host
uses `SimpleEmbeddingService.generateEmbeddings`, preserving document prompts,
input order and the existing tokenizer/length batching rules. The wire admits
1–64 nonempty texts and preserves their whitespace. Fused MiniLM remains capped
at 256 tokenizer tokens including special tokens, legacy MiniLM at 512, with the
existing 8192 padded-token ceiling per inference batch.

## API and ownership

- `generateDesktopDocumentEmbeddings(payload, {signal})` in
  `apps/desktop/src/renderer/document-embeddings.ts` is the caller adapter.
- Payload: `{dimensions, inferencePlan, modelId, modelKey, texts}`. The mandatory
  plan is `PinnedEmbeddingWorkerPlan`; payload model/dimensions must agree.
- The public preload carries `documentEmbeddings(payload, {requestId})` and
  `cancelDocumentEmbeddings(requestId)`. Only a plain token crosses contextBridge;
  AbortSignal remains in its renderer. Main accepts the authorized visible
  sender/frame, scopes cancellation by sender plus token, and removes the sender
  destruction listener when the request settles. Unknown/settled token cancels
  are harmless because completion can race cancellation; they never target a
  different sender.
- Main manager cancellation/timeout sends the matching hidden runtime/request
  identity, and response correlation includes both fields. Document and query requests share the existing admission count and
  renderer FIFO/service cache/physical owner. A canceled queued batch never
  prepares a service; active cancellation and Stop retain ownership until the
  actual service promise settles. The existing 60-second response deadline and
  Stop/shutdown/reset bounds are unchanged.
- Every result is checked for model, revision, actual device/dtype, no fallback,
  dimensions, finite values and exact count before publishing any success.
  Main and the renderer caller separately enforce result count/dimensions.

## Local reproduction, 2026-10-03

The payload RED control reproduced the missing document decoder. Running the new
production-boundary acceptance test against the original `3eae0e1` runtime failed
because it had no document subscription. Evidence:
`/tmp/brainstrike-document-dto-red.log` and
`/tmp/brainstrike-document-runtime-red.log`. The original runtime was restored
immediately after that baseline execution; no result-limit guard was changed.

Focused source tests cover document rather than query generation, unchanged
text/order, no catalog/preference lookup, invalid second-result metadata/vector,
count refusal, queued cancellation, active cancellation with retained ownership,
stale-runtime isolation and Stop joining settlement. Caller/main tests cover
startup abort, pre-aborted refusal, sender/frame isolation, duplicate token refusal,
listener cleanup and visible cancellation-delivery failures including a result race.

- Focused desktop transport/lifecycle/preload suite: 239 tests in 16 files passed,
  before final correlation/cancellation-race additions; the affected manager/caller
  delta suites then passed 13 tests in 2 files.
- `pnpm --filter @brainstrike/desktop type-check`: production/main, 643 selected
  tests, E2E and 649 strict Effect diagnostic files passed again after the final
  correlation/cancellation-race additions. Normal commit hooks also recheck the
  changed dependency closure.
- `pnpm --filter @brainstrike/desktop build`: dependency prebuild, renderer cycle
  guard and main/preload bundling passed.
- `pnpm exec node apps/desktop/scripts/probe-pinned-document-embeddings.mjs`:
  actual built Electron preload → main IPC → hidden renderer → production scalar
  worker passed legacy WASM q8/fp32 at
  `751bff37182d3f1213fa05d7196b954e230abad9` and fused WASM fp32 at
  `aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f`.
- `PINNED_DOCUMENT_PROBE_DEVICE=webgpu pnpm exec node apps/desktop/scripts/probe-pinned-document-embeddings.mjs`:
  fused WebGPU fp16 passed at that same immutable fused revision.

Each real profile generated two three-document batches, including a long
700-token input and duplicate text. All vectors were 384-dimensional, finite and
nonzero. Repeat and duplicate maximum differences were zero; distinct inputs
produced different vectors. Actual device/dtype matched with fallback=false;
the backend required the exact completion revision. Omitted and `main` revisions
were visibly rejected. Evidence logs:
`/tmp/brainstrike-document-real-wasm.log` and
`/tmp/brainstrike-document-real-webgpu.log`.

This is Mac arm64 built-app document transport/worker proof. It does not qualify
packaged/cross-platform inference, native indexing/vector commits/search,
full regression, resource use or matched-corpus throughput. Composition owns
profile enablement and canonical producer integration. No new persistent store
was introduced. CI is disabled due to cost; validation must run locally.

## Global IPC manifest limitation

The three document protocol registrations are explicitly classified in
`__tests__/helpers/manual-ipc-inventory.ts`. The global manifest has two preserved
base failures: `index-search.contract.ts` is absent from the pinned contract list,
and its four native search invokes are not registered by the base main module.
The unchanged original IPC adapter/inventory reproduced both failures, while the
new inventory removed every document-channel delta. Logs:
`/tmp/brainstrike-document-manifest-baseline.log` and
`/tmp/brainstrike-document-manifest-green.log` (the latter remains red despite its
filename). Composition owns that missing native search registration; it was not
modified or hidden in this document batch.

The existing sender-authorization/registry plus caller suites passed 352 tests in
4 files; those include the 5 caller tests and overlap the focused inventory.
Final correlation changes rebuilt main/preloads and repeated the real fused
WebGPU document probe in `/tmp/brainstrike-document-real-webgpu-final.log`.
