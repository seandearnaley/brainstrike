# Mastra streaming spec layout — evidence

Supports `docs/agents/assistant-runtime.md` § "WHERE THE MASTRA STREAMING SPECS LIVE".
Read before adding a spec file at the stream boundary or moving a case between them. BST-986, BST-988, BST-985, BST-839.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2273-2310), extracted verbatim.

`packages/agent/src/__tests__/mastra-streaming.spec.ts` was a single 4,246-line
file covering the whole stream boundary. BST-986 split `agent-streaming.ts` into
modules; the spec is now split to match. Five files share ONE fake-Mastra harness
(`packages/agent/src/__tests__/fixtures/mastra-stream-harness.ts` — the mocked
`Agent`/`Mastra`/MCP classes plus the mutable stream-part queue they read):

| Spec | Pins |
| --- | --- |
| `mastra-tool-lifecycle.spec.ts` | `mastra/tool-lifecycle-processors.ts` — `ToolLifecycleState`, `mapToolLifecyclePart`, `mapGenericToolEvent`, `makePendingToolOutputRunEventChunks`, `makeLifecycleStepMetadata` |
| `mastra-tool-approval-chunks.spec.ts` | `mastra/tool-approval-chunks.ts` (`makeApprovalRequiredChunks`, `makeToolSuspendRequiredChunks`) **paired with** `streamMastraToolApprovalAction` / `streamMastraToolResumeAction` — a pause that cannot be resumed is a bug in the PAIR, so splitting these across two files would let either side stay green while the contract broke |
| `mastra-stream-termination.spec.ts` | `mastra/stream-termination.ts` (`makeProviderErrorTermination`, `makeTripwireTermination`) plus the `run.finished`-vs-`run.failed` finish-reason policy, which is one question even though its code is split across `agent-streaming.ts` and `makeFinishChunk` |
| `mastra-stream-watchdogs.integration.spec.ts` | `makeStreamWatchdogTermination` through the real elapsed-time behavior of the inactivity and tool-call-input watchdogs; the suffix keeps these wall-clock-sensitive cases in the uncached integration lane |
| `mastra-streaming.spec.ts` | What no single module owns: the async-iterator contract, the R6 unknown-chunk diagnostic, token measurement, cross-step usage/cost accumulation, steering, observational-memory chunks, and everything reached through `createMastraAgentRuntime` |
| `openai-duplicate-item-compat.spec.ts` + `openai-reasoning-item-replay.integration.spec.ts` | `mastra/openai-duplicate-item-compat.ts` (BST-1095) — the unit spec pins keep-newest/drop-stale semantics and proves via the real `@ai-sdk/openai` serializer that each item id reaches the wire once; the integration spec seeds real PGlite with the double-persisted history shape and asserts every prompt the real agent loop produces carries each OpenAI item reference in at most one message (plus approval suspend/resume replay regression coverage) |

**These are integration specs, not unit specs — deliberately.** They drive
`streamMastraAgent` over a fake Mastra stream instead of importing the module
under test, because the mappers are reachable only through the R6 dispatch
(`processMastraStreamPart`) and the ORDERING they must produce is a property of
the dispatch loop, not of any single mapper. Contrast
`packages/agent/src/mastra/__tests__/mastra-chunk-decoding.spec.ts` (BST-985),
which CAN import its subject directly because those decoders are pure. Put a new
case in the file whose module owns the behaviour; add a file only when a new
module seam appears.

`mastra/stream-run-event-chunks.ts` has no dedicated spec on purpose: its
minting helpers are used by all four module-seam specs above, so each of those
files exercises it and no coherent set of cases pins it alone.

Mocked dependencies do not by themselves make a watchdog case cache-safe. The
two watchdog specs above drive production `Date.now` / `setTimeout` behavior
with real elapsed-time gaps, so their verdict still depends on un-hashed host
scheduling and every invocation must execute them. A watchdog test that uses
deterministic/fake time, or whose verdict does not depend on scheduler progress,
stays in the cacheable unit lane. The BST-839 case deliberately keeps 10x
per-gap headroom (20ms stream gaps against a 200ms inactivity window) while its
~400ms total stream remains long enough to prove the old coupled-timeout
regression; do not narrow that margin merely to shorten the integration lane.
