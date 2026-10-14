# E2E lane coverage — evidence

Supports `docs/agents/ci-quality.md` § "E2E lane-coverage contract" (BST-1010,
BST-1059). Read this before changing `scripts/e2e-lane-coverage.mjs`, the
shared title/tag parser, `LANE_WORKFLOW_FILES`, a `test:e2e:lane:*` script, or
the web full-regression runner and its workflow timeout.

`scripts/e2e-lane-coverage.mjs` (paired test:
`scripts/__tests__/e2e-lane-coverage.test.mjs`, run in the Static job via
`pnpm test:scripts`) statically proves that every Playwright spec in `apps/web`
and `apps/desktop` is selected by some lane CI actually invokes.

BST-1010 was filed as a *nightly selection audit* — run the full suite, diff it
against affected-selection. Both premises were wrong and the ticket was reduced:
the nightly already exists (`web-e2e.yml` cron 07:37, `desktop-e2e.yml` cron
07:53, both running `test:e2e:lane:full-regression`), and the cited bug class
(BST-891/816/817) is not a selection bug at all. It is lane wiring, computable
from source with no suite run. Two live instances the guard found on `main`:
`workspace-index-background-indexing.test.ts` carried `@web-indexing`, a tag no
lane grepped, on a `@stateful` describe that the broad pass grep-inverts; and
`production-csp.test.ts` carried `@stateful`, no lane tag, and appeared in zero
lane file lists. Both ran in no CI job. Each got a serialized dedicated lane —
deleting the `@stateful` tag to sweep them into the parallel broad pass would be
wrong, since one writes to the DB and the other runs PGlite search plus a real
local embedding.

Three assertions, over both apps: every `@web-*`/`@desktop-*` tag routes at
least one title somewhere; every TEST is reachable from at least one lane; every
explicitly targeted `test:e2e*` package script and inline workflow lane names
files that exist and selects a non-empty set. The third assertion intentionally
does not claim to model broad package scripts with no file list: their default
project selection can include suites outside this lane sweep (notably web
performance), while targeted scripts must state `--project` so the answer is
exact. The raw package-script floor protects discovery of the overall
`test:e2e*` surface. A separate floor is applied to the list this assertion
actually consumes: one explicitly targeted non-lane desktop invocation and none
for web today. That applicable count is printed in every verdict, and the paired
money test removes the desktop invocation and observes the floor fail.

