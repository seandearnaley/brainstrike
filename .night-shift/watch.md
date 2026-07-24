## Performance E2E timings include harness delay

**Learning:** `apps/web/e2e/performance/real-world-performance.test.ts` starts its interaction timers before Playwright locator actions and keeps fixed `waitForTimeout` calls inside the measured intervals. The re-render action measurement includes a 2-second settle wait, and the scroll measurement includes two 100ms waits.

**Action:** Treat those thresholds as end-to-end interaction budgets, not isolated renderer-cost metrics; separate actionability, input scheduling, and settling before attributing a regression to rendering.

## Nightly package coverage shares one timeout domain

**Learning:** `.github/workflows/nightly-coverage.yml` runs every non-DB `test:coverage` task in one `Run package coverage` step with a 30-minute timeout. If that step times out, the later DB coverage, preparation, threshold, merge, and report steps do not run.

**Action:** Prefer sharding or isolating the package coverage critical path over increasing its timeout when growth in one package prevents later coverage stages from executing.
