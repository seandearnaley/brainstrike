# M0-A1 latency and contention qualification

Supports `state-store.md` "Writer and durability". This is local A1 timing
evidence for the unwired storage foundation, not application chat or A2 purge
qualification. BST-1923 remains incomplete while A2 purge qualification is open.

## Candidate and source identity

The single complete run qualified integration commit
`b8323d3d5132dfdddd73e0b2a07afc0ed11b014f`, repository tree
`83a98dd9ee92ae97c26dc683a93d2758c7ca4d4d`. Its StateStore source tree is
`a3fe199d070841bca366709fe97641cf68b15390`.

The harness is `spikes/m0-a1-qualification`. Its independently reviewed
36-file `SOURCES.sha256` manifest had digest
`bc2e8296936871861cd5be51497b9caad4cd56e7757008863fc4ef00caf25b58`
before and after execution. All 18 production StateStore source hashes remained
unchanged across the alignment from `6622788` to this integration candidate.
The frozen standalone npm lock had SHA-256
`24937a21c15ef15500983a6565bccece64daa6889cd6c85059b9b627aacd888c`.

The recovery supplied 14 inherited `s-dur` host dependency files and six A1
driver/test captures. Their bytes are retained and checked by the harness.
The port uses the recovered V4 mock and actual historical delegation/wake host,
the real production Coalescer, and the real StateStore worker. Historical
exclusive reads translate to production inclusive reads with `afterSeq + 1`.
PGlite remains the captured baseline with its inert NODEFS boundary behavior.

## Local execution

The sole local heavy slot covered isolated installation, native smoke and one
complete qualification. Timing began only after native smoke passed, while
other owners were instructed to keep tests, compilers and native work idle.
No setup correction, retry, parameter tuning or threshold change occurred.

macOS arm64: 27.0.1 (26A434), Node 26.8.2, better-sqlite3 13.0.3, SQLite 3.53.4.
The isolated direct dependencies matched the frozen lock: ai 7.0.126,
`@ai-sdk/provider` 4.0.21, PGlite 0.5.8, json-schema-traverse 1.0.0,
zod 4.6.5 and tsx 4.23.15. The repository dependency graph was not upgraded.

Native smoke used the production public source entry in an already qualified
checkout at the same integration commit. It passed actual row cursor checks,
commit callback, real Coalescer delivery and boundary operation, and integrity
with zero sequence gaps. SQLite settings were WAL, synchronous=NORMAL,
secure_delete=ON, wal_autocheckpoint=0 and fullfsync=ON. No additional StateStore
build was necessary; the production source closure was unchanged.