**Reachability is resolved per test title, not per spec file** (review finding on
PR #2180). A file-granular answer marks a whole spec covered as soon as any ONE
of its titles is selected, so an untagged `@stateful` test sitting beside an
ordinary test the broad pass picks up reads as fully covered while running in no
CI job — the guard's own bug class, one level down. The failure output names the
dark `file:line` and title, because naming the file alone does not tell the
author which test is dark. The shape is not hypothetical: 11 real spec files
currently mix tag sets within one file (e.g. `git-panel.desktop.test.ts` has one
`@smoke` test that only the smoke lane can reach plus six the regression project
covers, and `embedding-worker-renderer.memory.desktop.test.ts` has one untagged
test that only full-regression reaches among eight `@desktop-embedding-*`
siblings). All are currently covered; the per-title check is what keeps them
honest. A whole-file `KNOWN_UNREACHABLE_SPECS` exemption is valid only while
EVERY title in the file is dark — partial coverage fails the entry rather than
letting it hide the titles still dark.

What holds it honest:

- **Selection is modelled exactly, not heuristically.** Reachability applies real
  Playwright semantics (explicit file list, project `grep`/`grepInvert`,
  command-line `--grep`/`--grep-invert`) to the real title paths parsed from each
  spec's AST via `listPlaywrightTitleEntries` in the shared
  `e2e-playwright-title-tags.mjs`. Anything unmodellable — an unknown
  `--project`, a positional that is not a spec path, a `--flag value` form the
  parser does not know, a `tag` that is not a literal — THROWS rather than being
  assumed benign.

  `titlePath` reproduces `TestCase._grepTitleWithTags()` exactly: for each
  ancestor suite its title THEN its tags, then the node's own title, then its own
  tags, space-joined. Two things that are easy to get wrong and were verified
  against real Playwright 1.61 `--list` rather than assumed:

  - **Tags inherit.** A tag on a describe routes every test nested inside it.
  - **`{ tag: '@x' }` counts.** Playwright's options form is NOT part of any
    title string, but it IS in the grep string. Reading title literals only made
    the guard wrong in both directions and hid three real desktop orphans
    (`agent-devtools`, `local-runtime-probe`, `secrets-settings` — each a
    `test.describe(..., { tag: '@smoke' }, …)` that the `regression` project
    grep-inverts and the smoke lane's file list omitted). There are 23
    options-form tag usages across `apps/*/e2e`; the array form
    (`tag: ['@a', '@b']`) is supported too.

  Both sibling consumers of this parser — `check-e2e-destructive-tags.mjs` and
  `check-e2e-readiness-contracts.mjs` — were silently affected by the same gap: a
  `{ tag: '@destructive' }` or `{ tag: '@stateful' }` describe was invisible to
  them, so each would have reported a FALSE POSITIVE on it (over-strict, not
  under-strict). No spec uses those two tags in options form today, so both
  scripts' real-repo verdicts are unchanged — but they are now correct for that
  shape rather than accidentally unexercised.
- **Only CI-invoked lanes supply coverage.** A lane is CI-invoked if a scoped
  workflow runs it or the `full-regression` aggregate runner references it. Detached
  package scripts cannot mark a spec covered merely by existing.
- **`LANE_WORKFLOW_FILES` is explicit, and that is the safe direction.** The
  `@desktop-embedding-*` lane is written inline in `desktop-e2e.yml` rather than
  as a package script, so workflows must be scanned. An inline lane in an
  unlisted workflow makes the guard report its specs as unreachable (loud red),
  never the reverse. Scanning every workflow is the UNSAFE direction:
  `local-desktop-e2e.yml` is a dispatch-only whole-suite shard run, and counting
  it would mark every desktop spec reachable and make the sweep vacuous.
- **Floors and self-cleaning exemptions.** `MINIMUMS` refuses to report a green
  when discovery collapses, and floors BOTH spec files and test titles — a parser
  regression returning zero titles per file would leave the file count healthy
  while every reachability question went vacuous. `KNOWN_UNREACHABLE_SPECS`
  entries fail if the listed spec becomes reachable, becomes only partly dark, or
  stops existing, so an exemption cannot rot into a permanent hole. It is
  currently empty after the inline desktop embedding lane adopted its former
  crash-b orphan.
- **The money test.** Per the BST-836 lesson (`guard-script-entrypoints.md`), the paired test drives the
  checker against a synthetic fixture repo carrying a planted orphan tag and
  orphan spec and asserts a non-zero exit, plus a clean control fixture, plus
  failure paths for a dangling lane file, a grep that matches nothing, a lane no
  CI entrypoint reaches, and — the case that verifies per-title granularity — a
  file holding one covered test and one dark sibling. That last case was
  control-tested against the pre-fix per-file logic and goes red there, which the
  other fixtures do not.

**Full-regression execution is fail-late, not shell-short-circuited (BST-1059).**
`apps/web` names the broad pass and ten serialized stateful/destructive lanes as
separate package scripts. `scripts/run-e2e-lane-sequence.mjs` invokes every one,
records each result, and exits non-zero after the final lane if any failed. A
failure in the broad or middle lanes therefore cannot starve tail lanes. The
runner also appends a unique `--output=test-results/<lane>` argument to every
Playwright invocation; later lanes may clean their own subdirectory but cannot
erase an earlier failure's traces, and the workflow uploads the parent
`test-results/` tree recursively.

The workflow remains bounded: lane-level Playwright global timeouts total 130
minutes, eleven fresh web-server starts are capped at one minute each, and
`web-e2e.yml` allows 165 minutes total, leaving 24 minutes for install/build
overhead. Do not replace the runner with an `&&` chain or reduce the workflow
timeout below the aggregate lane and startup budgets. The runner contract test
derives that inequality from every invoked lane's declared timeout and the
job-scoped workflow timeout.

**What a green does NOT prove:** that an externally cancelled or job-timed-out
run completed. The aggregate runner closes the ordinary lane-failure blind
window and prints per-lane START/PASS/FAIL plus a final failure summary, but a
static reachability verdict is not a run-artifact audit.
