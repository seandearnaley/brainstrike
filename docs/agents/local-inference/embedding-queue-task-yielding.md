# Embedding queue task yielding

The legacy embedding queue yields an abortable task turn after a completed
nonempty batch. Foreground admission and completion ownership remain governed
by the claim permit and admission budget, rather than a fixed pacing interval.

## 2026-10-04: remove legacy pacing (BST-1921)

The desktop worker configured a 75ms inter-batch delay; the shared worker used
50ms by default. These positive delays followed every nonempty claimed batch,
including jobs whose vectors were already current. The worker now uses its
existing abortable sleep with a zero delay. The option, desktop environment
setting and timing metric are removed, together with obsolete test inputs.
Idle polling, resolver/failure backoff, concurrency, model selection, pipeline
capacity, leases and workspace-sync QoS pacing are unchanged.

`embedding-worker-pacing.test.ts` exercises the actual worker loop with the
database and inference boundaries mocked. Its accepted job has a valid persisted
embedding payload and is filtered as already embedded. A deferred completion
checks that another claim cannot start before settlement. Microtask-only progress
checks that the worker still yields a task turn, then a zero-time timer turn
checks forward progress. A second case stops during the pending yield and checks
that shutdown joins and disposes the service without another claim or clock advance.

RED on the original worker: the next-task assertion expected two claims and
observed one; cancellation passed. GREEN after removing pacing: both cases pass.
The focused command is `vitest run src/__tests__/embedding-worker-pacing.test.ts
--maxWorkers=1 --no-file-parallelism` from `packages/embeddings`.

This is queue behavior evidence. Canonical native document inference bypasses
this legacy queue, so the change establishes no canonical-path throughput gain
and does not close the other performance acceptance criteria in BST-1921.

The first real integration run passed 41 of 43 cases. Two existing tests depended
on positive pacing to stop before the next claim or idle stats flush. Their
fixtures now explicitly hold the next claim permit: the permit test also checks
that the initial blocked claim stays queued and completion succeeds before the
second claim can proceed; the stats test keeps dirty stats pending until Stop.
Both corrected cases pass individually, without reintroducing a sleep.
The subsequent serial run of batch optimization, queue load, partial completion
and stop/idle integration suites passes all 43 cases with no skips.
