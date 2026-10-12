# M0-A1 latency and contention qualification port

BST-1923. This standalone harness ports the recovered M0-A1 workload onto the
production StateStore and Coalescer at
`b8323d3d5132dfdddd73e0b2a07afc0ed11b014f`. It is outside the pnpm workspace;
application code and workspace dependencies are unchanged.

## Review and execution boundary

Installation, native row validation, benchmarks and normal repository hooks
require the coordinator to allocate execution. Follow the current allocation
for focused pure checks as well. Independent source review precedes native
execution. The environment gate prevents accidental execution; setting it is
an execution step, not approval by itself.

One complete local macOS A1 qualification passed on the archived measured
source. Its receipt and limits are recorded in
`docs/agents/state-store/m0-a1-qualification-2026-10-04.md`. A failed criterion
remains a failed criterion; the no-host observation cannot qualify or excuse it.

`SOURCES.sha256` freezes the delivery source, excluding the manifest itself
and generated/installed files. The actual measured source manifest remains
byte-exact in `original/MEASURED-SOURCES.sha256` (SHA-256
`bc2e8296936871861cd5be51497b9caad4cd56e7757008863fc4ef00caf25b58`).
`original/measured-port-bc2e8296.tar.gz` preserves the complete measured source
and its original manifest. Its SHA-256 is
`28c5ed8857d5325248fd5154b5aafee4d58c57939c905769171bc9ea258c8a52`.
The lint/style delivery revision has not been benchmarked; the reported timing
result describes those archived measured bytes. From this directory, verify with
`shasum -a 256 -c SOURCES.sha256` before review and execution. The digest of
that manifest identifies this source checkpoint; any source revision requires
a new manifest and review.

## Recovered source and explicit port decisions

`provenance.json` records SHA-256 values and archive paths for all 14 inherited
`s-dur` host dependency files and six recovered A1 driver/test captures. Original
bytes remain under `original/`. The recovered J-worker test has a `.ts.txt`
suffix to preserve its bytes without registering it as a current test.

`prepare.mjs` verifies those bytes and creates ignored `.runtime/` files. It
replaces the historical Coalescer with a measurement wrapper around the real
production class, changes the host/helper store types, and adds the historical
PGlite baseline's inert boundary method. The P baseline is the captured log
implementation; its NODEFS fsync does not establish SQLite durability.

The S adapter forwards real `append`, `syncBoundary` and `close` operations.
Historical reads are exclusive `afterSeq`; production reads are inclusive, so
the adapter passes `afterSeq + 1`. Display remains after commit, with real
boundary operations issued without awaiting them on the display path. The
wrapper only observes production probes; it does not implement coalescing.

After the timed window and sync drain, `run-outcomes.mjs` checks the retained
root completion and public terminal results for the root, every child and the
wake. Every expected run must be `completed` with no reported error before a
measurement record is written. Fulfilled failed/interrupted results are failure
data; `waitIdle()` fulfillment and matching boundary counts cannot qualify them.
The pure negative control issues all 181 boundaries through the real Coalescer
with a fake log, then rejects fulfilled root/child/wake failures.

The recovered workload is preserved: background delegation, child runs and
root wake, 1ms mock chunks, 20ms flushes and 5ms `read_file` calls. Display uses
three children, four steps and 500 text deltas; every fresh run must produce
7,713 displayed/raw chunks and 17 step boundaries. Contention uses eight
children, 20 steps and 60 deltas, with 181 boundaries. The actual `s-dur` host
and V4 mock are used; the current kill-helper's different workload is unused.

Display runs 20 rounds, alternating S/P order, with one fresh process and root
per candidate. It pools rounded per-chunk samples and uses the recovered
`ceil(.95*n)-1` percentile: **p95(S) <= p95(P) + 5ms**. Contention warms one
100MiB read, measures 15 idle reads with the same store already open, then
reads continuously during streaming. It retains the recovered
`min(n-1, floor(.95*n))` percentile and rounded ratio. The coordinator explicitly
approved **median of three fresh S processes <= 2x idle**, porting the recovered
J-worker test's aggregation method to S. This is a port decision, not a claim
that the recovered executable test already targeted S.

One additional fresh S process measures the captured 2,500ms no-host control.
It is observational only. J implementation source was not recovered, so this
harness does not reconstruct J or claim its negative control. Kernel tracing
is not repeated; worker/probe spans are not kernel evidence. The production
kernel-sync suite remains separate.

Historical Node was 24.16.0; this port pins Node 26.8.2 and better-sqlite3
13.0.3. Runtime versions, SQLite settings and load averages are recorded.
SQLite settings are checked against WAL/NORMAL, secure_delete=ON,
wal_autocheckpoint=0 and macOS fullfsync. No no-sync mode or parameter tuning is
provided.

The standalone npm lock contains the 42-package runtime/loader closure (43 lock entries including the root) selected
from the archived npm lock, retaining exact versions, tarball URLs and
integrities. Direct pins are ai 7.0.126, provider 4.0.21, PGlite 0.5.8,
json-schema-traverse 1.0.0, zod 4.6.5 and tsx 4.23.15. These are needed by the
captured V4 mock and are not repository dependency upgrades. npm installability
and the resulting runtime remain unverified until the heavy slot is allocated.

## Exact execution sequence

Use Node 26.8.2 on PATH. Run from this directory. `STATE_ENTRY` must be an
absolute path to `packages/state-store/src/index.ts` in an already qualified
checkout with installed native dependencies. Every production source file is
checked against the base hash before import. The existing qualified checkout
can supply this entry; installing the root workspace is unnecessary.

```sh
node --version
npm ci --ignore-scripts --no-audit --no-fund
node prepare.mjs
node --test adapter.test.mjs statistics.test.mjs provenance.test.mjs run-outcomes.test.mjs
BRAINSTRIKE_M0_A1_QUALIFICATION=1 node --import tsx native-row.mjs "$STATE_ENTRY"
BRAINSTRIKE_M0_A1_QUALIFICATION=1 node --import tsx qualification.mjs "$STATE_ENTRY" "$OUTPUT_DIRECTORY"
```

`OUTPUT_DIRECTORY` must be new, with an existing parent. Run native row
validation before the benchmark. It checks actual row cursors, commit callback,
Coalescer delivery, one real boundary operation and database integrity; it does
not claim kernel trace evidence. Preserve the complete output directory.

Qualification executes serially: 40 display children, three contention children
and one no-host child. Each has the recovered five-minute timeout. An interrupted
or timed-out child is killed and joined before the driver fails. Roots are
closed and removed on normal child completion; SIGKILL can leave an isolated
temporary root. Failure is recorded with raw stdout/stderr and never replaced
with another candidate or a weakened threshold.

The display workload alone has roughly 80 seconds of scripted delay across
40 runs (four steps x 500 deltas x 1ms per run); reasoning, other stream parts,
tools, startup and database work add time. Contention adds three 20-step phases,
idle reads and a 2.5-second control. Expect several minutes on an idle machine;
this is a workload-based estimate, not measured duration or a pass prediction.
Budget and scheduling remain with the coordinator.
