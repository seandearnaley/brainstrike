# Electron collection readiness

Supports `ci-quality.md` § "Desktop Electron provisioning": wait for the collection
picker or the requested single-set label before selecting a collection in E2E.
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
