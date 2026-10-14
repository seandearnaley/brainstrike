# Red `main` notifier — evidence

Supports `docs/agents/ci-quality.md` § "A red `main` announces itself" and its
five subsections (BST-1301). Read this before proposing to change what
`notify-main-failure` / `notify-main-recovery` watch, their `!cancelled()`
guard, the label step, or the issue lifecycle of any tracking notifier. The
contract holds the rules; this file is the record of why.

Corrected after extraction (verified against `.github/workflows/test.yml` and
`scripts/__tests__/ubicloud-runner-contract.test.mjs`): `Native Windows` is
always-on after admission, not "affected"-gated — the word was removed below.

`main` broke twice on 2026-08-15, and both times the only reason anyone found
out was an unrelated PR tripping over it hours later:

| Run | Failing step | Cause |
| --- | --- | --- |
| `31872259629`, `31872457744` | `Static` › `Lint` | `noUnsafeOptionalChaining` in `packages/app-shell/.../workspace-snapshot-io.test.ts` (#2437) |
| `31894054632` | `Static` › `Lint` | formatter drift on `it.each` in `packages/file-system/src/__tests__/path-validation.test.ts` (#2440), fixed by #2452 |

**The gate was never missing.** `test.yml` has always subscribed to
`push: branches: [main]`, so Static/Unit/Build evaluate every merged commit,
and all three runs above failed correctly. What did not exist was anyone being
told — the red run sat in the Actions tab while every branch inherited the
breakage.

The mechanism is toolchain drift. A PR's CI judges it under the
linter/formatter **on its base at the time that run happened**. Both PRs above
were authored and went green under Biome 2.5.2, then merged after #2447 landed
2.5.8, which narrowed one rule and changed one formatting decision. Nothing
re-checks an already-approved PR against the post-merge toolchain, so the
verdict goes quietly stale and the failure materialises for the first time on
`main` — where it blocks every branch and looks unrelated to whoever hits it
next. The same shape applies to any bump that can change a verdict: Biome,
ESLint, TypeScript, or a lint-rule guard script.

`test.yml`'s `notify-main-failure` job closes the reporting half. It fans in
from `static`, `unit` and `build`; when any of them reports `failure` on a
`push`, it opens (or comments on) a single `main-broken` tracking issue naming
the failed checks, the commit, the run, and the toolchain-drift hypothesis to
check first. Its sibling `notify-main-recovery` closes that issue on the next
push where all three are green.

#### The scope line is required-check status, not "important lanes"

The ruleset requires exactly **Static, Unit, Build, Web E2E and Desktop E2E**.
Those five are the only checks that can block *every* branch, which is the
everyone-trips-over-it breakage class this job targets — so required-check
status, not perceived importance, is where the line is drawn. The two E2E lanes
are then excluded on a **second, independent** ground: they are the documented
flaky-headless class, and a canary that cries wolf gets muted, which is the
exact failure this job exists to prevent. Persistent E2E breakage is still
caught within 24h by the scheduled Linear alerts in `web-e2e.yml` /
`desktop-e2e.yml` (`nightly-linear-alerts.md`).

That leaves `Browser tests`, `Native Windows`, and
`Native Electron Package`, which also run on pushes to `main` and are also
**not** notified. Not on
flakiness grounds — `browser-tests` "must first prove itself deterministic"
per its own header, which makes it *pending*, not excluded — but because none
of them is a required check. A red one does not block anyone else's branch, so
it is not this job's class of problem. If any of them is ever promoted into the
ruleset, it belongs in the notifier's `needs:` at the same time.

#### `== 'failure'` is necessary but NOT sufficient — `!cancelled()` is what makes cancelled runs silent

This was previously documented the other way round, and the claim was wrong.
`needs.<job>.result == 'failure'` does **not** by itself mean "the code
failed", because neither watched job is a leaf verdict:

- every admission-gated job (`static`, `build`, `unit-shard`, …) opens with a
  `Require successful admission` step that `exit 1`s whenever
  `needs.admission.result != 'success'`; and
- `unit` is a ~5-minute fan-in over the `unit-shard` matrix whose check is
  `[ "$SHARD_RESULT" != "success" ] && exit 1` — the very `!= 'success'` shape
  the notifier's own condition avoids.

Both therefore **launder a cancelled upstream into a `failure` result**. This
is observed, not theoretical: on runs `31903009051`, `31900478128` and
`31900226011` (all 2026-08-15) a cancel landed while `admission` was in its
120-second sleep, `always()` still dispatched the downstream jobs, and Static,
Unit **and** Build all reported `failure` on a run that tested nothing. Under
`always()` the notifier would have filed *"main is red: Static, Unit, Build
failed"* for a cancellation. (Those three were `pull_request` events that the
push guard would also have caught — but the mechanism is not PR-specific, and
leaning on the push guard for it would be an accident rather than a design.)

The actual guard is therefore **`if: !cancelled()`**, not `always()`: it still
runs when a need *failed*, which is the whole point, but never when the run was
cancelled. `== 'failure'` is retained as the necessary half.

Two related properties worth knowing:

- `unit`'s `!= 'success'` check is **deliberately left alone**. Its shape is a
  branch-protection contract (`test.yml`'s fan-in comment): anything but
  success must fail the required `Unit` check *loudly* rather than grey out the
  merge box. Compensating in the notifier is the change that does not alter
  what a required check reports.
- Residual, accepted, and deliberately not suppressed: if `admission` ever
  genuinely **fails** on a push (never yet observed), all three gated jobs
  report `failure` and the issue body blames the code. That is loud rather than
  silent, "all three at once" is itself the tell, and the linked run shows the
  real cause. Gating the notifier on admission success would trade a rare
  wrong-hypothesis issue for a silent `main` with no verdict at all.

#### Green `main` closes the issue

Label-keyed de-duplication was copied from the nightly notifiers, but the
**lifecycles differ**. For `web-e2e` / `nightly-coverage` the failure recurs on
a 24h cadence and the issue closes when fixed, so the de-duplication window is
roughly the incident window. A red `main` is the opposite: the incident is
typically over within the hour (force-fix or revert) while the issue stays open
until a human closes it.

Left alone, that degrades into a stale-issue trap. Incident #1 leaves an open
issue titled `main is red: Static failed (2026-08-15)`; incident #2 three weeks
later — a Build failure, say — would open nothing and instead append a comment
to that mistitled, wrong-dated issue. It would never surface in triage, and
anyone who unsubscribed from the first would hear nothing. That is the canary
getting muted: the same failure mode the E2E exclusion above argues against.

`notify-main-recovery` closes the loop, so the de-duplication window equals the
incident window and each incident gets its own correctly-titled issue. It
closes *every* open `main-broken` issue rather than the first, so the
"at most one open" invariant is self-healing. Push runs on `main` share the
concurrency group `Test-refs/heads/main` with `cancel-in-progress: false` and
are therefore serialized, so recovery cannot race the notifier.

#### Prevention is out of scope

This is detection only. Requiring branches to be up to date before merge would
stop a stale-based PR from landing in the first place, but that is a
branch-protection setting and therefore the repo owner's call, not a workflow's.

#### Constraints any change must preserve

It adds **no new trigger** to `test.yml` (see `coverage.yml`'s header for why a
new trigger here greys out the merge box), neither job is a **required status
check**, and both stay on GitHub `ubuntu-latest`. These five-second reporting
jobs do not justify an additional managed-runner allocation; the notifier
contract rejects Ubicloud assignments. The `gh`
steps are reporting rather than gating, so they are listed in
`check-ci-parity.test.mjs`'s `PROVISIONING_STEPS` — `pnpm check` must not
mirror them, because running them locally would file and close GitHub issues.

Every tracking notifier's label step uses `gh label create --force` and **no**
`2>/dev/null || true`. That idiom absorbs the expected "label
already exists" and a genuine failure (token not elevated, API 5xx, org label
restrictions) indistinguishably; since the label does not exist until the first
red `main`, a swallowed failure on that very first run makes the next step's
`gh issue create --label` hard-fail and nothing gets filed — reproducing the
"red run sits unseen in the Actions tab" outcome one level up. `--force`
PATCHes an existing label instead of erroring, so a non-zero exit means only a
genuine failure. Each label step annotates that the tracking issue cannot be
filed or de-duplicated, then fails before any unlabelled issue can be created.

The four scheduled web, desktop, coverage, and performance GitHub-Issue
notifiers that once shared this label step were retired by BST-1915; scheduled
failures now go to Linear (`nightly-linear-alerts.md`).

Contract coverage lives in
`scripts/__tests__/main-failure-notifier-contract.test.mjs` and runs in the
Static job through `pnpm test:scripts`. Its control tests pin all four
properties above: dropping a watched job, reverting `!cancelled()` to
`always()`, restoring the `|| true` suppression, or deleting the recovery job
each make the contract fail.
