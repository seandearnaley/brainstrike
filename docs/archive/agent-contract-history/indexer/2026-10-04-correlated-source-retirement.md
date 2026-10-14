# Correlated source retirement

Fence the actual canonical parent request controllers before broadcasting shared
source cancellation, and physically join admitted collection and workspace owners
before releasing the native writer or profile.

The ordinary 5,000-file shutdown on integration `b8323d3` retained a plain
`Native ingestion paused.` error beneath `Workspace pass cancellation failed.`
That run did not record the exact RPC identity, so it does not prove which queued
operation failed.

The connected regression reproduces this cause independently: real activation
starts the public workspace runtime through the real parent/child channel, then
starts a collection scan and queues a later workspace inventory request behind its
actual scan admission. Original source retirement aborts the shared signal first,
so inventory rejects with that source reason before the parent aborts its distinct
request controller. The parent correctly sends an unmarked failure; the child
preserves it, and workspace retirement rejects rather than treating it as its own
cancellation.

Invoke parent retirement synchronously before the source abort. Its existing
strict error-identity check then marks the pending request cancellation. The child
normalizes that marker only after its own operation aborts. No protocol, error
text classification, or unrelated publication admission behavior changes.

The guard holds both collection inventory IO and watch unsubscribe. Writer and
profile close remain blocked until they settle. Separate same-text and permission
faults remain unmarked, fail retirement, retain those owners, and require explicit
retry. A failed watch unsubscribe also blocks writer/profile close until explicit
cleanup retry. A synchronous parent retirement fault still joins other capabilities;
independent inference retirement failure remains aggregated and owned for retry.
The existing utility channel/runtime and inference guards preserve independent
AbortError failures, stopped-owner validation, and full scan terminal ownership.

Guard: `apps/desktop/src/__tests__/native-index-source-retirement.test.ts`.

This is a local causal regression and correction. It does not turn the failed
ordinary performance run into acceptance or establish collection readiness there.
CI is disabled due to cost; validation must run locally.
