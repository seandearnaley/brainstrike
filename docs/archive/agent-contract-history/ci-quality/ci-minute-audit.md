# September 2026 CI minute audit

Supports `docs/agents/ci-quality.md` § "Review and CI budget" and § "Workload boundaries".

CI is disabled due to cost; validation must run locally.

Investigation started 2026-10-02 against `origin/main` at `54d2d1a7c`.
Acceptance: enumerate September runs and every attempt, account allocated
Ubicloud job and step time, distinguish hangs from active work, preserve the
shutdown, and prove a narrowly scoped waste fix locally. Recent/open PRs were
searched first; the watchdog and fixture improvements already landed are part
of the evidence, not new fixes claimed by this PR.

## Collection and accounting

The run inventory has 9,802 September-created workflow runs, including 2,150
Test runs: 1,659 pull requests, 490 pushes, and one manual invocation. There are
2,075 distinct Test SHAs. These counts include skipped runs; they are not counts
of paid runners. Of all September runs, 9,752 have one attempt, 48 have two,
one has three, and one has five.

Daily UTC run queries are paginated and checked against `total_count`, with
unique run IDs and no date leakage. Every attempt is fetched separately,
including earlier attempts of a rerun, and job pages are checked against their
reported count. Adjacent days and eligible older reruns are inspected for
month-boundary carryover. API cache files retain source IDs and timestamps.
Collection completed at 2026-10-02 16:40 UTC: 21,078 candidate runs across
August 2–October 1, 10,644 eligible runs, 7,277 non-skipped/rerun attempt
snapshots and 50,218 job records. Ten allocated jobs created before September
completed in September. No supplied eligible attempt is missing. The two
older updated August 6 runs completed their jobs in August and add no
September execution. Deleted runs cannot be recovered from the listing.

The offline `scripts/audit-ci-minutes.mjs` replay requires the run inventory
and refuses missing/duplicate attempts, unexpected attempts and duplicate
allocated jobs. It selects jobs by UTC completion within the requested window.
It excludes unallocated jobs and non-Ubicloud labels. It records elapsed
seconds separately from the estimate obtained by rounding each job up to a
minute. Skipped steps contribute nothing. Incomplete canceled-step metadata
is reported, and active-step coverage uses an interval union. Unexplained time
is not labeled a hang. The supplied inventory itself must be complete; this
replay cannot recover deleted or omitted source runs.

```sh
node scripts/audit-ci-minutes.mjs attempt-jobs.json \
  2026-09-01T00:00:00Z 2026-10-01T00:00:00Z run-inventory.json > report.json
```

GitHub execution clocks cannot recreate Ubicloud's exact invoice clock or
actual VM family. Ubicloud's [billing implementation](https://github.com/ubicloud/ubicloud/blob/0b41c03111b345ccdda85d08e09f73a71e0af43c/prog/github/github_runner_nexus.rb#L116-L158)
charges a runner that became ready and picked up a job, rounds time from
`ready_at` until provider completion, and books the record on completion day.
The label `ubicloud-standard-4` does not prove a standard-price machine; the
account premium setting can override it. An exact job-to-charge reconciliation
requires the provider's runner IDs, ready/completion times and billed VM family.

## Monthly result

The invoice contains **185,066 runner minutes**: 168,359 premium-4, 16,596
premium-2 and 111 standard-4. Its subtotal is $706.91 and the $2.50 credit
leaves $704.41. The complete GitHub ledger contains **29,979 allocated
Ubicloud jobs**, **170,193.90 execution minutes**, and **185,122 minutes**
when each job is rounded upward separately. An independent Python calculation
agrees with the JavaScript report's job count, seconds and rounded total.
The 56-minute excess over the invoice is 0.0303%; it is unresolved, not
attributed to an invented cause. Daily differences reach -293/+206 minutes,
and label-level differences are larger than the net difference. Aggregate
agreement does not establish a charge-by-charge match.

