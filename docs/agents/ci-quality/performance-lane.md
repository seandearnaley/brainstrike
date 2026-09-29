# Performance lane — evidence

Supports `docs/agents/ci-quality.md` § "Performance lane (performance.yml) —
calibrated budgets only" (BST-1038; worker-memory bound BST-369). Read this
before changing any performance budget, the interaction-frame helpers, the
worker-memory structural bound, or the web coverage exclusion for the memory
probe. The contract holds the rules; this file is the record of why.

The nightly performance lane (`performance.yml`, cron 07:23 UTC + dispatch)
gates on the budget assertions inside `apps/web/e2e/performance/*.test.ts` —
there is no separate diff step. Its contract, written after the lane spent
three months permanently red (zero green runs in 1,000 retained; budgets
were local-dev constants x a flat 2.0 multiplier with no CI-derived floors):

- **Every CI budget that has breached under controlled measurement carries a
  calibrated `GITHUB_ACTIONS_MINIMUMS` floor** in
  `apps/web/e2e/utils/performance-config.ts`, with provenance (run ids, date,
  runner class, observed range) in the adjacent comment. Metrics that have
  never breached stay on the multiplier budgets and are calibrated from
  observed data on their FIRST breach — never floor-bumped reactively, and
  never tightened or introduced from a local measurement (local is an order
  of magnitude faster than the shared runner — the "~62ms" incident).
- **Recalibrate by controlled dispatch**: N `workflow_dispatch` runs of
  `performance.yml` on ONE SHA (sequentially — the concurrency group cancels
  parallel dispatches), floor = observed worst x ~1.5 headroom.
- **No `--max-failures` truncation**: the lane must report its full breach
  surface, or its scope cannot be measured.
- A calibrated-lane breach is a REAL signal: file it as a regression ticket
  with the measured values, do not bump the floor to silence it.
- Browser interaction helpers keep their complete sample inside the page. The
  default `measureLocatorInteractionFrames` contract retains each element and
  fails if React detaches it. Recursive folder selection deliberately uses the
  narrower `measureNamedCheckboxInteractionFrame` boundary: it resolves one
  checkbox by exact `aria-label` before the click and again after two animation
  frames, then verifies the replacement's checked state. This permits the
  folder row's expected replacement without admitting Playwright transport
  time or weakening detach detection for stable rows. Its single sample is the
  same interaction-to-paint quantity as `CHECKBOX_FRAME_MAX_MS`; the paired
  `performance-benchmark-contract.vitest.ts` test pins the named benchmark,
  known fixture count, and calibrated sibling budget.

BST-369 adds a worker-memory **structural bound**, not a locally invented CI
latency floor. On runtime-calibration head `156c0b052`, this command ran three
repetitions sequentially against one built app and one configured Chromium version:

```bash
cd apps/web
pnpm exec playwright test e2e/performance/embedding-model-switch-memory.test.ts \
  --project=performance --workers=1 --retries=0 --repeat-each=3
```

| Run | Baseline total | Warm worker | Window A worker | Window B worker | B - A | After worker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 278,926,311 | 44,397,878 | 44,446,090 | 44,446,626 | +536 | 0 |
| 2 | 277,774,586 | 44,398,290 | 44,446,558 | 44,446,634 | +76 | 0 |
| 3 | 277,832,659 | 44,398,290 | 44,446,542 | 44,446,634 | +92 | 0 |

The later production hardening at `7d2ba303d` validates the cache clock before
eviction or loader allocation. It leaves the valid switching allocation,
disposal, and structural-memory behavior unchanged. An exact-branch rerun at
`2a75942da` recorded baseline total 278,085,035, warm
worker 44,397,896, window A 44,446,108, window B 44,446,628 (+520), and zero
worker attribution after teardown, confirming the valid switching path retained
the same structural signal.

Two reversible, uncommitted mutations proved the browser assertion's teeth. Doubling each
allocated backing store failed at the warm barrier with 80 MiB physically live against the
40 MiB cap. Skipping the asynchronous-disposal prerequisite failed with five resources and
56 MiB live before the delayed GPU-class victim release completed. Both mutations were
restored before the three-run table above.

The three local repetitions qualify the measurement signal; they do not set a
CI floor. The 4 MiB later-window ceiling is instead a structural bound: half
the smallest retained 8 MiB synthetic model store, so a single leaked store
cannot hide inside it while JIT/runtime bookkeeping has implementation-level
headroom. If the pinned CI environment first breaches, use the controlled
same-SHA dispatch procedure above before changing any budget.

The web unit-coverage census exact-excludes only the browser page probe and its
wrapper worker. Those modules require a production Vite worker bundle,
cross-origin isolation, workerpool, and Chromium's
`measureUserAgentSpecificMemory()`; their executable owner is the scheduled and
dispatchable `performance.yml` Playwright project above. The paired
`performance-benchmark-contract.vitest.ts` test pins the exact two exclusions,
the webdriver-gated lazy hook, the page-probe-to-worker-to-production-worker
route, and the scheduled workflow selection. The platform-neutral memory
measurement and worker-message validation modules remain in unit coverage, and
the web L98/F85/B73/S89 thresholds are unchanged. Do not broaden this exception
or replace it with a wildcard.
