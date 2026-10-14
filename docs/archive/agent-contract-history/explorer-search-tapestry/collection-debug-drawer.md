# Collection details debug drawer — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "COLLECTION DETAILS DEBUG DRAWER".
Read before changing the Database panel's Collection details drawer or its Electron proofs.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '119,148p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

## COLLECTION DETAILS DEBUG DRAWER

The Database panel owns the collapsed-by-default Collection details drawer
(`packages/db-explorer/src/components/collection-debug-drawer`). Its lazy body
is the diagnostic surface for file/chunk inspection, scored retrieval preview,
and incomplete embedding coverage.

- The panel's `recordPagination` plus `onRecordPageChange` callback are the
  drawer's only file-page source. The Files pager must not read the Zustand
  store independently while its subtitle and rows render panel data.
- The retrieval preview must use `useSemanticSearchExecutor` and the active
  collection repositories. It is one-shot on explicit submit and surfaces
  unavailable executors and failures visibly; never replace it with a SQL-only
  or mock-only proof.
- The drawer stays unmounted while collapsed. Its 50k-file Electron proof opens
  only after retained-memory snapshots, measures click-to-settled latency through
  both the coverage live query and the incomplete-file rollup, and enforces the
  explicit 1500 ms ceiling separately from a generous Playwright locator timeout.
  That elapsed value is an upper bound because it includes renderer IPC round
  trips and locator polling. The import/embed Electron proof verifies retrieval
  is available before input, runs a real drawer query, and requires embedded
  fixture content in the scored result list.

Paired tests:
`packages/db-explorer/src/components/collection-debug-drawer/__tests__/collection-debug-drawer-content.test.tsx`,
`packages/db-explorer/src/components/collection-debug-drawer/__tests__/collection-debug-drawer.test.tsx`,
`apps/desktop/e2e/embedding-worker-renderer.backfill-search.desktop.test.ts`, and
`apps/desktop/e2e/embedding-worker-renderer.memory.desktop.test.ts`.

When changing this flow, update this section and the paired tests.
