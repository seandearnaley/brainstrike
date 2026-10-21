# BST-2291: the catalog spec gave a first-run database boot a fixed 30 s

`apps/web/e2e/settings-models-and-providers.test.ts`, "paints one-line rows at a
36px pitch, windows them, and pins provider headers", failed its first attempt in
the 2026-10-21 nightly (run 39565910906, web full regression, broad pass with 2
workers on ubicloud-standard-4) and passed on retry. It failed at `:162`: no
`model-catalog-section-header-*` within 30 s.

## Defect density (2026-10-21, 14 days, base `e429945ab`)

Two of the exercised paths are HOT:

- `packages/app-state/src/stores/model-registry-store.ts` has 5 fix commits:
  #4027 (BST-2241), #3624, #3595, #3590 and #3588.
- `packages/settings-ui/src/settings/models` has 4: #4027, #4017 (BST-2230),
  #3595 and #3590.

They cover the download cache answer, the download realm, desktop PGlite
retirement, runtime failure messages, quit during reset and, in #3588, refetching
after a failed load. None of them changes when the registry first loads.
BST-2291 is the only nightly-alert issue on these paths. The spec has 2 fix
commits and is not hot.

## Evidence from the failed attempt's trace

The time is measured from the moment the Model Catalog category opened and the
30 s expect began.

| Time | Event |
| --- | --- |
| -2.7 s | The spec's `home.goto` navigated away from the beforeEach page. That page had requested the PGlite extension tarballs 5 ms earlier, so its database boot was abandoned. |
| -1.7 s | The new page's first-run bootstrap began. |
| +13.8 s | "First-run PGlite fast bootstrap completed", `durationMs: 15468`. |
| +14.1 s | The renderer's client fetched the extensions to open the store. |
| +24.8 s | The status bar changed from "Storage: Connecting…" to "PGlite WASM". In the same frame, Refresh became disabled: `fetchRegistry` had started. |
| +30.0 s | The expect failed. The page showed "Loading models…" and "0 models · 0 providers". Refresh was still disabled, so the read was 5.2 s in. |

The retry passed in 33.4 s. The same test passed in 12.2 s in the later
single-worker settings-state lane. The UI was not stuck: it moved forward the
whole time, slowed by the second worker's load.

## Mechanism (main)

1. The page shows "Loading models…" until the registry has loaded
   (`model-catalog.tsx:275-291`).
2. The load starts only when a consumer has a database. `useEnsureModelRegistry`
   skips a null `db` (`use-model-registry.ts:41`). `usePGliteDatabase` returns
   null until the provider's open finishes (`use-db.ts:109`).
3. On a fresh profile, the open runs the first-run bootstrap, then the client,
   the migration check and the pgvector probe (`pglite-direct-transport.ts:321-356`).
   After that, the registry runs two `SELECT`s through the database work
   scheduler, behind the rest of the app's startup reads
   (`model-registry-store.ts:307-342`).
4. The spec opts out of the database wait. It is read-only, so it follows the
   readiness contract. It then bounded all of steps 2 and 3 with a 30 s
   assertion. It also navigated again, which restarted the bootstrap that the
   beforeEach page had begun.

## Delay injection: no load, temporary seam

The temporary seam was never committed. It was a Playwright route that holds
each `/assets/vector.tar-*.gz` fetch for 12 s. A first-run boot fetches the
extension three times in sequence: the bootstrap worker's in-memory store, its
IndexedDB store, and the renderer's client. The database therefore connects at
least 36 s after its boot begins.

| Spec | Result |
| --- | --- |
| Main, no hold | pass |
| Main, 12 s hold | **4 of 4 fail at `:162`**. Each failure has the nightly's error and page: "Loading models…", 0 models, "Storage connecting". |
| Fixed, 12 s hold | 4 of 4 pass, in 38.0-38.1 s. The catalog renders once the hold ends. |

## Ruling and fix

This is a test defect. The catalog showed its loading state until its data
existed, and then rendered. The spec now:

- Joins the owner's acknowledgement. `joinModelRegistry`, a web E2E lifecycle
  hook installed before the first render, resolves when the registry store has
  loaded. It rejects with the store's error when the load fails.
- Asserts the header with the default expect, and drops the 30 s budget.
- Drops the second navigation. The beforeEach page is already fresh.

The fix adds no timer, retry or poll. The 60 s test timeout is the only bound
left.