Parallel runner minutes add together; they are not a workflow's wall time.
Rounding adds 14,928.10 minutes, 8.77% of raw execution. This is an estimate
using GitHub clocks, not a separately established invoice surcharge.

| Workflow | Allocated jobs | Rounded job minutes | Raw execution minutes |
| --- | ---: | ---: | ---: |
| Test | 26,222 | 167,293 | 154,055.25 |
| Coverage | 536 | 11,456 | 11,188.48 |
| Claude Auto Review | 1,058 | 3,467 | 2,954.57 |
| React Doctor | 2,089 | 2,258 | 1,384.77 |
| V8 WASM teardown repro (BST-1221) | 50 | 559 | 534.70 |
| Claude Code | 22 | 85 | 73.40 |
| Knip audit | 2 | 4 | 2.73 |

Test accounts for 90.37% of rounded execution. Its Unit partitions alone
account for 106,720 minutes. Pull-request events consume 142,999 minutes;
push events consume 40,263 minutes (21.75%); dispatch/comment/target/schedule
events account for the rest. Main pushes repeated substantial validation after
PR validation; their differing merge SHAs prevent calling every push redundant.
Rerun attempts account for 4,012 minutes (2.17%), much less than first attempts.

Successful jobs account for 176,094 minutes (95.12%), failures 5,764 (3.11%),
and cancellations 3,264 (1.76%). Success does not establish necessity or cache
efficiency. The dominant mechanism is frequent, broad execution and repeated
provisioning, with actual empty work and stalls inside that total.

The biggest measured step costs below are **raw elapsed minutes**. Step rounding
must not be summed to reconstruct job billing. Step intervals do not overlap
in this dataset; 3,866.40 job minutes sit outside complete step intervals.
There are 662 incomplete step records, principally canceled/not-completed
metadata. That uncovered time is not evidence of idleness.

| Step | Raw minutes |
| --- | ---: |
| Pull request affected integration tests | 31,134.67 |
| Pull request affected unit tests | 25,097.80 |
| Setup workspace | 23,413.28 |
| Push and manual integration tests | 11,559.37 |
| Run desktop smoke | 11,470.77 |
| Run desktop delegated smoke | 8,264.03 |
| Run other affected-package coverage | 8,094.50 |
| Push and manual unit tests | 7,089.43 |
| Package the desktop application | 4,097.92 |
| Verify packaged MCP core lifecycle | 3,275.57 |
| Initialize containers | 2,829.57 |
| Install the Linux OS-fence dependencies | 2,804.98 |

Setup workspace alone consumes 23,413.28 minutes (13.76% of raw execution),
before checkout, container setup, OS-fence dependencies and artifact transfers.
Logs of the empty jobs confirm full installs and browser download hooks before
Turbo discovers zero work. 2,649 successful Unit jobs have both unit and
integration command steps totaling at most two seconds; they allocate
4,346.37 raw / 5,715 rounded minutes. This is a candidate group, not proof
that all are empty: cache hits and very fast commands also qualify. Ten
inspected examples actually report zero tasks (18 rounded minutes); the
nine additional sample IDs and signals are retained in the local archive.
The sample is intentionally biased toward short jobs, not representative.

All 14 canceled jobs lasting at least 1,700 seconds were inspected: eight
Coverage jobs around one hour and six Unit (rest) jobs around 30 minutes.
Together they consumed 675 rounded minutes (0.365% of the monthly ledger).
Seven coverage logs show active testing or a just-completed suite at cancellation;
one has the 52-minute silent stall below. The six Unit incidents coincide
with the September 11/12 WASM/worker failure investigation. Their large output
gaps alone do not prove the underlying cause in every run. This subset does
not bound all possible shorter hangs or delays within successful jobs.
The longest successful coverage job (3540 seconds, job 109135548246) reported
6,460 passing tests and 2396.08 seconds of desktop execution. The longest
failed coverage job (3503 seconds, job 107832559451) reported 6,259 passes
and one LSP diagnostics timeout assertion after 2308.95 seconds of desktop
execution. Neither log supports calling the entire job idle.

