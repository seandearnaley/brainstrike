# Transactional embedding admission evidence

Supports [Effect boundary contract](../effect-boundary.md) § "Shared helpers".
BST-1833 moves the renderer embedding worker's in-flight admission authority from
an integer plus a waiter set into one public `TxSemaphore`. A transaction waits
for nonzero availability without taking a slot; after the existing background
permit and claim-size decision, a separate transaction reserves
`min(requested, available)` atomically. This keeps partial batches and the
foreground query gate's ordering. The reservation transaction is not cancelled
at its Promise handoff: if Stop arrives just after commit, the caller receives
the granted count and its `finally` returns it. Fatal-worker and closed-DB exits
abort blocked availability waits. No job queue or heartbeat policy changes.

The batch returns unused claim slots immediately. Claimed slots return only
after their matching durable completion/failure write; settlement callbacks now
await the transactional release. Before releasing remaining slots on error, the
worker joins all malformed-job failure writes and every accepted streaming
completion write. Release errors stay visible, including when another write is
still pending. Started failure writes are observed immediately while valid
groups run. If a stream and its accepted completion both fail, the secondary
error is logged and the original stream error keeps its terminal classification.
Metrics derive the in-flight count from semaphore availability,
so there is no second permit counter.

The original helper test first failed because the new module did not exist;
that was scaffolding RED rather than behavioral falsification. Meaningful
regressions use real PGlite: Stop injected after reservation commit and before
claim prevents the claim and returns the slot; a delayed second failure write
holds the batch after the first release rejects; a stream exception cannot free
its slot while an accepted completion write is still pending. A dual-failure
regression confirms invalid input stays terminal while the write error is logged.
The queue-load
matrix still observes exact claim limits and a peak of four claimed jobs across
1/2/4/16 loops, with 12 lease claims and one attempt per job in each scenario.
Baseline diagnostic completion latencies were 60/35/25/29 ms; candidate
latencies were 74/35/23/26 ms. These single-run host-load observations are
not gates or evidence of a speedup.
Three targeted negative controls failed as expected: removing the post-grant
Stop check admitted a claim, replacing `allSettled` with early-rejecting `all`
released a batch before its second failure write, and omitting the stream
writer drain admitted another claim before the pending completion. The paired
contract guard failed when the transactional availability reads were removed;
each source mutation was restored before the passing checks.

The desktop renderer build and cycle guard passed with 401 JavaScript chunks:
total raw/gzip9 bytes moved 22,529,232/5,216,286 to
22,533,607/5,218,092 (+4,375/+1,806); the startup static closure moved
10,127,752/2,182,208 to 10,132,058/2,183,978 (+4,306/+1,770).
The web build and cycle guard passed with 416 JavaScript chunks:
total raw/gzip9 bytes moved 17,751,760/4,934,804 to
17,756,476/4,936,979 (+4,716/+2,175); the startup closure moved
16,227/6,439 to 16,268/6,459 (+41/+20). Measurements use the same Node 26
script and pinned dependency versions; the candidate lockfile only adds direct
declarations for the existing pinned Effect and diagnostic tool. These are
complete emitted JS sets, not only a selected entry chunk.