The execution sequence used the pinned Node executable:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node prepare.mjs
BRAINSTRIKE_M0_A1_QUALIFICATION=1 node --import tsx native-row.mjs "$STATE_ENTRY"
BRAINSTRIKE_M0_A1_QUALIFICATION=1 node --import tsx qualification.mjs "$STATE_ENTRY" "$OUTPUT_DIRECTORY"
```

`STATE_ENTRY` was
`/Users/seandearnaley/.codex/worktrees/native-callers-scoped-vectors/brainstrike/packages/state-store/src/index.ts`.
Source hashes and the native dependency version were checked before import.

## Results

Display completed 20 rotating S/P rounds, 40 fresh processes. Every process
produced 7,713 shown/raw chunks and 17 boundaries. Each candidate supplied
154,260 pooled per-chunk samples, using the recovered ceil-index percentile.

| Display gate | Observed |
| --- | --- |
| S pooled p95 | 20.530 ms |
| PGlite pooled p95 | 20.735 ms |
| S limit: PGlite + 5 ms | 25.735 ms |
| Result | PASS |

Contention used three fresh S processes. Each warmed a 100MiB read and measured
15 idle reads with the same store already open, then read continuously during
the original eight-child, 20-step workload. Each produced 181 boundaries.
It retained the recovered floor-index percentile and rounded ratios.

| Process | Idle read p95 | Loaded read p95 | Ratio |
| --- | --- | --- | --- |
| 0 | 12.280 ms | 14.307 ms | 1.165 |
| 1 | 12.830 ms | 14.428 ms | 1.125 |
| 2 | 11.786 ms | 14.236 ms | 1.208 |

The explicitly approved S port uses the median of those three ratios:
**1.165 <= 2: PASS**. The recovered executable test originally targeted J-worker;
this S aggregation is a documented port decision. A fourth fresh S process ran
the 2,500ms no-host observation, ratio 0.796. That observation had no role in
either pass decision.

After timing stopped and syncs drained, the harness checked the retained root
result and public terminal results for every expected root, child and wake.
All 230 measured run outcomes were completed with no reported error. A pure
RED/GREEN negative control reproduced fulfilled failed/interrupted results
being accepted, then proved their rejection after all 181 boundaries were
issued through the real Coalescer with a fake log. The complete pure suite
passed 11 tests before native execution; the metadata alignment reran its two
affected checks successfully.

The qualification driver exited 0 after joining all 44 benchmark children.
Native smoke also exited successfully. All 44 child stderr files were empty.
Every store closed before its process exited; a post-run process scan found no
owned Node processes and no `m0-a1-*` temporary store roots. The heavy slot was
explicitly released after these checks.

## Preserved receipts and limits

Local raw samples, worker spans, terminal outcomes and complete child
stdout/stderr are preserved under
`/Users/seandearnaley/.codex/worktrees/m0-a1-qualification/brainstrike/spikes/m0-a1-qualification/results/qualification-b832-bc2e8296-20261004/`.
The result `qualification.json` has SHA-256
`3d149040fde5c3f479b78604554a3ae4d6b41b52376278be639200f81304867a`.
Its `receipt.json` binds candidate/source/dependency identities and all 44 raw
JSON hashes; receipt SHA-256 is
`206c2a9c12af10557f14de3949717faefae91b90586e1eef920a0413306abcba`.
Native smoke and the complete parent console log are adjacent in `results/`.
Generated runtime files, installed dependencies and raw timing artifacts remain
ignored rather than becoming repository fixtures.

This run does not reconstruct the missing J implementation or certify its
negative control. Kernel tracing was not repeated; worker and Coalescer spans
are not kernel evidence. The separate production kernel-sync suite retains its
own evidence. No real power loss was simulated. Linux, Windows, x64, native
distribution, application chat integration and A2 purge qualification remain
outside this macOS A1 result.

CI is disabled due to cost; validation must run locally. Hosted CI/reviews were
not enabled or dispatched. Delivery formatting, pure checks, normal commit
hooks and publication execute outside the measured interval.

## Delivery style delta after measurement

The measured manifest remains byte-exact at
`spikes/m0-a1-qualification/original/MEASURED-SOURCES.sha256` with the original
`bc2e8296...` digest above. The complete 37-file measured snapshot (36 inputs
plus that manifest) is preserved in
`original/measured-port-bc2e8296.tar.gz`; its SHA-256 is
`28c5ed8857d5325248fd5154b5aafee4d58c57939c905769171bc9ea258c8a52`.
Every archived input was checked against the measured manifest after archiving.
The raw qualification and receipt were not rewritten.

An explicit-file Ultracite invocation processed historical captures and wrote
29 files before reporting lint errors. Those writes were restored from the
reviewed index and the original 36-file manifest was reverified. The sole new
Biome exclusion is `!!spikes/m0-a1-qualification/original`, covering immutable
inputs only; active implementation and tests remain linted. A read-only
canonical Biome check confirmed the historical source is now ignored.

The authored delivery delta adds control-body braces, equivalent short-circuit
predicate spellings, explicit test defaults/builtin spellings, and targeted
annotations for intentional CLI output and the historical S/P schema names.
Console calls, candidate keys, workload constants, timing boundaries,
percentiles, thresholds and terminal-success requirements remain intact.
Canonical Biome formatting and Ultracite fixing completed. Targeted import/key
assist suppressions preserve the reviewed module evaluation, property evaluation
and output order; the fixture default annotation preserves its positional API.
An ordered TypeScript AST comparison of all 11 authored modules against reviewed
tree `ee444eb95791310a2a630b3e1912905358288cca` passed, ignoring comments,
positions and redundant parentheses. All 11 focused pure checks passed under
Node 26.8.2 with test concurrency one. The final 38-input delivery manifest is
`fa93c829a62eb32db149d2b3329ebb854f0b573d38c21ef94380f262f1d79a0d`.
The measured archive, its original manifest and the raw receipt retain their
recorded hashes. No benchmark repeat occurred and no timing claim is made for
the delivery bytes. Normal hooks remain enabled for delivery.
