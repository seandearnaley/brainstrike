# BST-1977: received Stop response lost at socket close

On source `889d909407d20448c4f2b0edb547e40ac800efd7`, Windows Stop
qualification rejected callers with the SDK's pending-response disposal error.
A controlled Studio reproduction used the actual authenticated Core, native
SQLite writer and pinned vscode-jsonrpc 9.0.2 without model calls. It held
client dispatch after decoding Core's final response, then allowed physical
socket close. The request rejected although the received response reported
`{ outcome: 'stopped', rootReleased: true }`; Core and Root cleanup had joined.

The SDK separately schedules complete-frame decoding and connection dispatch.
The client's raw-close listener disposed the connection before those admitted
stages settled. Core already awaited its writer promise; a server delay, retry
or larger deadline would conceal the client race.

The source-reviewed compatibility patch adds opt-in public `drain()` methods
to the existing reader and connection. After physical close, the client joins
the reader semaphore, then queued/in-flight dispatch, then disposes. Incomplete
frames are excluded. Dispatch failures retain their causes and settle in-flight
accounting. Disposal still rejects unanswered requests. Ordinary SDK disposal
remains immediate. The exact-version patch links the upstream implementation
and is removed when a qualified upstream equivalent passes these tests.

Independent review found a concurrent explicit-close interleaving: disposal
cleared an admitted dispatch queue after a drain waiter registered, leaving that
waiter pending. A recorded-frame reproduction confirmed the pending drain after
decoder settlement and physical stream cleanup. Disposal now settles registered
waiters when the queue is cleared; an already-running dispatch still must join.
Explicit close retains ordinary pending-request cancellation semantics.

`packages/agent-host/__tests__/client-receive-drain.integration.test.ts` uses
real local sockets (named pipes on Windows) and the recorded Core response. It
holds both admitted stages and exercises multiple frames, missing/truncated or
malformed responses, wrong IDs, typed Stop errors, decoder failures, synchronous
and asynchronous dispatch failures, independent disposal failures, repeated
close, concurrent queued disposal and refused requests after close. It checks response/error identity and
joins peer and server closure. Existing `host.integration.test.ts` checks native
child and Root release before the actual Stop response.

Studio qualification passed all 14 receive-drain cases and 77 combined
Core/CLI/Memory integration cases using the package's `test:integration` script.
Windows must requalify the composed committed source; this receipt does not
explain the earlier renderer reload crash or qualify production crash recovery.

CI is disabled due to cost; validation must run locally.
