# Electron collection readiness

Supports `ci-quality.md` § "Desktop Electron provisioning": wait for the collection
named picker or the loaded single-set label before selecting a collection in E2E.
The strict embedding/search cases in
`apps/desktop/e2e/embedding-worker-renderer.backfill-search.desktop.test.ts`
exercise the helper without bypassing semantic availability or result assertions.

## 2026-09-28 — Electron 44.4.5 qualification (BST-1858)

The two strict WASM embedding/search cases failed after real embedding completed
four of four chunks. The hidden LLM host restart case passed separately. A control
on unchanged main `99bc2258e5040d0e361c0393584b7cdc71e94223`, using Electron
44.2.0, reproduced the search failure, establishing that it preceded the upgrade.

A temporary diagnostic on that control showed the requested collection had two
files, four chunks and four embeddings, with a clean rollup. The Workspace Index
had zero embeddings. Immediately after `selectWorkspaceSearchCollection`
returned, the search panel had no combobox: its live collection query had not yet
loaded. The helper mistook this transient state for the intentional single-set
presentation and returned without selecting the requested collection. The later
semantic gate correctly rejected the empty default Workspace Index.

The helper now uses Playwright's documented `expect.poll` to wait for either a
visible combobox or the exact requested quiet label. It then uses the original
selection path. The two previously failing cases pass on Electron 44.4.5 with
the original vector, rendered-result and stale-preference assertions. No forced
click, mode rewrite, stats fabrication, fixed sleep or production change is used.
Reference: [Playwright assertions](https://playwright.dev/docs/test-assertions#expectpoll).

The missing synthetic workspace path reported by Git diagnostics was not the
semantic-gate cause. The original failure reports/logs remain qualification
evidence; the blob reporter retained its event report but removed referenced
trace/screenshot resources, so those resources were not inspected.

This proves actual hidden-renderer WASM embedding/search and hidden-host restart;
it does not prove Gemma generation or WebGPU inference. Native-addon loading,
packaged MCP lanes and both desktop smoke jobs are separate acceptance checks.

## 2026-09-28 — Review tightens the readiness signal

Claude's initial review of `1e2de944cadbf3d57791893dfd85cf9a16a26873`
identified that unrelated matching panel text could satisfy the original poll.
A real Chromium probe calling the actual helper reproduced this: a matching
heading with pending collection rows made the helper resolve instead of reject.
The picker now exposes its quiet-state marker only when one live row exists;
zero-row placeholder text is not a ready state. The combobox has the accessible
name "Search collection". The helper scopes exact text to that loaded marker
and verifies its text before the no-click return. It does not use `.first()` to
hide duplicate selectors.

The paired `search-collection-picker.test.tsx` tests cover pending/loaded rows,
unrelated duplicate text, single-to-multiple and loaded-to-empty transitions.
Three positive cases failed before the marker/accessible name were added.
The focused Chromium helper probe additionally covers rejecting unrelated text
and accepting the real quiet label beside duplicate text and another combobox.
The initial temporary probe's loader/config failures were preserved separately;
the actual RED used the repository's canonical desktop E2E tsconfig.
References: [Playwright locators](https://playwright.dev/docs/locators#locate-by-test-id)
and [role names](https://playwright.dev/docs/locators#locate-by-role).
The full owner suite passed 172 tests; the two Chromium cases and all three
strict real Electron renderer cases passed after an uncached desktop build.
An initial owner typecheck caught a Playwright-only `exact` option in the
Testing Library role query; the documented `name` query fixes that test API
mismatch. Its failed log is preserved separately from the readiness RED.
See [Testing Library ByRole](https://testing-library.com/docs/queries/byrole/).

The private-partition `frame-src` regression rationale remains in
`ci-quality/packaged-mcp-lanes.md`; shortening the contract did not delete its
history or weaken the real-main-window rule.
