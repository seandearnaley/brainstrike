# Mastra 1.71 upstream issue and PR drafts

Supports `docs/agents/mastra-boundary.md` § "First-class subagents: host lifetime decision".

These drafts have not been submitted. Reproductions target core 1.71.0 and memory
1.32.1 on Node 26.8.2/macOS arm64. Scripted model responses eliminate provider
variability; native execution and storage remain real. The retained tests are
executable from this checkout with:

```sh
pnpm --filter @brainstrike/agent exec vitest run --config vitest.integration.config.mts \
  src/__tests__/background-cleanup.integration.spec.ts \
  src/__tests__/mastra-background-contract.integration.spec.ts \
  src/__tests__/delegation-lifecycle.integration.spec.ts \
  src/__tests__/semantic-recall-lifecycle.integration.spec.ts
```

Run the named vendor regressions on a pristine dependency installation to observe
RED, and on the explicit pnpm patch to observe GREEN. The native `untilIdle` EOF
case is a capability characterization, not a bug assertion. Host-coordinator
acceptance cases likewise must not be presented as library-only reproductions.

## 1. Background cancellation/shutdown does not join all owned work

**Issue title:** Background task completion can precede executor cleanup and
workflow deletion; shutdown can acknowledge while deletion is still pending.

**Expected/observed:** Hold a public storage adapter's workflow-delete operation
with a deferred promise after a task completes. `await mastra.shutdown()` should
remain pending until that promise settles. Stock 1.71 acknowledges early. Reject
the delete instead: the failure must reach the shutdown caller, with no orphan
rejection. Separately hold a tool's `finally` block and call public task `cancel`:
acknowledgment must join it, while another task remains runnable.

**Reproduction:** All three `background-cleanup.integration.spec.ts` cases, the
held-cleanup deadline case in `mastra-background-contract.integration.spec.ts`,
and selected cancellation in `delegation-lifecycle.integration.spec.ts`. The
storage adapter injects the delay/failure at its documented database boundary;
no Mastra object is monkeypatched and no application agent loop is involved.

**PR proposal:** In `packages/core/src/background-tasks/manager.ts` and its workflow
implementation, retain the promises for actual executor and workflow lifetimes.
Await workflow deletion in the dispatch/resume chain. Cancel joins the task's
owned work even if its durable status already became terminal. Shutdown drains
those promises within its existing deadline and rejects accumulated cleanup
errors. Tests cover normal completion, suspension/cancel, deletion rejection,
deadline and pubsub-flush failure. No new public API is needed.

**Related reports checked:** [#20193](https://github.com/mastra-ai/mastra/issues/20193)
(closed; initial manager resource cleanup) and
[#22863](https://github.com/mastra-ai/mastra/issues/22863)
(closed; evented-worker/pubsub shutdown ordering). This draft must distinguish
the residual executor/deletion promise join on stable 1.71 from those reports.
[PR #23024](https://github.com/mastra-ai/mastra/pull/23024) hardened manager
routing/cancellation and is already merged. [PR #24418](https://github.com/mastra-ai/mastra/pull/24418)
adds public `context.background.adopt({ completion, cancel })` for plugin-owned
operations, registered before a tool returns. It does not replace ownership of
the native workflow's later snapshot deletion. Its process-local adoption handle
also cannot represent a new durable human decision after that tool has parked;
it is not a host reservation API for the demonstrated `untilIdle` EOF boundary.

## 2. Native background tool output has two delivery routes

**Issue title:** One background `ToolStream.custom` write is emitted through both
task output and the dispatching parent turn.

**Expected/observed:** A child writes one custom data part while its parent turn
is deliberately held open. Stock 1.71 sends the same emission to `onProgress` and
the parent `outputWriter`; parent persistence can consequently contain child
content. Two intentional identical child emissions must still remain two.

**Reproduction:** `delivers child data once through its native task without parent
contamination` in `delegation-lifecycle.integration.spec.ts`, plus the raw-output
case in `mastra-background-contract.integration.spec.ts`.

**PR proposal:** In
`packages/core/src/loop/workflows/agentic-execution/tool-call-step.ts`, the native
background executor should use its task's `onProgress` route once. Preserve the
ordinary foreground writer path. Test both the live stream and persisted child/
parent histories; do not deduplicate by content or suppress repeated user data.
Searches for `onProgress outputWriter` found no matching issue; broad background
output searches returned adjacent lifecycle reports, not this exact reproduction.

## 3. Delegation replaces the child's configured abort signal

**Issue title:** A foreground subagent's default abort signal is replaced by the
supervisor signal, preventing selected-child cancellation.

**Expected/observed:** Configure a child `Agent` default abort signal, delegate
through the native `agents` option, then abort that child while the parent remains
active. The child's executor must observe abort; its sibling must continue.
Stock invocation options overwrite the child's configured signal.

**Reproduction:** `honors foreground child cancellation without cancelling the
parent` in `mastra-background-contract.integration.spec.ts` uses public Agent
configuration, native delegation and actual signals.

**PR proposal:** In `packages/core/src/agent/agent.ts`, compose the resolved child
default and parent context signals with `AbortSignal.any` when both exist, and
preserve the sole signal otherwise. Exercise child-only and parent cancellation
and same-agent siblings. [#10874](https://github.com/mastra-ai/mastra/issues/10874)
is closed and concerned parent propagation through agent networks; this draft
concerns preservation of an already configured child signal in native delegation.

## 4. Repeated semantic recall unnecessarily instantiates WASM hashers

**Issue title:** SemanticRecall constructs a new stateless WASM hasher for each
processor instance during repeated agent turns.

**Expected/observed:** The real 32-turn regression measures 160 native
`WebAssembly.instantiate` calls on stock 1.71 and one with shared initialization.
All 64 messages, indexing and recall of old context pass in both configurations.
This demonstrates allocation overhead, not an unbounded retained-memory leak.

**Reproduction:** `semantic-recall-lifecycle.integration.spec.ts` uses production
PGlite-backed Memory, deterministic embeddings, native Agent streaming and real
semantic retrieval. It observes WASM instantiation rather than a private field.

**PR proposal:** In `packages/core/src/processors/memory/semantic-recall.ts`, share
only the stateless hasher initialization promise per module. A rejected
initialization rejects its callers and clears the promise for a later attempt.
Do not change embedding caches, retrieval scope, indexing or memory features.
Searches for `xxhash` and SemanticRecall PRs found related cache/collision and
embedding-provider work, but no exact shared-instantiation repair. Removal should
follow a stable release passing this allocation-and-recall regression.
