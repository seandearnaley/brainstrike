# BST-2290: the spec counted a save embed that the run's abort may cancel

`host-thread-memory-semantic-recall.desktop.test.ts`, "a hosted embedder's
rejection is the turn's recall notice, then the run's save failure, each with
its reference", expected exactly three refused `POST /embeddings` requests. In
nightly run 39565910906 on ubuntu-latest, it received two: requests 3 and 5.
Every earlier assertion passed.

## Defect density (2026-10-21, 14 days, base `e429945ab`)

This spec has 3 commits: #4109, #3966 and #3952. The exercised product paths
also have HOT counts: `state-store-host-memory.ts` 4, `core-run-execution.ts` 4
and `memory.ts` 3. `memory-provider-lifetime.ts` has 1. Those commits cover
recall and compaction (#3952, #3985, #4088), typed memory failures (#3966),
memory settling after the answer (#3731), runtime failures (#3590) and stopped
reply text (#3569). None changes how the save embeds or cancels. #4109 added the
exact count of three. In the 14 days, BST-2290 is the only nightly-alert issue
that names this spec. The fix changes no product file.

## Mechanism

1. `Memory.saveMessages` in `@mastra/memory` 1.38.0 embeds every saved message
   with text at once, through `Promise.all` and one `embedMany` call per
   message (`dist/src-CTyZJ6A-.js`). The turn's save holds the prompt and the
   answer, so the host dispatches two embeds within 0.05 ms.
2. `MemoryProviderLifetime.embeddingCall` gives each embed the run signal.
3. The first 401 rejects the `Promise.all`. `commitHostStep` turns it into the
   save's typed failure, and `onStepFinish` in `core-run-execution.ts` aborts
   the run with it. That abort cancels the other embed's fetch.
4. The first embed reuses the warm keep-alive socket. The second opens a new
   connection. It reaches the provider only if its request is written before
   the host turns the first 401 into the abort, which takes under a
   millisecond.

## Evidence

The evidence comes from experiment-only timing logs in the shim and the built
agent host. None of that instrumentation was committed.

- On idle macOS (3 of 3 runs) and an idle 16-core Ubuntu box (10 of 10), the
  second embed arrived on a fresh connection 0.12-0.26 ms **after** the
  first 401 had been written. It still won, and three were refused.
- Pinned to 2 CPUs on Ubuntu, the instrumented old spec lost 18 of 20 runs. In
  each loss the shim refused requests 3 and 5, as the nightly did. It saw the
  second embed's connection open and close with no request on it. With no
  instrumentation at all, the pinned old spec failed 15 of 20 runs at line 309.
- Holding each embeddings 401 for 300 ms in the shim gave three refusals every
  time: 3 of 3 on macOS and 5 of 5 on Ubuntu.
- Delaying the second embed's dispatch by 300 ms in the host gave two every
  time: 3 of 3 on macOS and 5 of 5 on Ubuntu. Each of those runs failed the old
  spec at line 309, the nightly's assertion.

## Ruling: a test defect

Cancelling a run's in-flight embeds when the run fails is the run-owned
cancellation contract. Neither sending a doomed request nor serializing the save's
embeds would serve users. The platform difference is CPU contention, not
product logic.

## Fix

The spec asserts what the product fixes. Every refusal is an OpenAI
`POST /embeddings`. The recall is refused once, before the turn's streamed
model request. The save is refused once or twice after it, and the comment
names the code that makes that count vary. The fix adds no timer, poll, retry
or product change.
