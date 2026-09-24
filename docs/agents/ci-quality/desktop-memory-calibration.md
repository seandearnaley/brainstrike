# Desktop memory calibration — evidence

Supports `docs/agents/ci-quality.md` § "Desktop Electron provisioning" — the
desktop E2E memory instruments and their ceilings (BST-438, BST-1380). Read this
before changing a heap or working-set ceiling, the memory fixtures, the
measurement window, or the process-memory source, and when a nightly
desktop-e2e memory ceiling starts failing. The contract holds the rules; this
file is the calibration record.

Desktop renderer working-set snapshots use `app.getAppMetrics()` joined to
each `webContents.getOSProcessId()`. Electron 43 does not expose the older
`webContents.getProcessMemoryInfo()` API on the CI runner; treating that
absence as zero made the large-collection thresholds vacuous. Missing PID
metrics now fail visibly. The older API remains optional only for its private
and shared-memory diagnostics.

Renderer heap readings require `--enable-precise-memory-info` alongside
`--js-flags=--expose-gc` in the E2E launcher: without it Chromium quantizes
`performance.memory.usedJSHeapSize` AND caches it for 20 minutes, so every
in-test read returned the identical value and each "heap growth" was
tautologically `0.0` — the heap ceilings could never bind. The flag is pinned
by `desktop-e2e-harness-contract.test.ts`; the pre-flag calibration tables
(2026-08-11 dispatches `31458099061`/`31458469270`/`31459112520` and the
2026-08-19 head-`07bc230ae` local runs) all showed that dead `0.0` signature.
The flag makes EVERY heap ceiling in the desktop memory suite live at once,
not just the recalibrated tables below. The remaining now-live ceilings were
sampled once locally on 2026-08-19 with comfortable margins: the large-backfill
`retainedGrowthMB < 60` measured `-48.5`/`-48.6`/`-49.1` across three runs, the
20k diagnostic's host-heap growth measured `9.9` MB (limit 120) and main-heap
growth `12.9` MB (limit 80), and the repeated-backfill idle host-heap drift
measured `0.0` MB (limit 40 — a genuine post-GC steady state, not the dead
signature: host heap readings vary at 0.1 MB granularity across the same run).
If a nightly desktop-e2e heap ceiling starts failing after this flag landed,
diagnose it first as calibration of a newly live instrument, not necessarily a
product regression.

The tables below are LOCAL-HOST samples (macOS arm64 dev machine), not
ubuntu-runner CI dispatches like the superseded 2026-08-11 table — do not
compare their absolute values against CI numbers. A confirming
`memory-baseline` dispatch in the CI environment (run `32274868755`, the first
CI execution of the BST-438 tests) measured live heap growth of `1.8` MB in
both live-query scenarios — the 16 MB heap ceilings hold in CI too. That same
dispatch recalibrated the switching test's alive-generation identity bound
from a local-only 6 to 8 (CI held 7 alive with 58/65 collected and zero
drops), and exposed a PRE-EXISTING CI failure unrelated to the flag, since
fixed as BST-1380: the large-backfill error path emitted a WebGPU-refusal
message that
`embedding-worker-renderer.memory.desktop.test.ts` does not expect. Its
correct attribution is recorded below — the Electron 43.4 provisioning window
it coincided with was NOT the cause.

The desktop embedding specs run under `--disable-gpu`, so they only exercise a
real backfill because they configure WASM explicitly. Between 2026-08-12 and
BST-1380 they did not: BST-1235 narrowed the hidden-host preload manifest, the
host lost the capability to read that configured preference, and it fell back
to auto-detection — which fail-closes with no WebGPU adapter. The symptom reads
as an Electron/runner GPU regression and is not one; the last green run
(`31458099061`, 2026-08-11) predates the preload change, and a fixed-Electron
RED/GREEN on one host isolated it. Do not bisect Electron versions for it.
Reproduce on any host by running the spec with `CI=true` (that env var is what
adds `--disable-gpu`): a healthy run reports `outcome: "running"` with a
non-zero `queueStats`, a broken one `outcome: "error"` with
`queued 0 / running 0`. See `docs/agents/local-inference.md` for the capability
contract.

The 50k collection and 50k file-list ceilings are calibrated, not inherited
from the older Collection Browser measurement window. On 2026-08-19, three
sequential local regression runs with precise memory info (head `d4d1af0f2`
plus the flag change) produced:

| Scenario | Visible heap growth (MB) | Visible working-set growth (MB) |
| --- | --- | --- |
| 5k files / 50k chunks | `-8.1`, `-8.4`, `-8.2` | `-1.8`, `-1.4`, `-1.9` |
| 50k-file source-paginated list | `-8.4`, `-8.4`, `-8.4` | `-1.2`, `-2.0`, `-1.7` |

The paired heap and working-set limits remain positive floors of 16 MB
and 32 MB. Those floors preserve at least 16 MB of heap headroom and at least
30 MB of working-set headroom over the largest observed deltas while still
failing a material full-collection hydration. Replace this
table and re-run three sequential same-head samples when changing the fixture,
measurement window, or process-memory source.

BST-438's database live-query limits are calibrated independently from those
50k-list scenarios because its primary signal is forced-GC collection of actual
result-array identities. On 2026-08-19, three sequential local (macOS arm64)
regression runs with precise memory info (head `d4d1af0f2` plus the flag
change) produced:

| Scenario | Visible heap growth (MB) | Visible working-set growth (MB) | Collected / tracked generations |
| --- | --- | --- | --- |
| 100 alternating committed mutations | `1.9`, `1.9`, `1.9` | `-31.7`, `-32.7`, `-31.9` | `100/101`, `100/101`, `100/101` |
| 10 A/B/C switch cycles plus final insert/delete | `1.6`, `1.7`, `1.5` | `13.3`, `12.6`, `13.6` | `60/65`, `60/65`, `60/65` |

The mutation test's midpoint-to-final heap growth was `0.6` MB in all three
runs. An earlier three-run threshold-selection sample at implementation head
`32cd1a46afd97971ceca9d8e96a11abc82b469f0` observed switching working-set
growth of `13.0`, `29.4`, and `11.7` MB, so the 48 MB switch ceiling retains
18.6 MB of headroom over the worst of all six samples. The mutation working-set
ceiling remains 32 MB and both heap ceilings remain the positive 16 MB floor,
now over a real measured heap peak of `1.9` MB (≈8× headroom).
Every final-head run also held the exact renderer/IPC/manager/host ownership
delta, exact one- or three-entry cache cardinalities, zero dropped WeakRef
observations, removal of all named superseded generations, and a live current
generation. Re-run three sequential exact-head samples when changing the
fixture, switch/mutation count, forced-GC window, cache policy, or process-memory
source.
