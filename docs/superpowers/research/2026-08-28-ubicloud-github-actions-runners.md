# Ubicloud managed GitHub Actions runners — current service research

Date: 2026-08-28
Status: Research plus local cost-first implementation record; not pushed
Repository snapshot: `68bde8bb5bad1172157bbebc7fe518dfd4a3bd61`

## Executive result

Ubicloud is a credible replacement for **Ubuntu Linux** GitHub-hosted jobs,
not a universal Actions runner replacement. Its documented managed fleet has
x64 standard and premium CPUs plus standard arm64, Ubuntu 22.04/24.04/26.04,
2/4/8/16/30-vCPU sizes, much larger disks than GitHub's standard runners, and
per-minute prices materially below GitHub's paid rates. It has no documented
Windows, macOS, GPU, or `ubuntu-slim` equivalent. The live service catalog
contains additional 60-vCPU and direct-premium labels, but public support and
pricing docs do not; those are not safe migration targets without confirmation
from Ubicloud.

Brainstrike's required PR workflow is intentionally only partly migrated:
`unit-shard`, `build`, `native-electron`, `web-e2e`, and `desktop-e2e` use
`ubicloud-standard-4`; admission remains on GitHub `ubuntu-slim`, Static and
the Unit fan-in remain on GitHub arm64, and Native Windows remains on GitHub
Windows. That boundary and its measured provenance are recorded in the
[CI contract](../../agents/ci-quality.md#primary-linux-x64-jobs-run-on-ubicloud-bst-765)
and guarded by
[`ubicloud-runner-contract.test.mjs`](../../../scripts/__tests__/ubicloud-runner-contract.test.mjs).
The service supports migrating more Linux jobs, but “change every Ubuntu
label” would optimize provider coverage rather than Brainstrike's bill or
critical path. The next safe step is a cost-ranked, per-job same-head
measurement campaign, then move or resize only lanes whose rounded cost and
queue-plus-runtime improve.

## Local implementation follow-through

The cost-first changes authorized after this audit are applied in the current
worktree, with workflow contracts updated in the same change:

- PR Coverage moves from GitHub `ubuntu-latest` to
  `ubicloud-standard-2`, preserving the 2-vCPU/8-GB shape.
- Browser tests move to `ubicloud-standard-4`, matching their explicit
  four-way Turbo concurrency and the already-proven Playwright-container path.
- React Doctor, Claude Auto Review, and `@claude` handling move to
  `ubicloud-standard-2`; their permissions and GitHub OIDC settings are
  unchanged.
- The three-second required Unit fan-in moves from GitHub Arm to
  `ubuntu-slim` to reduce per-job rounding cost.
- Native Windows remains always-on after admission on GitHub Windows. GitHub
  Actions has no native job-level changed-path filter, and Brainstrike's
  settled CI contract prohibits adding a custom diff planner or routing layer.

At unchanged runtimes and standard Ubicloud rates, the four deterministic
runner changes above reduce this sample's list cost by about **$34.43 per 7.76
days / $133 per normalized month**, before GitHub allowances and Ubicloud's
credit. Native Windows remains outside this deterministic savings estimate.
Static remains on its measured Arm lane, and currently red scheduled
regression workflows remain unchanged until they can provide a trustworthy
same-head runner comparison.

## Evidence rules

- Product facts come from current Ubicloud documentation, current Ubicloud
  source, or GitHub's current documentation. Sources are linked beside claims.
- Vendor benchmark results are reported as vendor results, not independent
  measurements.
- A missing published capability is called undocumented, not impossible.
- Current public pricing wins over older blog and marketing copy.

## Runner catalog

### Documented, supported shapes

The current [runner-types documentation](https://www.ubicloud.com/docs/github-actions-integration/runner-types)
defines `ubicloud` and `ubicloud-standard-2` as aliases for a 2-vCPU x64 Ubuntu
24.04 runner. Unsuffixed labels default to Ubuntu 24.04; append
`-ubuntu-2204`, `-ubuntu-2404`, or `-ubuntu-2604` to pin an image. Arm labels
put `-arm` before the OS suffix, for example
`ubicloud-standard-4-arm-ubuntu-2404`.

| Family | Unsuffixed label pattern | Architecture | vCPU choices | RAM | Default-image disk |
| --- | --- | --- | --- | --- | --- |
| Standard | `ubicloud-standard-{n}` | x64 | 2, 4, 8, 16, 30 | 8, 16, 32, 64, 120 GB | 75, 150, 200, 300, 400 GB |
| Premium | account-level routing; source also declares `ubicloud-premium-{n}` | x64 | 2, 4, 8, 16, 30 | 8, 16, 32, 64, 120 GB | 75, 150, 200, 300, 400 GB |
| Standard Arm | `ubicloud-standard-{n}-arm` | arm64 | 2, 4, 8, 16, 30 | 6, 12, 24, 48, 90 GB | 86, 150, 200, 300, 400 GB |

Standard x64 uses AMD EPYC 9454P, with two advertised vCPUs per physical core;
premium x64 uses AMD Ryzen 9 7950X3D; arm64 uses Ampere Altra Q80-30, with one
advertised vCPU per physical core. These details and the table above come from
the current [runner-types page](https://www.ubicloud.com/docs/github-actions-integration/runner-types).

The implementation's immutable
[label catalog at `0b41c031`](https://github.com/ubicloud/ubicloud/blob/0b41c03111b345ccdda85d08e09f73a71e0af43c/config/github_runner_labels.yml)
also declares 60-vCPU standard x64/arm64 labels and direct premium labels for
Ubuntu 22.04/24.04/26.04. The public runner page says supported vCPU values end
at 30, and the public pricing page does not price 60. Treat 60 as
implementation-visible but **unsupported/unqualified**, not generally
available. The same caution applies to selecting direct premium labels instead
of the documented account toggle.

No current managed label is Windows, macOS, or GPU. There is also no 1-vCPU,
minimal-image, unprivileged-container shape corresponding to GitHub's
`ubuntu-slim`; the smallest Ubicloud runner is a 2-vCPU VM. This is established
by the complete live label catalog above, not by assuming that an unmentioned
port exists.

### Image compatibility and drift

Ubicloud says its x64 images and, since June 2026, its arm64 images are built
from GitHub's official `actions/runner-images` Packer templates. Ubicloud
rebuilds monthly after GitHub's releases and intentionally waits several days
before deployment, while GitHub describes GA images as updated weekly. The
images should be broadly compatible, but package and version differences are
an expected temporary condition; install a missing dependency explicitly and
do not assume day-zero image parity.
([Ubicloud runner types](https://www.ubicloud.com/docs/github-actions-integration/runner-types),
[GitHub runner-images lifecycle](https://github.com/actions/runner-images#available-images))

Ubuntu 26.04 is selectable at Ubicloud, but GitHub currently classifies its own
26.04 runner image as public preview. That makes 24.04 the conservative parity
target for required CI until the upstream image is GA.
([GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners))

The managed-runner docs expose vendor-built Ubuntu images only. A custom-image
control is not documented for this product; Ubicloud's separate Machine Images
service should not be assumed to apply to managed GitHub runners.

## GitHub-to-Ubicloud equivalence

GitHub's current private-repository standard Linux runner is 2 CPU, 8 GB RAM,
14 GB SSD on x64 or arm64. Public repositories receive 4 CPU/16 GB for the
standard Ubuntu label. GitHub larger Linux runners scale beyond those shapes.
([GitHub-hosted runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[GitHub larger runners](https://docs.github.com/en/actions/concepts/runners/larger-runners))

| Current GitHub label/class | Closest Ubicloud choice | Equivalence and caveat |
| --- | --- | --- |
| Private `ubuntu-latest`, `ubuntu-24.04`, or `ubuntu-22.04` | `ubicloud-standard-2` or pinned OS suffix | Same 2 CPU/8 GB, but 75+ GB disk rather than 14 GB. |
| Public standard Ubuntu | `ubicloud-standard-4` | Same 4 CPU/16 GB, much more disk, but GitHub's public standard runner is free. |
| GitHub larger Linux 2/4 CPU | `ubicloud-standard-2` / `-4` | CPU, RAM, and disk match (2/8/75 and 4/16/150). |
| GitHub larger Linux 8/16 CPU | `ubicloud-standard-8` / `-16` | CPU/RAM match; Ubicloud disk is smaller: 200 vs 300 GB and 300 vs 600 GB. |
| Private `ubuntu-24.04-arm` | no exact match | `standard-2-arm` preserves CPU but has 6 vs 8 GB RAM; `standard-4-arm` preserves/exceeds RAM but doubles CPU. |
| `ubuntu-slim` | none | GitHub's 1-core/5-GB, 15-minute, unprivileged container has no managed Ubicloud peer. |
| `windows-*`, `macos-*`, GPU | none | Keep on GitHub or evaluate a different provider. |

For public repositories, standard GitHub-hosted execution is free and
unlimited. For private repositories, included plan minutes are consumed before
paid usage. Ubicloud is billed separately, so moving work that is currently
free or still inside the GitHub allowance can increase cash spend even when
Ubicloud's marginal rate is lower.
([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions))

## Pricing and billing

The current [Ubicloud pricing page](https://www.ubicloud.com/docs/about/pricing#github-actions)
states monthly invoicing with per-minute granularity and a $2.50 monthly
account credit, described as 1,250 minutes of 2-vCPU runner time. That minute
count matches the premium 2-vCPU price, not the standard price.

| vCPU | Standard x64 | Premium x64 | Standard arm64 |
| ---: | ---: | ---: | ---: |
| 2 | $0.00125/min | $0.002/min | $0.00125/min |
| 4 | $0.00250/min | $0.004/min | $0.00250/min |
| 8 | $0.00500/min | $0.008/min | $0.00500/min |
| 16 | $0.01000/min | $0.016/min | $0.01000/min |
| 30 | $0.01875/min | $0.030/min | $0.01875/min |

The current implementation bills only runners that became ready and picked up
a job, rounds `(completion - ready_at)` up to a whole minute, and records the
actual VM family used.
([Ubicloud billing implementation](https://github.com/ubicloud/ubicloud/blob/0b41c03111b345ccdda85d08e09f73a71e0af43c/prog/github/github_runner_nexus.rb#L116-L147))

Against GitHub's current paid rates, documented standard Ubicloud x64 shapes
are about 4.2–4.8x cheaper at equal 2/4/8/16 CPU, while premium is about
2.6–3x cheaper. Standard arm64 is about 2.6–4x cheaper by CPU count, but its RAM
is not equivalent. The 30-vCPU comparison is necessarily approximate because
GitHub publishes a 32-vCPU tier. These are arithmetic comparisons of current
tables, not discounts guaranteed on a total bill.
([Ubicloud pricing](https://www.ubicloud.com/docs/about/pricing#github-actions),
[GitHub runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing))

Ubicloud's “7x cheaper” copy is inconsistent with its current pricing table;
do not use 7x in a budget. Older pages also quote obsolete $1 credits and
$0.0008/$0.001 standard pricing. The live pricing table is authoritative.

### Premium is a routing policy, not deterministic hardware

The documented premium path is an account-level console toggle and requires no
workflow edit. Ubicloud explicitly says that, when premium capacity is full,
it falls back to standard runners and bills the actual runner type.
([premium setup](https://www.ubicloud.com/docs/github-actions-integration/use-premium-runners),
[pricing behavior](https://www.ubicloud.com/docs/about/pricing#github-actions))

That is useful for availability but prevents a workflow label from proving
which CPU class ran. Before using premium for performance budgets, either:

1. accept and record the hardware variance in measurements; or
2. ask Ubicloud whether its implementation-visible direct premium labels are
   supported and fail/queue instead of falling back.

Do not infer the second behavior from the label file alone.

## Integration, isolation, region, and observability

The supported hosted setup is: add a valid card, install and authorize the
Ubicloud Managed Runners GitHub App for the intended account/repositories, then
change `runs-on` to an Ubicloud label. No PAT or runner-registration secret is
added to the workflow.
([Ubicloud quickstart](https://www.ubicloud.com/docs/github-actions-integration/quickstart))

Each job gets a clean KVM VM. Ubicloud passes a GitHub just-in-time runner
configuration at startup without storing it; the runner processes at most one
job; after completion Ubicloud decommissions the VM and deletes its block
device. Ubicloud retains job metadata including initiator, start, duration,
and hardware selection.
([Ubicloud runner security](https://www.ubicloud.com/docs/github-actions-integration/security))

Managed runners are currently placed automatically in Germany or Finland based
on fleet availability. They receive a public IPv4 address. Network locality can
therefore dominate dependency-, artifact-, image-, or service-heavy lanes,
especially when their dependencies are in North America. Firewall consumers
must use Ubicloud's changing, machine-readable IP range rather than hard-code a
snapshot.
([Ubicloud regions](https://www.ubicloud.com/docs/about/regions),
[public IP ranges](https://www.ubicloud.com/docs/networking/public-ip-ranges))

The console exposes requested/allocated vCPU, today's cost, and 30-day cost.
Ubicloud also advertises custom labels that can set workflow-level concurrency
limits and route jobs to dedicated pools, but detailed public configuration
guidance is absent; use that only with vendor support.
([February 2026 usage dashboard](https://www.ubicloud.com/docs/changelog/2026-02),
[October 2025 custom labels](https://www.ubicloud.com/docs/changelog/2025-10))

## Cache behavior

Every runner is ephemeral, so dependency stores, Docker layers, and build
outputs survive only through explicit remote caches. Ubicloud's transparent
cache is the supported path: it is enabled by default, requires no YAML change,
and intercepts standard `actions/cache`, `actions/setup-*`, supported
third-party cache actions, and Docker Buildx `type=gha` caching.
([Ubicloud Cache](https://www.ubicloud.com/docs/github-actions-integration/ubicloud-cache))

Current cache documentation promises 30 GB free per repository per week. It
evicts oldest entries above the limit and deletes entries not accessed for
seven days. Access defaults to the current branch/tag and default branch.
Cross-branch sharing can be enabled, but Ubicloud warns that doing so for a
public or untrusted repository permits cache-poisoning risk.

Ubicloud reports up to 4x faster cache downloads and 3x faster uploads. Its
vendor benchmark observed roughly 20–25 MB/s in both directions using GitHub's
cache from an Ubicloud runner, versus 80–100 MB/s download and 60–80 MB/s
upload through transparent cache. This measures cache transport, not whole-job
speed, and does not establish a Brainstrike result.
([transparent-cache benchmark](https://www.ubicloud.com/blog/github-actions-transparent-cache))

The older `ubicloud/cache` and `ubicloud/setup-*` forks are deprecated and less
maintained. They do not support Docker layer caching. Their only claimed edge
is higher save concurrency; do not migrate Brainstrike's standard cache actions
to them.

A 2025 premium announcement promises 100 GB, and current source gives
premium-enabled installations a 100-GB minimum, but the current cache docs say
30 GB without a premium distinction. Verify the live account quota in the
console before designing around 100 GB.
([premium announcement](https://www.ubicloud.com/blog/ubicloud-premium-runners-40-faster-builds-10x-larger-cache),
[current installation model](https://github.com/ubicloud/ubicloud/blob/0b41c03111b345ccdda85d08e09f73a71e0af43c/model/github/github_installation.rb#L35-L45))

## Startup characteristics

There is no current public startup SLA. A Ubicloud staff answer from February
2024 described a warm-pool expectation of 15–20 seconds and cold provisioning
of 50–60 seconds, with GitHub webhook/API delay as an additional source of
queue time. A January 2025 changelog says pool tuning removed another 2+
seconds from average provisioning, but gives no absolute replacement figure.
These are historical engineering observations, not a promise for the 2026
fleet.
([staff answer](https://github.com/ubicloud/ubicloud/discussions/1218#discussioncomment-8438697),
[January 2025 changelog](https://www.ubicloud.com/docs/changelog/2025-01))

For short jobs, measure trigger-to-start queue time separately from execution;
a faster CPU cannot recover a cold-start or webhook delay that dominates the
critical path.

## Vendor performance evidence and caveats

### Standard runners versus GitHub, 2025-01-07

Ubicloud's [price-performance page](https://www.ubicloud.com/docs/github-actions-integration/price-performance)
publishes these one-day charts:

| Open-source workload | GitHub 2 vCPU | Ubicloud 2 vCPU | Ubicloud 4 vCPU | Shown speedup vs GitHub |
| --- | ---: | ---: | ---: | ---: |
| Facebook Folly C++ build/test | 35m 49s | 24m 45s | 13m 16s | 1.45x / 2.70x |
| Google XLS Bazel test | 3h 18m 19s | 1h 31m 04s | 47m 14s | 2.18x / 4.20x |
| PeerDB Docker build | 32m 45s | 16m 56s | 10m 36s | 1.93x / 3.09x |
| Supabase TypeScript check | 4m 52s | 3m 14s | 2m 23s | 1.51x / 2.04x |
| NASA Astrobee C++ build/test | 1h 19m 47s | 50m 43s | 32m 08s | 1.57x / 2.48x |

The page supplies no commit SHAs, workflow definitions, cache state,
repetition count, variance, queue-time treatment, or raw runs. The samples
predate current pricing and images. They show that workload sensitivity is
large; they do not predict Brainstrike's result.

### Premium Ryzen versus standard EPYC, 2025 fleet trial

Ubicloud's [Ryzen/EPYC study](https://www.ubicloud.com/blog/does-mhz-still-matter)
reports a 32–33% PassMark single-core advantage for Ryzen. In an observational
fleet sample of 146,725 Ryzen jobs and 206,411 EPYC jobs, reported durations
were 80 vs 129 seconds at p50, 228 vs 305 at p75, 412 vs 512 at p90, and 1,077
vs 1,234 at p99. Ubicloud itself says the gain shrank on longer jobs because
network transfer became the bottleneck.

This is stronger volume evidence than the five project charts, but it is still
vendor-run and non-randomized. Different workload mixes, cache warmth, image
state, host utilization, and premium fallback can confound the comparison.
Use it to choose what to measure, not as a promised speedup.

### Arm claims

Old “100x price-performance” material compared native Ubicloud arm64 with x64
QEMU emulation and multiplied that runtime difference by old pricing. GitHub
now offers native arm64 and Ubicloud now uses GitHub's official Arm image
templates. The old claim is relevant only when replacing an actual QEMU Arm
lane, not as a current Ubicloud-versus-GitHub-native benchmark.
([current Arm migration docs](https://www.ubicloud.com/docs/github-actions-integration/migrate-to-arm-runners),
[historical Arm post](https://www.ubicloud.com/blog/ubicloud-hosted-arm-runners-100x-better-price-performance))

## Brainstrike live workflow and cost audit

### Scope and accounting method

The live repository and GitHub Actions API were sampled from
`2026-08-21T00:00:00Z` through `2026-08-28T18:19:12Z` (7.76 days), at exact
`main` head `68bde8bb5bad1172157bbebc7fe518dfd4a3bd61`. The audit enumerated every
workflow run in that window, then every job, runner label, start/completion
timestamp, conclusion, and step. It rounded each allocated job up to a whole
minute, matching both [GitHub's current rule](https://docs.github.com/en/billing/reference/actions-runner-pricing)
and Ubicloud's implementation.

The result is a **list-price estimate**, not an invoice. It excludes GitHub's
account-level included minutes, Ubicloud's monthly $2.50 credit, artifact/cache
storage, and Claude/model charges. The authenticated GitHub token could read
repository jobs but received `404` from the user billing-usage endpoint, so the
account's actual plan allowance and billing-cycle consumption are not available
here. GitHub gives private repositories 2,000, 3,000, or 50,000 standard-runner
minutes per month depending on plan; larger runners never consume that
allowance. ([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions))

The live GitHub cache API reports 78 active entries totaling 5.15 GB, below the
repository's included 10 GB cache allowance. That makes runner minutes the
clear measured target today, although active size does not prove that no
earlier hourly peak accrued a storage charge.

Ubicloud cost is necessarily a range. The workflow label says
`ubicloud-standard-4`, but the account-level Premium toggle can route that
label to premium hardware and bills the actual hardware used. Only the
Ubicloud console/invoice can resolve the split.

### The migration is partial

The required [`Test` workflow](../../../.github/workflows/test.yml) is the only
workflow with Ubicloud runners today.

| Current runner | Jobs on it |
| --- | --- |
| `ubicloud-standard-4` | Build; four Unit shards; Native Electron Package; Web E2E; Desktop E2E |
| GitHub `ubuntu-24.04-arm` | Static; three-second Unit fan-in |
| GitHub `ubuntu-latest` | Browser tests; main failure/recovery notifiers |
| GitHub `ubuntu-slim` | 120-second quiet-head admission |
| GitHub `windows-latest` | Native Windows |

Every other active workflow is GitHub-hosted: Coverage, React Doctor, Claude
review/mention handling, nightly coverage, scheduled web/desktop/performance
E2E, storage cleanup, and their notifiers. Nightly coverage also has real
Windows and macOS durability rows, which Ubicloud cannot replace.

### Observed runner minutes and list cost

| Runner label | Allocated rounded minutes | Cost in sample |
| --- | ---: | ---: |
| `ubicloud-standard-4` | 23,255 | $58.14 standard / $93.02 all-premium |
| GitHub `ubuntu-24.04-arm` | 4,338 | $21.69 |
| GitHub `ubuntu-latest` | 8,808 | $52.85 |
| GitHub `ubuntu-slim` | 1,600 | $3.20 |
| GitHub `windows-latest` | 2,489 | $24.89 |
| GitHub `macos-latest` | 24 | $1.49 |
| **Total before allowances/credits** | **40,514** | **$162.25 standard / $197.14 all-premium** |

If this 7.76-day workload repeated uniformly for 30 days, the list-price run
rate would be about **$627/month with standard Ubicloud** or **$762/month with
all-premium Ubicloud**, before GitHub included minutes and Ubicloud's credit.
The GitHub-hosted slice alone extrapolates to about $402/month list price; the
existing Ubicloud slice extrapolates to about $225 standard or $359 premium.
These are workload-normalized estimates, not a forecast of PR volume.

The already-migrated 4-vCPU jobs would cost $279.06 for the same rounded
minutes on GitHub's equivalent paid 4-core Linux class, versus $58.14 standard
or $93.02 premium on Ubicloud. This is not a historical savings claim—runtime
would differ—but it confirms the present equivalent-capacity rate advantage.

### Workflow cost concentration

- The required `Test` workflow accounts for $119.40 of the sample at standard
  Ubicloud rates: $58.14 Ubicloud, $21.69 GitHub Arm, $11.98 GitHub Linux,
  $3.20 slim, and $24.40 Windows.
- PR Coverage alone used 3,252 GitHub Linux minutes: **$19.51**.
- Claude auto-review used 1,085 GitHub Linux minutes ($6.51), React Doctor 755
  ($4.53), and `@claude` handling 350 ($2.10). Model charges are separate.
- The scheduled web, performance, and both desktop regressions failed on all
  eight sampled days. The latest logs show test/assertion failures after the
  runner was provisioned, not runner allocation failures. They are still
  useful correctness signals, but not clean A/B performance baselines until
  they are green.

### Cancelled-head waste is an architecture cost

Of 654 `Test` runs, 208 concluded cancelled. The existing two-minute admission
gate prevented some immediate fan-out, but 116 runs passed admission and were
superseded later. Those late-cancelled runs consumed **$23.14** at standard
Ubicloud rates in this sample. Another 48 early cancellations triggered the
workflow's intentional fail-closed required-check jobs and cost **$1.68**
mostly through one-minute rounding. Together that is **$24.82 in 7.76 days**,
roughly a $96/month run rate if the same push pattern continues.

The next push arrived a median 585 seconds after those 116 admitted runs. A
ten-minute admission delay would have caught 59 of them and avoided at most
$11.26 of their current work, but the longer slim jobs would add about $7.68
and every surviving head would wait eight extra minutes. The estimated net is
only $3.58 per sample at a severe feedback-time cost. Raising the global sleep
is therefore the wrong architecture. Batch remote pushes when practical, and
reduce the cost of the jobs that can be cancelled rather than making every
final head wait.

### Cost-ranked migration plan

1. **Resolve the Premium toggle and cache quota first.** Premium is 60% more
   expensive at the same vCPU count, so it must reduce Brainstrike job runtime
   by at least 37.5% to break even. Ubicloud's vendor p50 nearly reaches that
   threshold, while its p90 does not. For a cost-first policy, disable Premium
   unless same-head Brainstrike runs meet the threshold. Confirm whether this
   installation has 30 or 100 GB of cache at the same time.
2. **Canary PR Coverage on `ubicloud-standard-2` and `-4`.** It is the largest
   unmigrated x64 lane at $19.51 per sample, already requires x64 native addon
   builds, and Ubicloud x64 is proven in the required workflow. At unchanged
   duration it would cost $4.07 on standard-2 or $8.13 on standard-4. Compare
   both because the current workflow deliberately runs up to four tasks on a
   2-core GitHub host; standard-4 may improve both cost and wall time.
3. **Canary Browser tests on `ubicloud-standard-4`.** It used 1,928 rounded
   minutes ($11.57). The exact Playwright-container pattern is already green
   in Ubicloud Web E2E, and the job caps Turbo at four. Same-duration cost is
   $4.82 standard. This move requires updating the deliberate five-job
   Ubicloud contract and its paired test, not just editing a label.
4. **Move short x64 automation to standard-2 after OIDC probes.** React
   Doctor, Claude auto-review, and `@claude` handling total 2,190 GitHub Linux
   minutes ($13.14). Same-duration standard-2 is $2.74; premium-2 is $4.38.
   Claude's `id-token: write` path needs a real canary before migration.
5. **Split the ARM decision.** Move the three-second `Unit` fan-in to
   `ubuntu-slim`: 609 ARM minutes cost $3.05 solely because each tiny job is
   rounded up; slim would cost $1.22. Benchmark Static separately on
   `ubicloud-standard-2` x64 and `ubicloud-standard-4-arm`. Static used 3,729
   ARM minutes ($18.65); same-duration alternatives cost $4.66 and $9.32,
   respectively. The 2-vCPU Ubicloud Arm shape has only 6 GB RAM versus the
   current 8 GB, so it is not a safe unmeasured substitute.
6. **Do not search for a Ubicloud Windows substitute.** Native Windows is the
   biggest non-Linux residual at $24.40 and Ubicloud has no managed Windows
   runner. It is not a required status check. A conservative, pre-allocation
   affected-path/dependency gate—run on uncertainty, never silently skip—can
   save more than a provider hunt. Preserve the nightly cross-platform
   `pg_textsearch` durability rows on GitHub Windows/macOS.
7. **Move scheduled Linux lanes only after their baselines are green.** The
   compatibility path is strong—current required web/desktop E2E already runs
   on Ubicloud—but the remaining scheduled Linux total is small beside Test
   and Coverage, and seven/eight-day-red suites cannot establish a trustworthy
   runner comparison.
8. **Keep quiet-head admission on `ubuntu-slim`.** There is no direct managed
   Ubicloud equivalent and the maximum same-duration saving is only $1.20 in
   this sample. Queue variance could erase its purpose.

At unchanged runtimes, moving all remaining GitHub x64 Ubuntu minutes to
standard-2 and the current ARM minutes to the RAM-safe 4-vCPU Ubicloud Arm
shape would save at most about **$52.68 per sample / $204 per normalized
month**, before allowances. That is a ceiling, not a bulk-migration proposal:
per-job sizing and current GitHub allowance consumption determine the cash
result.

## Brainstrike cost-first adoption gate

The architectural improvement is a measured heterogeneous fleet, not a global
runner-label substitution:

1. Keep Windows, macOS, and `ubuntu-slim` on GitHub. They have no documented
   managed Ubicloud equivalent.
2. Preserve current required-job runner contracts until same-head probes show
   an improvement. Existing Brainstrike evidence already shows that architecture
   and vCPU count do not automatically produce a speedup.
3. For each additional Ubuntu lane, run at least three sequential same-head
   samples on the existing runner and the proposed Ubicloud shape. Record queue
   time, setup/cache restore, execution, cache save, total critical-path time,
   success, actual CPU family, and rounded cost. Compare p50 and worst observed,
   not the best run.
4. Try premium first on short CPU-bound jobs and larger standard shapes only
   where the task graph can use the extra parallelism. Network-heavy lanes may
   gain little because runners are in Europe and premium may fall back.
5. Migrate QEMU Arm work to native arm64. Do not move already-native GitHub Arm
   merely from an old marketing claim; Ubicloud Arm has less RAM at equal vCPU.
6. Confirm transparent cache is enabled in the console. Keep standard GitHub
   cache actions, preserve architecture in cache keys for native output, and
   use Buildx `type=gha` for Docker layers.
7. Roll out one non-required or scheduled Linux lane first. A provider or image
   issue must remain visible; do not add automatic provider fallback.

The adoption gate for a lane should be explicit: lower p50 and acceptable
worst-case total latency, no new correctness/image failures, and lower expected
cash cost after accounting for GitHub included minutes. If it passes only on
runtime but not queue-plus-runtime, it does not make feedback faster.

## Open vendor confirmations before relying on edge features

- Are direct `ubicloud-premium-*` labels supported, and do they queue/fail
  rather than fall back to standard hardware?
- Are 60-vCPU labels generally orderable, what RAM/disk/rate applies, and what
  concurrency quota is available?
- Is this installation's cache quota 30 GB or 100 GB with premium enabled?
- Is any managed custom-image mechanism available for GitHub runners?
- What current queue/start p50/p95 and concurrency quota apply to this account?