### Daily comparison

Basis: UTC job completion day, all runner classes combined. The final column
is invoice minus rounded GitHub time; it remains unreconciled at job level.

| September day | Invoice minutes | Rounded GitHub minutes | Difference |
| --- | ---: | ---: | ---: |
| 01 | 8,675 | 8,639 | +36 |
| 02 | 6,270 | 6,299 | -29 |
| 03 | 4,599 | 4,529 | +70 |
| 04 | 3,108 | 3,028 | +80 |
| 05 | 7,027 | 7,055 | -28 |
| 06 | 11,569 | 11,487 | +82 |
| 07 | 3,278 | 3,404 | -126 |
| 08 | 2,271 | 2,309 | -38 |
| 09 | 4,749 | 5,025 | -276 |
| 10 | 9,944 | 9,884 | +60 |
| 11 | 4,857 | 5,150 | -293 |
| 12 | 13,414 | 13,208 | +206 |
| 13 | 1,081 | 1,241 | -160 |
| 14 | 1,188 | 1,257 | -69 |
| 15 | 7,478 | 7,480 | -2 |
| 16 | 5,516 | 5,419 | +97 |
| 17 | 3,422 | 3,370 | +52 |
| 18 | 1,509 | 1,490 | +19 |
| 19 | 5,763 | 5,675 | +88 |
| 20 | 280 | 277 | +3 |
| 21 | 2,663 | 2,614 | +49 |
| 22 | 5,090 | 5,155 | -65 |
| 23 | 5,464 | 5,456 | +8 |
| 24 | 7,157 | 7,064 | +93 |
| 25 | 4,000 | 3,936 | +64 |
| 26 | 6,459 | 6,369 | +90 |
| 27 | 1,947 | 1,928 | +19 |
| 28 | 12,959 | 12,842 | +117 |
| 29 | 21,910 | 22,100 | -190 |
| 30 | 11,419 | 11,432 | -13 |

## Confirmed incidents

