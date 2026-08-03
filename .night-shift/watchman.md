## Performance E2E timings include harness delay

**Learning:** `apps/web/e2e/performance/real-world-performance.test.ts` starts its interaction timers before Playwright locator actions and keeps fixed `waitForTimeout` calls inside the measured intervals. The re-render action measurement includes a 2-second settle wait, and the scroll measurement includes two 100ms waits.

**Action:** Treat those thresholds as end-to-end interaction budgets, not isolated renderer-cost metrics; separate actionability, input scheduling, and settling before attributing a regression to rendering.

## Nightly package coverage shares one timeout domain

**Learning:** `.github/workflows/nightly-coverage.yml` runs every non-DB `test:coverage` task in one `Run package coverage` step with a 30-minute timeout. If that step times out, the later DB coverage, preparation, threshold, merge, and report steps do not run.

**Action:** Prefer sharding or isolating the package coverage critical path over increasing its timeout when growth in one package prevents later coverage stages from executing.

## Explorer toolbar overlap is a shared layout mechanism

**Learning:** The shared Explorer toolbar's right-cluster controls are used by both Web and Desktop E2E. If they overlap, Playwright can report the view-filter control as the click interceptor while the geometry assertion measures the same layout defect.

**Action:** Treat correlated Web and Desktop failures around `View filters` as one responsive-toolbar layout mechanism; verify the controls' geometry before classifying either as timing flake.

## Assistant tab overflow and scroll availability are distinct

**Learning:** Creating an assistant thread activates the newest tab and scrolls it into view, while left/right tab controls reflect the scroll viewport. Overflow alone does not establish which direction is available.

**Action:** In assistant-tab E2E, set and observe `scrollLeft` before asserting directional-control state; keep activation/scroll-into-view and arrow-availability coverage separate.

## Workflow windows must carry pending run identities

**Learning:** A workflow run that is pending at a collection boundary cannot be rediscovered from later completed-run keys alone: its creation time may fall outside the next window.

**Action:** Keep pending workflow run identities in the collector's watched set and fetch them on the next wake until completion; excluding them from completed watermark keys is not sufficient.
