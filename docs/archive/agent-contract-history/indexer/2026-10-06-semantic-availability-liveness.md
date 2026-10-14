# Semantic availability during index progress

The live smoke test exposed a semantic button stuck at “Native vector availability
is being verified” while text search and indexing continued. The desktop provider
publishes a new dependencies object on progress/readiness observations every two
seconds. Its execution callback remains stable until actual execution authority
changes. The controller previously used the whole dependencies object as the
availability lifetime, discarding held coverage results at each refresh.

RED used the actual desktop provider and controller with distinct deferred native
coverage calls. Two two-second progress polls occurred before the first valid
coverage completed; semantic availability stayed false because its observation
had been retired. This proves that cancellation defect, not the separate live
failure where the native query target disappeared.

Availability lifetime now follows capability, complete profile, execution
callback, selected collection and root bindings. Progress/readiness changes
request a fresh observation without retiring an in-flight check in that authority.
Updates during that check coalesce into one follow-up. Existing strict native
status/coverage checks still own admission. Actual authority changes render
unavailable immediately and discard the old result. No new timer, timeout, retry,
optimistic result or persistent store was added.

The regression proves slow coverage can complete across multiple progress polls,
then the follow-up reflects current incomplete-scan readiness. Held-result controls
cover store/grants/profile/query plan, capability, root binding and collection
changes. A fresh replacement-scope failure stays visible after the old valid
coverage completes late; held coverage failure never enables semantics.

Local validation from the repaired checkout:

- `apps/desktop`: `pnpm exec vitest run src/__tests__/renderer/components/native-search-provider.test.tsx -t "slow availability" --bail=1`: RED failed, GREEN passed; 23 tests omitted by selection.
- `apps/desktop`: `pnpm exec vitest run src/__tests__/renderer/components/native-search-provider.test.tsx`: 46 passed.
- `packages/app-shell`: `pnpm exec vitest run src/__tests__/use-workspace-search-controller.test.tsx`: 23 passed.
- Repository root: `pnpm --filter @brainstrike/app-shell type-check`: production and test types passed.
- Repository root: `pnpm dlx ultracite fix packages/app-shell/src/use-workspace-search-controller.ts apps/desktop/src/__tests__/renderer/components/native-search-provider.test.tsx`: passed.

Receipts: `/Users/seandearnaley/Documents/brainstrike-m2-completion-20261005/semantic-availability-liveness/REVIEW.json` and adjacent RED/GREEN logs.
Focused tests emit mocked missing-DB-context and React act warnings; they are not
a console-clean claim or a full regression pass. Combined app proof and full
local validation belong to the delivery coordinator.

**CI is disabled due to cost; validation must run locally.**