- [Empty Unit runner](https://github.com/seandearnaley/brainstrike/actions/runs/36549209500/job/109343697000):
  117 seconds of allocated time; unit and integration commands reported zero
  packages and zero tasks, taking 435 ms and 295 ms. Provisioning happened
  before affected selection. Other fast jobs are candidates until logs confirm
  zero tasks or cache hits; short step duration alone is not proof.
- [Successful 55-minute coverage](https://github.com/seandearnaley/brainstrike/actions/runs/36601277266/job/109518998356):
  3,298 job seconds; DB coverage 1,005 step seconds and other-package coverage
  2,132 seconds. Desktop reported 574 passing files and 2,129.35 seconds.
  DB's long output gaps were grouped Turbo output, not evidence of a hang.
- [September 11 stalled coverage](https://github.com/seandearnaley/brainstrike/actions/runs/34651826998/job/103435506878):
  3,618 job seconds. Agent last reported a test at 22:03:25 UTC; the final
  other-package output was 22:06:07, then silence for 3,122 seconds before
  cancellation at 22:58:09. The one-hour job ceiling provided the final stop.
- [September 11 active coverage timeout](https://github.com/seandearnaley/brainstrike/actions/runs/34580566151/job/103202891652)
  and [September 15 active coverage timeout](https://github.com/seandearnaley/brainstrike/actions/runs/35018235687/job/104547002447):
  desktop tests were still reporting passes immediately before cancellation.
  These are ceiling breaches during active work, distinct from the stall above.

The current event-loop watchdog and lane wiring came from PRs #3145/#3148 on
September 11/12. Local verification in this audit passed the real blocked-loop,
responsive-worker, reused-fork and threads cases, plus all 18 declared PGlite
lane configurations. This establishes the current protection for that failure
class, not the absence of every possible asynchronous/import/teardown hang.

## Formatting-input fix

`biome.json` was a global Turbo input. A formatting-policy-only edit therefore
changed unrelated unit and coverage hashes and selected unrelated packages.
The real Turbo regression fixture reproduced that behavior before the fix.
The fix makes the policy an input of lint and of `@brainstrike/config` unit and
coverage tests, whose `exports.test.ts` actually reads it. Other task inputs,
source propagation and uncached integration/native checks remain intact.
The negative control restores the global input and reproduces broad selection.
No dollar saving is attributed to this change without matching historical runs.

This fix improves local task selection while CI remains disabled. Empty hosted
matrix rows, PR/main repetition and automatic coverage are historical cost
contributors to evaluate only if the user explicitly authorizes any future CI.
The shutdown remains the current remedy for paid hosted execution.

## Validation

Local Node 26.10.0 and frozen pnpm 11.15.0 installs were used. Audit accounting
has independent literal-duration tests and fail-closed completeness controls.
The actual formatting-input fixture and existing global-input/locality/parity
checks pass 71/71; config package tests pass 54/54. The watchdog guard passes
21/21 and actual runtime probes pass 5/5. `pnpm test:scripts` reports 1,823
passes, two skips and one failure out of 1,826 tests. The failure in
`qualify-linux-appimage.test.mjs:592` also reproduces on unchanged base
`54d2d1a7c`; it is not silently bypassed. Two stale hosted-policy assertions
missed by the shutdown PR also reproduce on that base and are corrected here
to verify the current local-only policy and preserved smoke-plan membership.
`pnpm dlx ultracite fix` and `check` complete with 16 existing warnings and no
errors. Linux/Windows native application behavior and the full application/E2E
suites are not qualified by these scoped macOS checks.

Commands run locally:

- `node --test` over audit accounting, Biome locality, existing CI-input
  locality, global configuration, tsconfig dependencies, contract budget,
  build-job contracts, MCP verification contracts and CI parity: 71 pass.
- `pnpm --filter @brainstrike/config test`: 54 pass.
- `node --test scripts/__tests__/verify-event-loop-watchdog.test.mjs`: 21 pass.
- `pnpm --filter @brainstrike/test-utils exec vitest run __tests__/vitest-event-loop-watchdog.test.ts`:
  five pass, including actual blocked-worker termination, healthy responsiveness,
  reused forks and threads.
- `pnpm test:scripts`: 1,823 pass / two skip / one pre-existing failure.
- Offline monthly CLI replay plus independent Python totals and all 61 invoice
  quantity rows: agree with the reported numbers.
- `pnpm dlx ultracite fix`, `pnpm dlx ultracite check`, `git diff --check`.

## Source archive and remaining boundary

Raw snapshots, collector, independent verification, daily CSV, sanitized log
analysis and validation output are retained locally in
`/Users/seandearnaley/Documents/brainstrike-ci-audit-2026-09`.
The three raw inventories are compressed; `manifest.json` records their
uncompressed SHA-256 hashes:

- Attempt jobs: `4bbca153adfaf89df664cda08ac9f8d0e654a0233d5a6a25b1d272444eb09de6`.
- Eligible runs: `b7040bfaf735520bf59eb5444a5bab3da3ac56bf9ff5993906554a90ae989ef8`.
- Candidate runs: `245d5274c6af4651ec65b42e1b986cc8a52b1a60837a484686f8eb8f38ce73b7`.

The financial source is the user's original September invoice; personal
billing details are not copied into the repository. The provider UI exposes
current runners and the invoice, but no accessible historical per-job charge
ledger. Closing the residual clock/class/day differences requires an export
of provider runner IDs, job IDs, ready/completion clocks and billed family.
No support message, refund claim or new spending authorization is sent.

Repository Actions permissions were rechecked after collection: `enabled=false`.
Premium remains disabled from the shutdown. No workflow is enabled or changed
by this audit. If hosted CI is ever explicitly authorized again, a separate
bounded design must select nonempty work before allocating runners, replace
automatic full coverage with explicit local coverage, and justify each main
push repetition and setup dependency. These are future decisions, not implied
permission to restore hosted execution.
